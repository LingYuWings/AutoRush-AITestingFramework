"""SQLite persistence for versioned case, plan and run snapshots."""

from __future__ import annotations

import sqlite3
from contextlib import closing, nullcontext
from pathlib import Path
from uuid import UUID

from autorush.domain.models import CaseRecord, CaseStatus, PlanRecord, RunRecord
from autorush.llm.models import ProviderConfigRecord


# Persist formal cases, plans, model configurations and execution records.
class SqliteStore:
    # Create the core database tables if they do not exist.
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

    # Open a SQLite connection to the configured project database.
    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    # Insert a case revision with its indexed review state.
    def save_case(self, case: CaseRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO cases(id, status, payload) VALUES (?, ?, ?)",
                (str(case.id), case.status.value, case.model_dump_json()),
            )

    # Load the full case revision by ID.
    def get_case(self, case_id: UUID) -> CaseRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM cases WHERE id = ?", (str(case_id),)).fetchone()
        return CaseRecord.model_validate_json(row[0]) if row else None

    # List stored cases and optionally include archived revisions.
    def list_cases(self,include_archived=False) -> list[CaseRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM cases ORDER BY rowid DESC").fetchall()
        cases=[CaseRecord.model_validate_json(row[0]) for row in rows]
        return cases if include_archived else [case for case in cases if case.archived_at is None]

    # Replace a case only if its previously read payload still matches.
    def replace_case(self,original:CaseRecord,updated:CaseRecord) -> bool:
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row=connection.execute('SELECT payload FROM cases WHERE id=?',(str(original.id),)).fetchone()
            if row is None or CaseRecord.model_validate_json(row[0])!=original:return False
            cursor=connection.execute('UPDATE cases SET status=?,payload=? WHERE id=?',
                (updated.status.value,updated.model_dump_json(),str(original.id)))
            return cursor.rowcount==1

    # Persist the requested case review state.
    def set_case_status(self, case_id: UUID, status: CaseStatus) -> CaseRecord | None:
        case = self.get_case(case_id)
        if case is None:
            return None
        updated = case.model_copy(update={"status": status})
        if not self.replace_case(case,updated):raise ValueError('case changed before status update')
        return updated

    # Insert a plan with its indexed readiness state.
    def save_plan(self, plan: PlanRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO plans(id, status, payload) VALUES (?, ?, ?)",
                (str(plan.id), plan.status.value, plan.model_dump_json()),
            )

    # Load the saved plan and its target configuration.
    def get_plan(self, plan_id: UUID) -> PlanRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM plans WHERE id = ?", (str(plan_id),)).fetchone()
        return PlanRecord.model_validate_json(row[0]) if row else None

    # Return the saved plans for the management console.
    def list_plans(self) -> list[PlanRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM plans ORDER BY rowid DESC").fetchall()
        return [PlanRecord.model_validate_json(row[0]) for row in rows]

    # Replace only the plan state the caller read, including legacy payloads.
    def replace_plan(self, original: PlanRecord, updated: PlanRecord, *, connection: sqlite3.Connection | None = None) -> bool:
        owned = connection is None
        with (closing(self._connect()) if owned else nullcontext(connection)) as db:
            with (db if owned else nullcontext()):
                row = db.execute("SELECT payload FROM plans WHERE id = ?", (str(original.id),)).fetchone()
                if row is None or PlanRecord.model_validate_json(row[0]) != original:
                    return False
                cursor = db.execute(
                    "UPDATE plans SET status = ?, payload = ? WHERE id = ? AND payload = ?",
                    (updated.status.value, updated.model_dump_json(), str(original.id), row[0]),
                )
                return cursor.rowcount == 1

    # Insert the completed run with its persisted report paths.
    def save_run(self, run: RunRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO runs(id, plan_id, payload) VALUES (?, ?, ?)",
                (str(run.id), str(run.plan_id), run.model_dump_json()),
            )

    # Load a run result by its execution ID.
    def get_run(self, run_id: UUID) -> RunRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT payload FROM runs WHERE id = ?", (str(run_id),)).fetchone()
        return RunRecord.model_validate_json(row[0]) if row else None

    # List persisted run results in reverse insertion order.
    def list_runs(self) -> list[RunRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM runs ORDER BY rowid DESC").fetchall()
        return [RunRecord.model_validate_json(row[0]) for row in rows]

    # Insert a provider configuration for subsequent connection checks.
    def save_provider_config(self, config: ProviderConfigRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO provider_configs(id, provider_id, payload) VALUES (?, ?, ?)",
                (str(config.id), config.provider_id, config.model_dump_json()),
            )

    # Resolve one provider configuration by ID.
    def get_provider_config(self, config_id: UUID) -> ProviderConfigRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM provider_configs WHERE id = ?", (str(config_id),)
            ).fetchone()
        return ProviderConfigRecord.model_validate_json(row[0]) if row else None

    # List saved provider configurations for model settings.
    def list_provider_configs(self) -> list[ProviderConfigRecord]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM provider_configs ORDER BY rowid DESC").fetchall()
        return [ProviderConfigRecord.model_validate_json(row[0]) for row in rows]

    # Persist the latest verification state for a provider configuration.
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

    # Update the result of the provider's image-input capability check.
    def set_provider_vision(self,config_id:UUID,verified:bool) -> ProviderConfigRecord | None:
        config=self.get_provider_config(config_id)
        if config is None: return None
        updated=config.model_copy(update={'vision_verified':verified})
        with self._connect() as connection:
            connection.execute('UPDATE provider_configs SET payload=? WHERE id=?',(updated.model_dump_json(),str(config_id)))
        return updated

    # Persist a new execution snapshot and its retry key.
    def save_agent_execution(self,record):
        with self._connect() as connection:
            connection.execute('INSERT INTO agent_executions(id,idempotency_key,payload) VALUES(?,?,?)',
                (str(record.id),str(record.idempotency_key),record.model_dump_json()))

    # Checkpoint progress or terminal state for an existing execution.
    def update_agent_execution(self,record):
        with self._connect() as connection:
            connection.execute('UPDATE agent_executions SET payload=? WHERE id=?',(record.model_dump_json(),str(record.id)))

    # Load one agent execution and its persisted checkpoint.
    def get_agent_execution(self,execution_id):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            row=connection.execute('SELECT payload FROM agent_executions WHERE id=?',(str(execution_id),)).fetchone()
        return AgentExecutionRecord.model_validate_json(row[0]) if row else None

    # Resolve an idempotency key to the previously scheduled execution.
    def find_agent_execution(self,key):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            row=connection.execute('SELECT payload FROM agent_executions WHERE idempotency_key=?',(str(key),)).fetchone()
        return AgentExecutionRecord.model_validate_json(row[0]) if row else None

    # Load persisted executions for recovery and recent-run views.
    def list_agent_executions(self):
        from autorush.agent.executions import AgentExecutionRecord
        with self._connect() as connection:
            rows=connection.execute('SELECT payload FROM agent_executions ORDER BY rowid DESC').fetchall()
        return [AgentExecutionRecord.model_validate_json(row[0]) for row in rows]
