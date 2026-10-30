"""Trusted-local asynchronous collection Runner routes."""
import html
import json
from xml.etree.ElementTree import Element, SubElement, tostring
from fastapi import APIRouter, Body, Header, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import ValidationError
from autorush.api_testing.runner_models import RunCommand
from autorush.api_testing.tree import TreeError


def create_runner_router(manager, authorize):
    router = APIRouter(prefix='/runner', tags=['API Runner'])

    def require(run_id):
        value = manager.store.get(run_id)
        if value is None: raise HTTPException(404, 'run not found')
        return value

    async def mutation(callback):
        try: return await callback()
        except TreeError as exc: raise HTTPException(exc.status, str(exc)) from None
        except ValueError as exc: raise HTTPException(422, str(exc)) from None

    @router.post('/runs', status_code=202)
    async def start(request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        try: command = RunCommand.model_validate(payload)
        except ValidationError as exc:
            raise HTTPException(422, '; '.join('.'.join(map(str, item['loc'])) + ': ' + item['msg']
                for item in exc.errors(include_input=False))) from None
        return await mutation(lambda: manager.start(command))

    @router.get('/runs')
    def listing(request: Request, search: str = Query(default='', max_length=200), status: str | None = None,
        offset: int = Query(default=0, ge=0), limit: int = Query(default=20, ge=1, le=100),
        x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return manager.store.summaries(search, status, offset, limit)

    @router.get('/runs/{run_id}')
    def get(run_id: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return require(run_id)

    @router.get('/runs/{run_id}/steps')
    def steps(run_id: str, request: Request, offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100),
        x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        require(run_id)
        return manager.store.steps(run_id, offset, limit)

    @router.get('/runs/{run_id}/steps/{seq}')
    def detail(run_id: str, seq: int, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        require(run_id)
        value = manager.store.detail(run_id, seq)
        if value is None: raise HTTPException(404, 'request result not found')
        return value

    @router.post('/runs/{run_id}/cancel')
    async def cancel(run_id: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return await mutation(lambda: manager.cancel(run_id))

    @router.post('/runs/{run_id}/rerun', status_code=202)
    async def rerun(run_id: str, request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        key = payload.get('idempotency_key')
        if not isinstance(key, str) or not 8 <= len(key) <= 100: raise HTTPException(422, 'idempotency_key requires 8..100 characters')
        return await mutation(lambda: manager.rerun(run_id, key))

    @router.get('/runs/{run_id}/export')
    def export(run_id: str, request: Request, format: str = 'json', x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        snapshot = manager.store.export_snapshot(run_id)
        if snapshot is None: raise HTTPException(404, 'run not found')
        run, steps = snapshot
        if format == 'json':
            content, media, suffix = json.dumps({'run': run, 'steps': steps}, ensure_ascii=False, indent=2), 'application/json', 'json'
        elif format == 'html':
            content = '<!doctype html><meta charset="utf-8"><title>API Runner</title><h1>' + html.escape(run['name']) + '</h1><pre>'
            content += html.escape(json.dumps({'run': run, 'steps': steps}, ensure_ascii=False, indent=2)) + '</pre>'
            media, suffix = 'text/html', 'html'
        elif format == 'junit':
            root = Element('testsuite', name=run['name'], tests=str(len(steps) + bool(run['counts']['skipped'])))
            for step in steps:
                case = SubElement(root, 'testcase', name=f"iteration {step['iteration']}: {step['name']}", time=str(step['elapsed_ms']/1000))
                if step['status'] != 'passed':
                    tag = {'failed': 'failure', 'error': 'error'}.get(step['status'], 'skipped')
                    SubElement(case, tag, message=step.get('detail', '')).text = json.dumps(step.get('assertions', []), ensure_ascii=False)
            if run['counts']['skipped']:
                SubElement(SubElement(root, 'testcase', name='Unexecuted requests'), 'skipped', message=str(run['counts']['skipped']))
            content, media, suffix = tostring(root, encoding='unicode'), 'application/xml', 'xml'
        else: raise HTTPException(422, 'export format must be json, html or junit')
        return Response(content, media_type=media, headers={'Content-Disposition': f'attachment; filename="api-run-{run_id}.{suffix}"'})

    return router
