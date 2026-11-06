"""Encrypted short-lived previews and durable, atomic import receipts."""
from contextlib import closing
import json
import time
from uuid import uuid4

from autorush.api_testing.store import ApiStore


class ImportStore:
    def __init__(self, path):
        self.api = ApiStore(path)
        with closing(self.api.connect()) as db, db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS case_import_previews (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at REAL NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS case_import_commits (
                    owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, import_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, file_sha256 TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(owner,idempotency_key), UNIQUE(owner,import_id));
                CREATE TABLE IF NOT EXISTS case_import_sources (
                    case_id TEXT PRIMARY KEY, import_id TEXT NOT NULL, payload TEXT NOT NULL);
            ''')

    def create_preview(self, owner, preview):
        ident = str(uuid4())
        expires_at = time.time() + 1800
        with closing(self.api.connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM case_import_previews WHERE expires_at<?', (time.time(),))
            if db.execute('SELECT COUNT(*) FROM case_import_previews').fetchone()[0] >= 50:
                raise ImportStoreError(429, '预览会话过多，请稍后重试。')
            db.execute('INSERT INTO case_import_previews VALUES(?,?,?,?)',
                       (ident, owner, expires_at, self.api.encode(preview.model_dump(mode='json'))))
        return ident, expires_at

    def get_preview(self, db, ident, owner):
        row = db.execute('SELECT expires_at,payload FROM case_import_previews WHERE id=? AND owner=?', (ident, owner)).fetchone()
        if row is None:
            raise ImportStoreError(404, '导入预览不存在，请重新选择文件。')
        if row[0] <= time.time():
            raise ImportStoreError(410, '导入预览已过期，请重新预览文件。')
        return row[0], self.api.decode(row[1])

    def duplicate_file(self, db, digest):
        return db.execute('SELECT 1 FROM case_import_commits WHERE file_sha256=? LIMIT 1', (digest,)).fetchone() is not None


class ImportStoreError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def receipt(row):
    return json.loads(row[0]) if row else None
