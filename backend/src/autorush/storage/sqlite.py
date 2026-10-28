"""SQLite persistence for versioned case, plan and run snapshots."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from uuid import UUID

from autorush.domain.models import CaseRecord, CaseStatus, PlanRecord, PlanStatus, RunRecord
from autorush.llm.models import ProviderConfigRecord


class SqliteStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS plans (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    plan_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_configs (
                    id TEXT PRIMARY KEY,
                    provider_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_executions (
                    id TEXT PRIMARY KEY,
                    idempotency_key TEXT UNIQUE NOT NULL,
                    payload TEXT NOT NULL
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def save_case(self, case: CaseRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO cases(id, status, payload) VALUES (?, ?, ?)",
                (str(case.id), case.status.value, case.model_dump_json()),
            )

    def get_case(self, case_id: UUID) -> CaseRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM cases WHERE id = ?", (str(case_id),)).fetchone()
        return CaseRecord.model_validate_json(row[0]) if row else None

    def list_cases(self,include_archived=False) -> list[CaseRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM cases ORDER BY rowid DESC").fetchall()
        cases=[CaseRecord.model_validate_json(row[0]) for row in rows]
        return cases if include_archived else [case for case in cases if case.archived_at is None]

    def replace_case(self,original:CaseRecord,updated:CaseRecord) -> bool:
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row=connection.execute('SELECT payload FROM cases WHERE id=?',(str(original.id),)).fetchone()
            if row is None or CaseRecord.model_validate_json(row[0])!=original:return False
            cursor=connection.execute('UPDATE cases SET status=?,payload=? WHERE id=?',
                (updated.status.value,updated.model_dump_json(),str(original.id)))
            return cursor.rowcount==1

    def set_case_status(self, case_id: UUID, status: CaseStatus) -> CaseRecord | None:
        case = self.get_case(case_id)
        if case is None:
            return None
        updated = case.model_copy(update={"status": status})
        if not self.replace_case(case,updated):raise ValueError('case changed before status update')
        return updated

    def save_plan(self, plan: PlanRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO plans(id, status, payload) VALUES (?, ?, ?)",
                (str(plan.id), plan.status.value, plan.model_dump_json()),
            )

    def get_plan(self, plan_id: UUID) -> PlanRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM plans WHERE id = ?", (str(plan_id),)).fetchone()
        return PlanRecord.model_validate_json(row[0]) if row else None

    def list_plans(self) -> list[PlanRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM plans ORDER BY rowid DESC").fetchall()
        return [PlanRecord.model_validate_json(row[0]) for row in rows]

    def set_plan_status(self, plan_id: UUID, status: PlanStatus, *, api_environment_snapshot_id=None) -> PlanRecord | None:
        plan = self.get_plan(plan_id)
        if plan is None:
            return None
        updates = {"status": status}
        if api_environment_snapshot_id is not None: updates['api_environment_snapshot_id'] = api_environment_snapshot_id
        updated = plan.model_copy(update=updates)
        with self._connect() as connection:
            connection.execute(
                "UPDATE plans SET status = ?, payload = ? WHERE id = ?",
                (status.value, updated.model_dump_json(), str(plan_id)),
            )
        return updated

    def save_run(self, run: RunRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO runs(id, plan_id, payload) VALUES (?, ?, ?)",
                (str(run.id), str(run.plan_id), run.model_dump_json()),
            )

    def get_run(self, run_id: UUID) -> RunRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM runs WHERE id = ?", (str(run_id),)).fetchone()
        return RunRecord.model_validate_json(row[0]) if row else None

    def list_runs(self) -> list[RunRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM runs ORDER BY rowid DESC").fetchall()
        return [RunRecord.model_validate_json(row[0]) for row in rows]

    def save_provider_config(self, config: ProviderConfigRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO provider_configs(id, provider_id, payload) VALUES (?, ?, ?)",
                (str(config.id), config.provider_id, config.model_dump_json()),
            )

    def get_provider_config(self, config_id: UUID) -> ProviderConfigRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM provider_configs WHERE id = ?", (str(config_id),)
            ).fetchone()
        return ProviderConfigRecord.model_validate_json(row[0]) if row else None

    def list_provider_configs(self) -> list[ProviderConfigRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM provider_configs ORDER BY rowid DESC").fetchall()
        return [ProviderConfigRecord.model_validate_json(row[0]) for row in rows]

    def set_provider_status(self, config_id: UUID, status: str) -> ProviderConfigRecord | None:
        config = self.get_provider_config(config_id)
        if config is None:
            return None
        updated = config.model_copy(update={"status": status})
        with self._connect() as connection:
            connection.execute(
                "UPDATE provider_configs SET payload = ? WHERE id = ?",
                (updated.model_dump_json(), str(config_id)),
            )
        return updated

    def set_provider_vision(self,config_id:UUID,verified:bool) -> ProviderConfigRecord | None:
        config=self.get_provider_config(config_id)
        if config is None: return None
        updated=config.model_copy(update={'vision_verified':verified})
        with self._connect() as connection:
            connection.execute('UPDATE provider_configs SET payload=? WHERE id=?',(updated.model_dump_json(),str(config_id)))
        return updated

    def save_agent_execution(self,record):
        with self._connect() as connection:
            connection.execute('INSERT INTO agent_executions(id,idempotency_key,payload) VALUES(?,?,?)',
                (str(record.id),str(record.idempotency_key),record.model_dump_json()))

    def update_agent_execution(self,record):
        with self._connect() as connection:
            connection.execute('UPDATE agent_executions SET payload=? WHERE id=?',(record.model_dump_json(),str(record.id)))

    def get_agent_execution(self,execution_id):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            row=connection.execute('SELECT payload FROM agent_executions WHERE id=?',(str(execution_id),)).fetchone()
        return AgentExecutionRecord.model_validate_json(row[0]) if row else None

    def find_agent_execution(self,key):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            row=connection.execute('SELECT payload FROM agent_executions WHERE idempotency_key=?',(str(key),)).fetchone()
        return AgentExecutionRecord.model_validate_json(row[0]) if row else None

    def list_agent_executions(self):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            rows=connection.execute('SELECT payload FROM agent_executions ORDER BY rowid DESC').fetchall()
        return [AgentExecutionRecord.model_validate_json(row[0]) for row in rows]
