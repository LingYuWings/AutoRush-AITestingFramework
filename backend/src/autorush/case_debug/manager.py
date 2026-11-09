import hashlib
from uuid import uuid4
from fastapi import HTTPException
from autorush.agent.manager import AgentRunManager
from autorush.api_testing.nodes import freeze_case
from autorush.api_testing.variables import secret_strings
from autorush.evidence.redaction import redact_execution_payload
from autorush.case_debug.models import DebugRecord, debug_summary
from autorush.case_debug.preflight import check_debug
from autorush.case_debug.store import DebugStore
from autorush.domain.models import CaseRecord, PlanRecord, ResultStatus


# Run a case snapshot through the agent machinery using separate debug storage.
class DebugRunManager(AgentRunManager):
    # Attach debug storage while retaining the shared execution machinery.
    def __init__(self, settings, store, session_factory, client_factory, broker, device_hub):
        super().__init__(settings, DebugStore(store), session_factory, client_factory, broker, collect_live_output=False)
        self.device_hub = device_hub

    # Suppress formal plan events because debug progress is read from storage.
    async def emit(self, event_type, payload):
        # The debug panel reads durable progress; formal plan events/statistics stay separate.
        return None

    # Validate the source revision, freeze the current draft and schedule it once.
    async def start_debug(self, payload):
        fingerprint = hashlib.sha256(payload.model_dump_json(exclude={'idempotency_key'}).encode()).hexdigest()
        async with self.start_lock:
            old = self.store.find_agent_execution(payload.idempotency_key)
            if old:
                if old.request_hash != fingerprint: raise HTTPException(409, 'idempotency key belongs to different debug content')
                return old
            if self.store.has_active():
                raise HTTPException(409, 'another debug run is active; stop it or wait for completion')
            original = self.store.formal.get_case(payload.source_case_id) if payload.source_case_id else None
            if payload.source_case_id:
                if original is None: raise HTTPException(404, 'source case not found')
                if original.archived_at or original.version != payload.source_version:
                    raise HTTPException(409, 'source case changed or archived; reload before debugging')
            source = payload.case or original
            case = CaseRecord(**{key: value for key, value in source.model_dump().items()
                if key in {'title', 'description', 'execution_mode', 'platform', 'steps', 'postconditions'}},
                id=original.id if original else uuid4())
            case = freeze_case(case, self.store.vault)
            plan = PlanRecord(name='单用例调试', environment='调试', case_ids=[case.id],
                capture_screenshots=any(s.driver != 'api' for s in case.steps + case.postconditions), **payload.targets.model_dump())
            if plan.api_environment_id:
                environment = self.store.vault.get('environments', plan.api_environment_id)
                if environment is None: raise ValueError('API environment not found')
                plan.api_environment_snapshot_id = self.store.vault.create('environment_snapshots',
                    {'variables': environment['variables'], 'name': environment['name'], 'source_version': environment['version']})['id']
            check_debug(self.settings, self.store, plan, case, self.device_hub, self.store.vault)
            record = DebugRecord(plan_id=plan.id, idempotency_key=payload.idempotency_key, plan_snapshot=plan,
                case_snapshots=[case], request_hash=fingerprint, source_case_id=payload.source_case_id,
                source_version=payload.source_version, session_id=payload.session_id, unsaved=payload.case is not None)
            self.store.save_agent_execution(record)
            return self._schedule(record)

    # Persist the case result and terminal state in the debug record.
    async def finish(self, record, results, reason=None, *, interrupted=False):
        record.result = results[0] if results else None
        record.state = 'interrupted' if interrupted else 'finished'
        record.termination_reason = reason
        self.store.update_agent_execution(record)
        await self.emit('finished', {'run_id': str(record.id)})

    # Build a console view while redacting secrets from progress and evidence.
    def public(self, record, *, summary=False):
        data = debug_summary(record)
        if summary: return data
        data.update(progress=record.progress, result=record.result.model_dump(mode='json') if record.result else None,
            termination_reason=record.termination_reason)
        secrets = set()
        for case in record.case_snapshots:
            secrets.update(secret_strings(case.model_dump(mode='json')))
            for step in case.steps + case.postconditions:
                ident = step.parameters.get('request_snapshot_id')
                if ident: secrets.update(secret_strings(self.store.vault.get('request_snapshots', ident)))
        # Keep control metadata typed while masking payloads and traces.
        sanitized = redact_execution_payload(data, secrets, record.id)
        for key in ('id', 'state', 'source_case_id', 'source_version', 'session_id', 'unsaved', 'execution_mode', 'platform', 'created_at', 'status'):
            sanitized[key] = data[key]
        return sanitized
