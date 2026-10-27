"""Versioned local configurations encrypted at rest; bounded, redacted history."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4

from cryptography.fernet import Fernet


class ApiStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        key_path = self.path.with_name('api-testing-vault.key')
        try:
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, 'wb') as file:
                file.write(Fernet.generate_key())
        self.cipher = Fernet(key_path.read_bytes())
        with self.connect() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS api_testing_records (
                    kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
                    payload TEXT NOT NULL, PRIMARY KEY(kind,id));
                CREATE TABLE IF NOT EXISTS api_testing_history (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
            ''')

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def encode(self, value):
        return self.cipher.encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()

    def decode(self, value):
        return json.loads(self.cipher.decrypt(value.encode()))

    def get(self, kind, record_id):
        with self.connect() as connection:
            row = connection.execute('SELECT payload FROM api_testing_records WHERE kind=? AND id=?',
                (kind, str(record_id))).fetchone()
        return self.decode(row[0]) if row else None

    def list(self, kind):
        with self.connect() as connection:
            rows = connection.execute('SELECT payload FROM api_testing_records WHERE kind=? ORDER BY rowid',
                (kind,)).fetchall()
        return [self.decode(row[0]) for row in rows]

    def create(self, kind, value):
        now = datetime.now(timezone.utc).isoformat()
        record = {**value, 'id': str(uuid4()), 'version': 1, 'created_at': now, 'updated_at': now}
        with self.connect() as connection:
            connection.execute('INSERT INTO api_testing_records(kind,id,version,payload) VALUES(?,?,?,?)',
                (kind, record['id'], 1, self.encode(record)))
        return record

    def update(self, kind, record_id, value, expected_version):
        with self.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT version,payload FROM api_testing_records WHERE kind=? AND id=?',
                (kind, str(record_id))).fetchone()
            if row is None:
                raise KeyError('configuration not found')
            if row[0] != expected_version:
                raise ValueError('configuration version changed; reload before saving')
            previous = self.decode(row[1])
            record = {**value, 'id': str(record_id), 'version': expected_version + 1,
                'created_at': previous['created_at'], 'updated_at': datetime.now(timezone.utc).isoformat()}
            connection.execute('UPDATE api_testing_records SET version=?,payload=? WHERE kind=? AND id=?',
                (record['version'], self.encode(record), kind, str(record_id)))
        return record

    def delete(self, kind, record_id):
        with self.connect() as connection:
            cursor = connection.execute('DELETE FROM api_testing_records WHERE kind=? AND id=?', (kind, str(record_id)))
        return cursor.rowcount > 0

    def save_history(self, value, replay=None):
        record = {**value, 'id': str(uuid4()), 'created_at': datetime.now(timezone.utc).isoformat()}
        if replay is not None: record['_replay'] = replay
        with self.connect() as connection:
            connection.execute('INSERT INTO api_testing_history(id,created_at,payload) VALUES(?,?,?)',
                (record['id'], record['created_at'], self.encode(record)))
            connection.execute('DELETE FROM api_testing_history WHERE id NOT IN '
                '(SELECT id FROM api_testing_history ORDER BY rowid DESC LIMIT 200)')
        return record

    def history(self, record_id=None):
        with self.connect() as connection:
            if record_id:
                row = connection.execute('SELECT payload FROM api_testing_history WHERE id=?', (str(record_id),)).fetchone()
                if not row: return None
                record = self.decode(row[0]); record.pop('_replay', None)
                return record
            rows = connection.execute('SELECT payload FROM api_testing_history ORDER BY rowid DESC LIMIT 200').fetchall()
        records = [self.decode(row[0]) for row in rows]
        return [{key: value for key, value in record.items() if key not in {'response', 'request', 'extracted', '_replay'}} for record in records]

    def history_replay(self, record_id):
        with self.connect() as connection:
            row = connection.execute('SELECT payload FROM api_testing_history WHERE id=?', (str(record_id),)).fetchone()
        return self.decode(row[0]).get('_replay') if row else None
