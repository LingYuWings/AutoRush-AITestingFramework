"""Local-operator upload, review and idempotent batch commit endpoints."""
import json
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .mapping import strict_json
from .models import ImportLimits, ImportOptions, ImportParseError
from .service import ImportCommit, ImportService, owner_key
from .store import ImportStoreError


# Expose template, preview, validation and commit endpoints.
def create_import_router(settings, require_operator, trusted_local_request):
    router = APIRouter(prefix='/api/v1/case-imports')
    service = ImportService(settings.database_path)

    # Require a trusted local operator for every import operation.
    def authorize(request, token):
        require_operator(token)
        if not trusted_local_request(request):
            raise HTTPException(403, '导入需要本机控制台授权。')

    # Wrap a request so streaming input is counted against a size limit.
    def limited(request, maximum):
        total = 0
        # Reject a request body as soon as it crosses the upload limit.
        async def receive():
            nonlocal total
            message = await request.receive()
            total += len(message.get('body', b''))
            if total > maximum:
                raise HTTPException(413, '导入请求超过大小限制。')
            return message
        return Request(request.scope, receive=receive)

    # Decode bounded JSON for validation and commit requests.
    async def body(request):
        try:
            value = await limited(request, 20 * 1024 * 1024).body()
            return ImportCommit.model_validate(strict_json(value.decode('utf-8')))
        except (ValueError, UnicodeError, RecursionError, ValidationError):
            raise HTTPException(422, '导入提交参数无效，请检查选择项和会话。') from None

    # Run blocking import work off the event loop and map import errors.
    async def execute(operation, *args):
        try:
            return await run_in_threadpool(operation, *args)
        except ImportStoreError as error:
            raise HTTPException(error.status, str(error)) from None

    # Return the packaged Markdown template for download.
    @router.get('/template')
    def template(request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        # Keep the downloadable asset in the Python package for installed backends.
        from importlib.resources import files
        content = files('autorush.case_imports').joinpath('template.markdown').read_bytes()
        return Response(content, media_type='text/markdown', headers={'Content-Disposition':'attachment; filename="autorush-cases.md"'})

    # Read a bounded upload and create a browser-scoped import preview.
    @router.post('/preview')
    async def preview(request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        try:
            async with limited(request, 11 * 1024 * 1024).form(max_files=1, max_fields=3, max_part_size=65536) as form:
                if set(form) - {'file','options','session_id'} or any(len(form.getlist(key)) != 1 for key in form):
                    raise ValueError('unexpected form fields')
                file = form.get('file')
                if not isinstance(file, UploadFile):
                    raise ValueError('file required')
                session = UUID(str(form.get('session_id', '')))
                options = ImportOptions.model_validate(strict_json(str(form.get('options', '{}'))))
                content = await file.read(ImportLimits().max_file_bytes + 1)
                name = file.filename or ''
                return await execute(service.preview, content, name, options, owner_key(session))
        except ImportParseError as error:
            raise HTTPException(413 if error.code.endswith('_limit') else 422, str(error)) from None
        except (ValueError, UnicodeError, ValidationError, RecursionError):
            raise HTTPException(422, '文件、导入选项或会话无效。') from None

    # Recover a browser-scoped preview or a completed import receipt.
    @router.get('/{ident}')
    async def get(ident: UUID, session_id: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return await execute(service.get, str(ident), owner_key(session_id))

    # Revalidate the edited candidates without creating cases.
    @router.post('/{ident}/validate')
    async def validate(ident: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        payload = await body(request)
        return await execute(service.validate, str(ident), owner_key(payload.session_id), payload)

    # Create the selected drafts atomically or return an existing receipt.
    @router.post('/{ident}/commit')
    async def commit(ident: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        payload = await body(request)
        result, reused = await execute(service.commit, str(ident), owner_key(payload.session_id), payload)
        return Response(json.dumps(result), status_code=200 if reused else 201, media_type='application/json')

    return router
