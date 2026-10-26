"""Local authenticated HTTP workbench endpoints."""
from fastapi import APIRouter, Body, Header, HTTPException, Query, Request
from pydantic import ValidationError

from autorush.api_testing.models import ApiRequest, Collection, Environment
from autorush.api_testing.store import ApiStore


def create_api_testing_router(settings, require_operator, trusted_local_request):
    router = APIRouter(prefix='/api/v1/api-testing', tags=['API testing'])
    store = ApiStore(settings.database_path)
    schemas = {'collections': Collection, 'requests': ApiRequest, 'environments': Environment}

    def authorize(request, token):
        require_operator(token)
        if not trusted_local_request(request):
            raise HTTPException(403, 'API testing requires a trusted local operator')

    def validate(kind, payload):
        if kind not in schemas:
            raise HTTPException(404, 'configuration type not found')
        try:
            value = schemas[kind].model_validate(payload).model_dump()
        except ValidationError as exc:
            messages = ['.'.join(map(str, error['loc'])) + ': ' + error['msg']
                        for error in exc.errors(include_input=False)]
            raise HTTPException(422, '; '.join(messages)) from None
        if kind == 'requests' and value['collection_id'] and not store.get('collections', value['collection_id']):
            raise HTTPException(422, 'collection not found')
        return value

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
