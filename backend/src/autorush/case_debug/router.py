import hashlib
from uuid import UUID
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from autorush.case_debug.models import DebugStart
from autorush.domain.models import CaseResult
from autorush.evidence.agent_trace import iter_step_screenshots
from autorush.evidence.screenshot import evidence_path


def create_debug_router(manager, settings, require_operator, trusted_local_request):
    router = APIRouter(prefix='/api/v1/case-debug-runs')
    def authorize(request, token):
        require_operator(token)
        if not trusted_local_request(request): raise HTTPException(403, 'debug requires a trusted local operator')

    @router.post('', status_code=202)
    async def start(payload: DebugStart, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        try: return manager.public(await manager.start_debug(payload))
        except (ValueError, PermissionError): raise HTTPException(422, 'invalid debug content, target, environment or model configuration') from None

    @router.get('')
    async def recent(request: Request, source_case_id: UUID | None = None, session_id: UUID | None = None, active_only: bool = False,
                     x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return manager.store.list_recent_summaries(source_case_id=source_case_id,session_id=session_id,active_only=active_only)

    def find(ident):
        record = manager.get(ident)
        if record is None: raise HTTPException(404, 'debug run not found')
        return record

    @router.get('/{ident}')
    async def detail(ident: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return manager.public(find(ident))

    @router.post('/{ident}/cancel')
    async def cancel(ident: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        find(ident)
        return manager.public(await manager.cancel(ident))

    @router.get('/{ident}/evidence/{filename}')
    async def screenshot(ident: UUID, filename: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        record = find(ident)
        cases = [record.result] if record.result else manager.interrupted_results(record,
            [CaseResult.model_validate(c) for c in record.progress.get('completed_cases', [])], 'live debug evidence')
        relative = f'{ident}/{filename}'
        metadata = next((meta for case in cases for step in case.steps for meta in iter_step_screenshots(step.evidence)
            if meta.get('file') == relative), None)
        if metadata is None: raise HTTPException(404, 'debug evidence not found')
        try:
            path = evidence_path(settings.report_dir, ident, relative)
            with path.open('rb') as source: jpeg = source.read(1_000_001)
        except (OSError, ValueError): raise HTTPException(404, 'debug evidence not found') from None
        if len(jpeg) > 1_000_000 or len(jpeg) != metadata.get('bytes') or hashlib.sha256(jpeg).hexdigest() != metadata.get('sha256'):
            raise HTTPException(409, 'debug evidence checksum mismatch')
        return Response(jpeg, media_type='image/jpeg', headers={'Cache-Control': 'no-store'})
    return router
