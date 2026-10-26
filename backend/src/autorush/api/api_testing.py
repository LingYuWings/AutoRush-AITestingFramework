"""Local authenticated HTTP workbench endpoints."""
import asyncio
from copy import deepcopy
import json
from fastapi import APIRouter, Body, Header, HTTPException, Query, Request
from pydantic import ValidationError

from autorush.api_testing.models import ApiRequest, Collection, Environment, ExecuteRequest, CollectionRun
from autorush.api_testing.store import ApiStore
from autorush.api_testing.engine import ApiEngine
from autorush.api_testing.variables import ApiBlocked, variable_values


def create_api_testing_router(settings, require_operator, trusted_local_request):
    router = APIRouter(prefix='/api/v1/api-testing', tags=['API testing'])
    store = ApiStore(settings.database_path)
    schemas = {'collections': Collection, 'requests': ApiRequest, 'environments': Environment}

    def authorize(request, token):
        require_operator(token)
        if not trusted_local_request(request):
            raise HTTPException(403, 'API testing requires a trusted local operator')

    def parse_model(schema, payload):
        try:
            return schema.model_validate(payload)
        except ValidationError as exc:
            messages = ['.'.join(map(str, error['loc'])) + ': ' + error['msg']
                        for error in exc.errors(include_input=False)]
            raise HTTPException(422, '; '.join(messages)) from None

    def validate(kind, payload):
        if kind not in schemas:
            raise HTTPException(404, 'configuration type not found')
        value = parse_model(schemas[kind], payload).model_dump()
        if kind == 'requests' and value['collection_id'] and not store.get('collections', value['collection_id']):
            raise HTTPException(422, 'collection not found')
        return value

    def runtime_variables(spec, environment_id, overrides):
        items = []
        if spec.collection_id:
            collection = store.get('collections', spec.collection_id)
            if collection is None: raise HTTPException(404, 'collection not found')
            items.extend(collection['variables'])
        if environment_id:
            environment = store.get('environments', environment_id)
            if environment is None: raise HTTPException(404, 'environment not found')
            items.extend(environment['variables'])
        values, secrets = variable_values(items)
        return {**values, **overrides}, secrets

    def save_result(value, request_id=None):
        value = {**value, 'request_id': request_id}
        stored = deepcopy(value)
        response = stored.get('response')
        if response:
            body_text = json.dumps(response['body'], ensure_ascii=False) if not isinstance(response['body'], str) else response['body']
            if len(body_text.encode()) > 65536:
                response['body'] = body_text.encode()[:65536].decode(errors='ignore')
                response['history_truncated'] = True
            response['text'] = response['text'].encode()[:65536].decode(errors='ignore')
        record = store.save_history(stored)
        return {**value, 'id': record['id'], 'created_at': record['created_at']}

    async def until_disconnect(request, operation):
        task = asyncio.create_task(operation)
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=.1)
                if done: return task.result()
                if await request.is_disconnected(): raise HTTPException(499, 'request cancelled')
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    @router.post('/execute')
    async def execute(request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        command = parse_model(ExecuteRequest, payload)
        async def perform():
            try:
                values, secrets = runtime_variables(command.request, command.environment_id, command.variables)
                engine = ApiEngine(settings.allowed_api_hosts, variables=values, secret_values=secrets)
                result = (await engine.execute(command.request)).public
            except ApiBlocked as exc:
                result = {'name': command.request.name, 'method': command.request.method, 'url': command.request.url,
                    'status': 'blocked', 'detail': str(exc), 'response': None, 'assertions': [], 'extracted': {}, 'elapsed_ms': 0}
            return save_result(result, command.request_id)
        return await until_disconnect(request, perform())

    @router.post('/collections/{collection_id}/run')
    async def run_collection(collection_id: str, request: Request, payload: dict = Body(default={}),
        x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        command = parse_model(CollectionRun, payload)
        if store.get('collections', collection_id) is None: raise HTTPException(404, 'collection not found')
        requests = [item for item in store.list('requests') if item['collection_id'] == collection_id]
        if not requests or len(requests) > 100: raise HTTPException(422, 'collection requires 1..100 requests')
        async def perform():
            from autorush.api_testing.models import configuration
            try:
                values, secrets = runtime_variables(ApiRequest(collection_id=collection_id), command.environment_id, command.variables)
            except ApiBlocked as exc:
                return {'status': 'blocked', 'results': [], 'detail': str(exc)}
            engine = ApiEngine(settings.allowed_api_hosts, variables=values, secret_values=secrets)
            results, stopped = [], False
            async with asyncio.timeout(180):
                for item in requests:
                    if stopped:
                        results.append({'request_id': item['id'], 'name': item['name'], 'status': 'skipped'})
                        continue
                    result = await engine.execute(ApiRequest.model_validate(configuration(item)))
                    results.append(save_result(result.public, item['id']))
                    stopped = command.stop_on_failure and result.public['status'] != 'passed'
            status = next((status for status in ['error', 'failed', 'blocked'] if any(item['status'] == status for item in results)), 'passed')
            return {'status': status, 'results': results}
        return await until_disconnect(request, perform())

    @router.post('/import')
    def import_data(request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        from autorush.api_testing.interchange import import_curl, import_postman, variables
        kind, content = payload.get('format'), payload.get('content')
        if len(json.dumps(content, ensure_ascii=False).encode()) > 2097152:
            raise HTTPException(422, 'import exceeds 2 MiB')
        try:
            if kind == 'curl':
                spec = import_curl(content)
                collection, specs, warnings = {'name': 'Imported cURL'}, [spec], []
            else:
                content = json.loads(content) if isinstance(content, str) else content
                if kind == 'postman_environment':
                    environment = Environment.model_validate({'name': content.get('name', 'Imported environment'),
                        'variables': variables(content.get('values', []))})
                    saved = store.create('environments', environment.model_dump())
                    return {'collections': [], 'requests': [], 'environments': [saved], 'warnings': []}
                if kind != 'postman_collection': raise ValueError('unsupported import format')
                collection, specs, warnings = import_postman(content)
            validated_collection = Collection.model_validate(collection).model_dump()
            validated_specs = [ApiRequest.model_validate(spec).model_dump() for spec in specs]
        except (ValueError, TypeError, KeyError, AttributeError):
            raise HTTPException(422, 'invalid or unsupported import; only data-only cURL, Postman v2.1 and environment JSON are accepted') from None
        saved_collection = store.create('collections', validated_collection)
        saved_requests = [store.create('requests', {**spec, 'collection_id': saved_collection['id']}) for spec in validated_specs]
        return {'collections': [saved_collection], 'requests': saved_requests, 'environments': [], 'warnings': warnings}

    @router.post('/export')
    def export_data(request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        from autorush.api_testing.interchange import export_curl, export_postman
        from autorush.api_testing.models import configuration
        kind = payload.get('format')
        try:
            if kind == 'curl':
                if payload.get('request_id'):
                    record = store.get('requests', payload['request_id'])
                    if record is None: raise HTTPException(404, 'request not found')
                    spec = configuration(record)
                else: spec = parse_model(ApiRequest, payload.get('request', {})).model_dump()
                return {'format': kind, 'filename': 'request.curl.txt', 'content': export_curl(spec)}
            if kind == 'postman_collection':
                collection = store.get('collections', payload.get('collection_id'))
                if collection is None: raise HTTPException(404, 'collection not found')
                content = export_postman(collection, [item for item in store.list('requests') if item['collection_id'] == collection['id']])
            elif kind == 'postman_environment':
                environment = store.get('environments', payload.get('environment_id'))
                if environment is None: raise HTTPException(404, 'environment not found')
                content = {'name': environment['name'], '_postman_variable_scope': 'environment', 'values': [
                    {'key': item['key'], 'value': '' if item['secret'] else item['value'],
                     'type': 'secret' if item['secret'] else 'default', 'enabled': item['enabled']} for item in environment['variables']]}
            else: raise HTTPException(422, 'unsupported export format')
            return {'format': kind, 'filename': kind + '.json', 'content': json.dumps(content, ensure_ascii=False, indent=2)}
        except (ValueError, TypeError, KeyError):
            raise HTTPException(422, 'request cannot be represented by this export format; use Postman collection export for form data and files') from None

    @router.get('/capabilities')
    def capabilities(request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return {'methods': ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
            'body_modes': ['none', 'json', 'raw', 'urlencoded', 'formdata', 'binary'],
            'allowed_hosts': sorted(settings.allowed_api_hosts), 'max_response_bytes': 1048576,
            'history_limit': 200, 'javascript_scripts': False}

    @router.get('/history')
    def history(request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return store.history()

    @router.get('/history/{history_id}')
    def history_detail(history_id: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        value = store.history(history_id)
        if value is None:
            raise HTTPException(404, 'history not found')
        return value

    @router.get('/{kind}')
    def list_records(kind: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        if kind not in schemas:
            raise HTTPException(404, 'configuration type not found')
        return store.list(kind)

    @router.post('/{kind}', status_code=201)
    def create_record(kind: str, request: Request, payload: dict = Body(...), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        return store.create(kind, validate(kind, payload))

    @router.get('/{kind}/{record_id}')
    def get_record(kind: str, record_id: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        value = store.get(kind, record_id) if kind in schemas else None
        if value is None:
            raise HTTPException(404, 'configuration not found')
        return value

    @router.put('/{kind}/{record_id}')
    def update_record(kind: str, record_id: str, request: Request, payload: dict = Body(...),
        expected_version: int = Query(ge=1), x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        value = validate(kind, payload)
        try:
            return store.update(kind, record_id, value, expected_version)
        except KeyError:
            raise HTTPException(404, 'configuration not found') from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @router.delete('/{kind}/{record_id}')
    def delete_record(kind: str, record_id: str, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        authorize(request, x_autorush_operator_token)
        if kind == 'collections' and any(record['collection_id'] == record_id for record in store.list('requests')):
            raise HTTPException(409, 'move or delete requests before deleting this collection')
        if kind not in schemas or not store.delete(kind, record_id):
            raise HTTPException(404, 'configuration not found')
        return {'deleted': True}

    return router
