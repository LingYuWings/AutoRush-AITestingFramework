"""Transactional collection tree mutations and stable execution order."""
from datetime import datetime, timezone
from uuid import uuid4


class TreeError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


class TreeService:
    def __init__(self, store): self.store = store

    def records(self, connection):
        rows = connection.execute("SELECT kind,id,payload FROM api_testing_records WHERE kind IN ('collections','folders','requests') ORDER BY rowid").fetchall()
        return {(kind, record_id): self.store.decode(payload) for kind, record_id, payload in rows}

    @staticmethod
    def validate(records):
        for (kind, record_id), value in records.items():
            if kind not in {'folders', 'requests'}: continue
            collection = value.get('collection_id')
            if collection and ('collections', collection) not in records: raise TreeError('collection not found')
            if kind == 'requests':
                parent = value.get('folder_id')
                if parent:
                    folder = records.get(('folders', parent))
                    if folder is None or folder['collection_id'] != collection:
                        raise TreeError('request folder must belong to its collection')
                continue
            if not collection: raise TreeError('folder requires a collection')
            seen, current, depth = {record_id}, value, 1
            while current.get('parent_id'):
                parent = current['parent_id']
                if parent in seen: raise TreeError('folder move would create a cycle', 409)
                seen.add(parent)
                current = records.get(('folders', parent))
                if current is None or current['collection_id'] != collection:
                    raise TreeError('folder parent must belong to its collection')
                depth += 1
                if depth > 8: raise TreeError('folder depth cannot exceed 8')

    def persist(self, connection, kind, value, *, insert=False):
        if insert:
            connection.execute('INSERT INTO api_testing_records(kind,id,version,payload) VALUES(?,?,?,?)',
                (kind, value['id'], value['version'], self.store.encode(value)))
        else:
            connection.execute('UPDATE api_testing_records SET version=?,payload=? WHERE kind=? AND id=?',
                (value['version'], self.store.encode(value), kind, value['id']))

    def write(self, kind, value, record_id=None, expected_version=None):
        with self.store.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            records = self.records(connection)
            previous = records.get((kind, record_id)) if record_id else None
            if record_id and previous is None: raise TreeError('configuration not found', 404)
            if previous and previous['version'] != expected_version: raise TreeError('configuration version changed; reload before saving', 409)
            if kind == 'folders' and previous and previous['collection_id'] != value['collection_id']:
                raise TreeError('folders cannot move between collections')
            now = datetime.now(timezone.utc).isoformat()
            record = {**value, 'id': record_id or str(uuid4()), 'version': previous['version'] + 1 if previous else 1,
                'created_at': previous['created_at'] if previous else now, 'updated_at': now}
            records[(kind, record['id'])] = record
            self.validate(records)
            self.persist(connection, kind, record, insert=previous is None)
        return record

    def delete(self, kind, record_id):
        with self.store.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            records = self.records(connection)
            if (kind, record_id) not in records: raise TreeError('configuration not found', 404)
            if kind == 'folders':
                count = sum(value.get('folder_id' if child_kind == 'requests' else 'parent_id') == record_id
                    for (child_kind, _), value in records.items() if child_kind in {'folders', 'requests'})
            elif kind == 'collections':
                count = sum(value.get('collection_id') == record_id for (child_kind, _), value in records.items() if child_kind in {'folders', 'requests'})
            else: count = 0
            if count: raise TreeError(f'configuration contains {count} children; move or delete them first', 409)
            connection.execute('DELETE FROM api_testing_records WHERE kind=? AND id=?', (kind, record_id))

    @staticmethod
    def siblings(records, collection_id, parent_id):
        return sorted([(kind, value) for (kind, _), value in records.items()
            if kind in {'folders', 'requests'} and value.get('collection_id') == collection_id
            and value.get('parent_id' if kind == 'folders' else 'folder_id') == parent_id], key=lambda item: item[1].get('position', 0))

    def reorder(self, collection_id, parent_id, items):
        with self.store.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            records = self.records(connection)
            if ('collections', collection_id) not in records: raise TreeError('collection not found', 404)
            if parent_id and records.get(('folders', parent_id), {}).get('collection_id') != collection_id:
                raise TreeError('parent folder not found in collection')
            siblings = self.siblings(records, collection_id, parent_id)
            requested = [(item['kind'], item['id']) for item in items]
            if len(set(requested)) != len(requested) or set(requested) != {(kind, value['id']) for kind, value in siblings}:
                raise TreeError('reordering requires every immediate child exactly once')
            for item in items:
                if records[(item['kind'], item['id'])]['version'] != item['version']:
                    raise TreeError('tree version changed; reload before reordering', 409)
            result = []
            now = datetime.now(timezone.utc).isoformat()
            for position, item in enumerate(items):
                record = {**records[(item['kind'], item['id'])], 'position': position,
                    'version': item['version'] + 1, 'updated_at': now}
                self.persist(connection, item['kind'], record)
                result.append({**record, 'kind': item['kind']})
        return {'items': result}

    def ordered_requests(self, collection_id, folder_id=None):
        with self.store.connect() as connection: records = self.records(connection)
        if ('collections', collection_id) not in records: raise TreeError('collection not found', 404)
        if folder_id and records.get(('folders', folder_id), {}).get('collection_id') != collection_id:
            raise TreeError('folder not found in collection', 404)
        result = []
        def visit(parent):
            for kind, value in self.siblings(records, collection_id, parent):
                if kind == 'folders': visit(value['id'])
                else: result.append(value)
        visit(folder_id)
        return result

    def import_collection(self, collection, requests, folders):
        now = datetime.now(timezone.utc).isoformat()
        def record(value): return {**value, 'id': str(uuid4()), 'version': 1, 'created_at': now, 'updated_at': now}
        saved = record(collection)
        mapping = {folder['id']: str(uuid4()) for folder in folders}
        folder_records = [{**record({key: value for key, value in folder.items() if key != 'id'}),
            'id': mapping[folder['id']], 'collection_id': saved['id'], 'parent_id': mapping.get(folder.get('parent_id'))} for folder in folders]
        request_records = [record({**value, 'collection_id': saved['id'], 'folder_id': mapping.get(value.get('folder_id'))}) for value in requests]
        with self.store.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            records = self.records(connection)
            records[('collections', saved['id'])] = saved
            for kind, values in [('folders', folder_records), ('requests', request_records)]:
                for value in values: records[(kind, value['id'])] = value
            self.validate(records)
            self.persist(connection, 'collections', saved, insert=True)
            for kind, values in [('folders', folder_records), ('requests', request_records)]:
                for value in values: self.persist(connection, kind, value, insert=True)
        return {'collections': [saved], 'requests': request_records, 'folders': folder_records, 'environments': []}
