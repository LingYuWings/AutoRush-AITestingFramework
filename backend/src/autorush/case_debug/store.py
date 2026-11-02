"""Encrypted details and independent, indexed encrypted summaries for debug tasks."""
from contextlib import contextmanager, closing
from autorush.api_testing.store import ApiStore
from autorush.case_debug.models import DebugRecord, debug_summary


class DebugStore:
    def __init__(self, store):
        self.formal = store
        self.vault = ApiStore(store.path)
        with self._connect() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS case_debug_runs (
                    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS case_debug_summaries (
                    id TEXT PRIMARY KEY, state TEXT NOT NULL, source_case_id TEXT,
                    session_id TEXT, summary TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS case_debug_summary_state ON case_debug_summaries(state);
                CREATE INDEX IF NOT EXISTS case_debug_summary_source ON case_debug_summaries(source_case_id);
                CREATE INDEX IF NOT EXISTS case_debug_summary_session ON case_debug_summaries(session_id);
            ''')
            # Backfill one old detail at a time without rewriting its encrypted payload.
            for (payload,) in connection.execute('SELECT r.payload FROM case_debug_runs r '
                'LEFT JOIN case_debug_summaries s ON r.id=s.id WHERE s.id IS NULL ORDER BY r.rowid'):
                self._save_summary(connection, DebugRecord.model_validate(self.vault.decode(payload)))

    @contextmanager
    def _connect(self):
        with closing(self.vault.connect()) as connection, connection:
            yield connection

    def _save_summary(self, connection, record):
        value = debug_summary(record)
        connection.execute('INSERT INTO case_debug_summaries(id,state,source_case_id,session_id,summary) '
            'VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, '
            'source_case_id=excluded.source_case_id,session_id=excluded.session_id,summary=excluded.summary',
            (value['id'],value['state'],value['source_case_id'],value['session_id'],self.vault.encode(value)))

    def get_provider_config(self, ident):
        return self.formal.get_provider_config(ident)

    def save_agent_execution(self, record):
        with self._connect() as connection:
            connection.execute('INSERT INTO case_debug_runs(id,idempotency_key,payload) VALUES(?,?,?)',
                (str(record.id), str(record.idempotency_key), self.vault.encode(record.model_dump(mode='json'))))
            self._save_summary(connection, record)

    def update_agent_execution(self, record):
        with self._connect() as connection:
            cursor = connection.execute('UPDATE case_debug_runs SET payload=? WHERE id=?',
                (self.vault.encode(record.model_dump(mode='json')), str(record.id)))
            if cursor.rowcount != 1: raise ValueError('debug run not found')
            self._save_summary(connection, record)

    def get_agent_execution(self, ident):
        with self._connect() as connection:
            row = connection.execute('SELECT payload FROM case_debug_runs WHERE id=?', (str(ident),)).fetchone()
        return DebugRecord.model_validate(self.vault.decode(row[0])) if row else None

    def find_agent_execution(self, key):
        with self._connect() as connection:
            row = connection.execute('SELECT payload FROM case_debug_runs WHERE idempotency_key=?', (str(key),)).fetchone()
        return DebugRecord.model_validate(self.vault.decode(row[0])) if row else None

    def has_active(self):
        with self._connect() as connection:
            return connection.execute("SELECT 1 FROM case_debug_summaries WHERE state IN ('running','stopping') LIMIT 1").fetchone() is not None

    def list_agent_executions(self):
        """AgentRunManager's restart adapter only needs unfinished debug executions."""
        with self._connect() as connection:
            rows = connection.execute('SELECT r.payload FROM case_debug_summaries s '
                "JOIN case_debug_runs r ON r.id=s.id WHERE s.state IN ('running','stopping') ORDER BY s.rowid DESC").fetchall()
        return [DebugRecord.model_validate(self.vault.decode(row[0])) for row in rows]

    def list_recent_summaries(self, *, source_case_id=None, session_id=None, active_only=False):
        conditions, values = [], []
        if source_case_id is not None:
            conditions.append('source_case_id=?'); values.append(str(source_case_id))
        if session_id is not None:
            conditions.append('session_id=?'); values.append(str(session_id))
        if active_only: conditions.append("state IN ('running','stopping')")
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        with self._connect() as connection:
            rows = connection.execute('SELECT summary FROM case_debug_summaries'+where+' ORDER BY rowid DESC LIMIT 20', values).fetchall()
        return [self.vault.decode(row[0]) for row in rows]
