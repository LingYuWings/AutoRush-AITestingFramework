"""Encrypted durable Runner metadata, private snapshots and paginated evidence."""
from datetime import datetime, timezone
from uuid import uuid4


def now(): return datetime.now(timezone.utc).isoformat()


class ApiRunStore:
    def __init__(self, vault):
        self.vault = vault
        with vault.connect() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS api_runner_runs (
                    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, snapshot TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS api_runner_steps (
                    run_id TEXT NOT NULL, seq INTEGER NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(run_id,seq));
            ''')

    def create(self, source, snapshot, idempotency_key):
        record = {'id': str(uuid4()), 'name': source['collection_name'], 'state': 'queued', 'status': None,
            'created_at': now(), 'started_at': None, 'finished_at': None, 'completed': 0,
            'total': len(snapshot['requests']) * len(snapshot['rows']), 'current_iteration': None,
            'current_request': None, 'detail': '', 'elapsed_ms': 0, 'source': source,
            'counts': {key: 0 for key in ['passed', 'failed', 'error', 'blocked', 'skipped']}, 'retained_bytes': 0}
        with self.vault.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('INSERT INTO api_runner_runs VALUES(?,?,?,?,?,?)',
                (record['id'], idempotency_key, record['state'], record['created_at'], self.vault.encode(record), self.vault.encode(snapshot)))
            stale = connection.execute("SELECT id FROM api_runner_runs WHERE state NOT IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT -1 OFFSET 99").fetchall()
            for (run_id,) in stale:
                connection.execute('DELETE FROM api_runner_steps WHERE run_id=?', (run_id,))
                connection.execute('DELETE FROM api_runner_runs WHERE id=?', (run_id,))
        return record

    def get(self, run_id):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT payload FROM api_runner_runs WHERE id=?', (run_id,)).fetchone()
        return self.vault.decode(row[0]) if row else None

    def find(self, key):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT payload FROM api_runner_runs WHERE idempotency_key=?', (key,)).fetchone()
        return self.vault.decode(row[0]) if row else None

    def snapshot(self, run_id):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT snapshot FROM api_runner_runs WHERE id=?', (run_id,)).fetchone()
        return self.vault.decode(row[0]) if row else None

    def save(self, record):
        with self.vault.connect() as connection:
            connection.execute('UPDATE api_runner_runs SET state=?,payload=? WHERE id=?',
                (record['state'], self.vault.encode(record), record['id']))

    def summaries(self, search='', status=None, offset=0, limit=20):
        with self.vault.connect() as connection:
            rows = connection.execute('SELECT payload FROM api_runner_runs ORDER BY created_at DESC').fetchall()
        values = [self.vault.decode(row[0]) for row in rows]
        values = [value for value in values if (not status or value['status'] == status or value['state'] == status)
            and search.lower() in (' '.join([value['id'], value['name'], value['detail']])).lower()]
        return {'items': values[offset:offset+limit], 'total': len(values), 'offset': offset, 'limit': limit}

    def append(self, run_id, seq, result, *, progress=None):
        summary = {key: value for key, value in result.items() if key not in {'request', 'response', 'extracted'}}
        with self.vault.connect() as connection:
            connection.execute('INSERT INTO api_runner_steps VALUES(?,?,?,?)',
                (run_id, seq, self.vault.encode(summary), self.vault.encode(result)))
            if progress is not None:
                connection.execute('UPDATE api_runner_runs SET state=?,payload=? WHERE id=?',
                    (progress['state'], self.vault.encode(progress), run_id))

    def steps(self, run_id, offset=0, limit=50):
        with self.vault.connect() as connection:
            total = connection.execute('SELECT COUNT(*) FROM api_runner_steps WHERE run_id=?', (run_id,)).fetchone()[0]
            rows = connection.execute('SELECT summary FROM api_runner_steps WHERE run_id=? ORDER BY seq LIMIT ? OFFSET ?', (run_id, limit, offset)).fetchall()
        return {'items': [self.vault.decode(row[0]) for row in rows], 'total': total, 'offset': offset, 'limit': limit}

    def detail(self, run_id, seq):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT payload FROM api_runner_steps WHERE run_id=? AND seq=?', (run_id, seq)).fetchone()
        return self.vault.decode(row[0]) if row else None

    def details(self, run_id):
        with self.vault.connect() as connection:
            rows = connection.execute('SELECT payload FROM api_runner_steps WHERE run_id=? ORDER BY seq', (run_id,)).fetchall()
        return [self.vault.decode(row[0]) for row in rows]

    def export_snapshot(self, run_id):
        """Read progress and evidence from the same committed database snapshot."""
        with self.vault.connect() as connection:
            connection.execute('BEGIN')
            run = connection.execute('SELECT payload FROM api_runner_runs WHERE id=?', (run_id,)).fetchone()
            if run is None: return None
            rows = connection.execute('SELECT payload FROM api_runner_steps WHERE run_id=? ORDER BY seq', (run_id,)).fetchall()
        return self.vault.decode(run[0]), [self.vault.decode(row[0]) for row in rows]
