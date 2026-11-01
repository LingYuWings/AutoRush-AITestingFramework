"""Immutable encrypted request snapshots and case-local runtime substitution."""
from copy import deepcopy
from autorush.api_testing.models import ApiRequest, Variable
from autorush.api_testing.variables import ApiBlocked, substitute


def create_snapshot(store, spec, source_id=None, source_version=None, inherited_variables=None):
    spec = ApiRequest.model_validate(spec)
    collection = store.get('collections', spec.collection_id) if spec.collection_id else None
    if spec.collection_id and collection is None: raise ValueError('API collection not found')
    return store.create('request_snapshots', {'request': spec.model_copy(update={'collection_id': None, 'folder_id': None, 'position': 0}).model_dump(),
        'collection_variables': deepcopy(collection['variables']) if collection else [Variable.model_validate(item).model_dump() for item in (inherited_variables or [])],
        'source_request_id': source_id, 'source_version': source_version})


def snapshot_parameters(record):
    return {'request_snapshot_id': record['id'], 'request_name': record['request']['name'],
        'request_method': record['request']['method'], 'source_request_id': record.get('source_request_id'),
        'source_version': record.get('source_version')}


def freeze_case(case, store):
    def freeze(step):
        if step.driver != 'api': return step
        if 'request' in step.parameters:
            record = create_snapshot(store, step.parameters['request'], step.parameters.get('source_request_id'),
                step.parameters.get('source_version'), step.parameters.get('collection_variables'))
            return step.model_copy(update={'parameters': snapshot_parameters(record)})
        if step.parameters.get('request_snapshot_id') and store.get('request_snapshots', step.parameters['request_snapshot_id']) is None:
            raise ValueError('API request snapshot not found')
        return step
    return case.model_copy(update={'steps': [freeze(step) for step in case.steps],
        'postconditions': [freeze(step) for step in case.postconditions]})


def request_snapshot(step, store):
    snapshot_id = step.parameters.get('request_snapshot_id')
    if snapshot_id:
        record = store.get('request_snapshots', snapshot_id) if store else None
        if record is None: raise ApiBlocked('API request snapshot not found')
        return ApiRequest.model_validate(record['request']), record.get('collection_variables', [])
    if 'request' in step.parameters: return ApiRequest.model_validate(step.parameters['request']), []
    return None, []


def needs_base_url(step, store):
    spec, _ = request_snapshot(step, store)
    return spec is None or spec.url.startswith('/')


def resolve_ui_step(step, drivers, *, model_context=False):
    variables = getattr(drivers.get('api'), 'runtime_variables', {})
    if not variables and '{{' not in str(step.parameters) + step.intent + (step.expected_result or ''): return step
    value = step.model_dump()
    value['intent'] = str(substitute(value['intent'], variables))
    if value['expected_result']: value['expected_result'] = str(substitute(value['expected_result'], variables))
    if model_context:
        instructions = value['intent'] + (value['expected_result'] or '')
        secrets = getattr(drivers.get('api'), 'runtime_secrets', ())
        if any(secret and str(secret) in instructions for secret in secrets):
            raise ApiBlocked('sensitive API values cannot be included in model instructions')
    value['parameters'] = substitute(value['parameters'], variables)
    value['assertions'] = substitute(value['assertions'], variables)
    for key in ['text', 'value']:
        if key in value['parameters'] and not isinstance(value['parameters'][key], str): value['parameters'][key] = str(value['parameters'][key])
    return step.model_validate(value)
