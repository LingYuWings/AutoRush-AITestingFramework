"""Dedicated encrypted task payloads; the formal case/plan/run tables are untouched."""
from autorush.api_testing.store import ApiStore
from autorush.case_debug.models import DebugRecord


class DebugStore:
    def __init__(self, store):
        self.formal = store
        self.vault = ApiStore(store.path)
        with self.vault.connect() as connection:
            connection.execute('CREATE TABLE IF NOT EXISTS case_debug_runs ('
                'id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)')

    def get_provider_config(self, ident):
        return self.formal.get_provider_config(ident)

    def save_agent_execution(self, record):
        with self.vault.connect() as connection:
            connection.execute('INSERT INTO case_debug_runs VALUES(?,?,?)',
                (str(record.id), str(record.idempotency_key), self.vault.encode(record.model_dump(mode='json'))))

    def update_agent_execution(self, record):
        with self.vault.connect() as connection:
            connection.execute('UPDATE case_debug_runs SET payload=? WHERE id=?',
                (self.vault.encode(record.model_dump(mode='json')), str(record.id)))

    def get_agent_execution(self, ident):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT payload FROM case_debug_runs WHERE id=?', (str(ident),)).fetchone()
        return DebugRecord.model_validate(self.vault.decode(row[0])) if row else None

    def find_agent_execution(self, key):
        with self.vault.connect() as connection:
            row = connection.execute('SELECT payload FROM case_debug_runs WHERE idempotency_key=?', (str(key),)).fetchone()
        return DebugRecord.model_validate(self.vault.decode(row[0])) if row else None

    def list_agent_executions(self):
        with self.vault.connect() as connection:
            rows = connection.execute('SELECT payload FROM case_debug_runs ORDER BY rowid DESC').fetchall()
        return [DebugRecord.model_validate(self.vault.decode(row[0])) for row in rows]
