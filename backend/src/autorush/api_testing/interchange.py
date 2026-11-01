"""Data-only Postman v2.1 and cURL exchange. Imported commands are never executed."""
from __future__ import annotations
from copy import deepcopy
import json
import shlex
from uuid import uuid4
from urllib.parse import parse_qsl, quote_plus, urlencode, urlsplit, urlunsplit

from autorush.api_testing.models import ApiRequest
from autorush.api_testing.variables import PLACEHOLDER, SENSITIVE, redact, secret_strings

SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'


def variables(items):
    return [{'key': str(item['key']), 'value': item.get('value', ''),
        'enabled': item.get('enabled', not item.get('disabled', False)),
        'secret': item.get('type') == 'secret' or bool(SENSITIVE.search(str(item['key'])))} for item in items if item.get('key')]


def pairs(items):
    return [{'key': str(item.get('key', '')), 'value': str(item.get('value', '')),
             'enabled': not item.get('disabled', False)} for item in items]


def from_auth(auth):
    kind = auth.get('type', 'noauth')
    if kind == 'noauth': return {'type': 'none'}
    if kind not in {'basic', 'bearer', 'apikey'}: raise ValueError('unsupported Postman authorization: ' + kind)
    values = {item['key']: str(item.get('value', '')) for item in auth.get(kind, [])}
    if kind == 'basic': return {'type': 'basic', 'username': values.get('username', ''), 'password': values.get('password', '')}
    if kind == 'bearer': return {'type': 'bearer', 'token': values.get('token', '')}
    return {'type': 'api_key', 'key': values.get('key', 'X-API-Key'), 'value': values.get('value', ''),
            'location': values.get('in', 'header')}


def import_postman(content, *, preserve_tree=False):
    if not isinstance(content, dict) or not str(content.get('info', {}).get('schema', '')).endswith('/v2.1.0/collection.json'):
        raise ValueError('only Postman Collection v2.1 JSON is supported')
    requests, warnings, folders = [], [], []
    def visit(items, inherited_auth, inherited_scripts=False, prefix='', parent_id=None, depth=0):
        if depth > 8: raise ValueError('folder depth cannot exceed 8')
        for position, item in enumerate(items):
            scripts = inherited_scripts or bool(item.get('event'))
            if 'item' in item:
                folder_id = str(uuid4())
                if preserve_tree:
                    folders.append({'id': folder_id, 'collection_id': '', 'parent_id': parent_id,
                        'name': str(item.get('name', 'Folder')), 'description': '', 'position': position})
                    if len(folders) > 1000: raise ValueError('import supports at most 1000 folders')
                visit(item['item'], item.get('auth', inherited_auth), scripts,
                    '' if preserve_tree else prefix + str(item.get('name', '')) + ' / ', folder_id, depth + 1)
                continue
            raw = item.get('request', {})
            if isinstance(raw, str): raw = {'url': raw}
            url = raw.get('url', '')
            url_vars = variables(url.get('variable', [])) if isinstance(url, dict) else []
            query = pairs(url.get('query', [])) if isinstance(url, dict) else []
            url_text = url.get('raw', '') if isinstance(url, dict) else url
            if query: url_text = url_text.split('?', 1)[0]
            for variable in url_vars: url_text = url_text.replace(':' + variable['key'], '{{' + variable['key'] + '}}')
            compatibility = ['Postman JavaScript scripts were not imported; convert checks or explicitly accept HTTP-only execution'] if scripts else []
            body = raw.get('body', {})
            mode = body.get('mode', 'none')
            converted = {'mode': 'none'}
            if mode == 'raw': converted = {'mode': 'json' if body.get('options', {}).get('raw', {}).get('language') == 'json' else 'raw', 'text': body.get('raw', '')}
            elif mode in {'urlencoded', 'formdata'}:
                fields = []
                for field in body.get(mode, []):
                    if field.get('type') == 'file':
                        compatibility.append('referenced local file must be selected again: ' + str(field.get('key', '')))
                        fields.append({'key': field['key'], 'type': 'file', 'enabled': False})
                    else: fields.append({'key': field['key'], 'value': str(field.get('value', '')), 'enabled': not field.get('disabled', False)})
                converted = {'mode': mode, 'fields': fields}
            elif mode not in {'none', ''}: compatibility.append('unsupported body mode: ' + mode)
            own = raw.get('x-autorush', {})
            if own.get('version') == 1:
                own_spec = ApiRequest.model_validate(own['request'])
                spec = ApiRequest.model_validate({**own_spec.model_dump(), 'collection_id': None,
                    'name': prefix + str(item.get('name', own_spec.name)), 'method': raw.get('method', 'GET').upper(),
                    'url': url_text, 'query': query, 'headers': pairs(raw.get('header', [])),
                    'auth': from_auth(raw.get('auth', inherited_auth) or {}), 'body': converted,
                    'compatibility_warnings': list(dict.fromkeys([*own_spec.compatibility_warnings, *compatibility]))})
            else:
                try:
                    spec = ApiRequest.model_validate({'name': prefix + str(item.get('name', 'Imported request')),
                        'method': raw.get('method', 'GET').upper(), 'url': url_text, 'query': query,
                        'headers': pairs(raw.get('header', [])), 'auth': from_auth(raw.get('auth', inherited_auth) or {}),
                        'body': converted, 'variables': url_vars, 'compatibility_warnings': compatibility})
                except (ValueError, TypeError) as exc:
                    warnings.append(prefix + str(item.get('name', 'request')) + ': unsupported request configuration')
                    continue
            converted_spec = spec.model_dump()
            if preserve_tree: converted_spec.update(folder_id=parent_id, position=position)
            requests.append(converted_spec)
            warnings.extend(spec.name + ': ' + note for note in spec.compatibility_warnings)
            if len(requests) > 100: raise ValueError('import supports at most 100 requests')
    visit(content.get('item', []), content.get('auth'), bool(content.get('event')))
    if not requests: raise ValueError('collection has no supported HTTP requests')
    result = ({'name': str(content['info'].get('name', 'Imported collection')),
        'description': '', 'variables': variables(content.get('variable', []))}, requests, warnings)
    return (*result, folders) if preserve_tree else result


def import_curl(command):
    tokens = shlex.split(command.replace('\\\r\n', '').replace('\\\n', '').replace('^\r\n', ''))
    if not tokens or tokens.pop(0).lower() not in {'curl', 'curl.exe'}: raise ValueError('expected a cURL command')
    spec, body, explicit_method = {'name': 'Imported cURL', 'headers': [], 'query': []}, None, False
    get_data = False
    index = 0
    value_options = {'-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
        '--data-urlencode', '-u', '--user', '--url', '--max-time'}
    while index < len(tokens):
        token = tokens[index]; index += 1
        if token in value_options:
            if index == len(tokens): raise ValueError('cURL option is missing its value')
            value = tokens[index]; index += 1
            if token in {'-X', '--request'}: spec['method'] = value.upper(); explicit_method = True
            elif token in {'-H', '--header'}:
                key, separator, val = value.partition(':')
                if not separator: raise ValueError('invalid cURL header')
                spec['headers'].append({'key': key.strip(), 'value': val.strip()})
            elif token in {'-u', '--user'}:
                username, _, password = value.partition(':'); spec['auth'] = {'type': 'basic', 'username': username, 'password': password}
            elif token == '--url':
                if 'url' in spec: raise ValueError('only one cURL URL is supported')
                spec['url'] = value
            elif token == '--max-time': spec['timeout_ms'] = int(float(value) * 1000)
            elif token == '--data-urlencode':
                if '@' in value.split('=', 1)[0]: raise ValueError('cURL local file references are not read')
                key, separator, val = value.partition('=')
                encoded = key + '=' + quote_plus(val) if separator else quote_plus(key)
                body = encoded if body is None else body + '&' + encoded
            else:
                if value.startswith('@'): raise ValueError('cURL local file references are not read')
                body = value if body is None else body + '&' + value
        elif token in {'-L', '--location'}: spec['follow_redirects'] = True
        elif token in {'-I', '--head'}: spec['method'] = 'HEAD'; explicit_method = True
        elif token in {'-G', '--get'}: get_data = True
        elif token in {'--compressed', '-s', '--silent', '--show-error', '-S'}: pass
        elif token.startswith(('http://', 'https://', '{{')) and 'url' not in spec: spec['url'] = token
        else: raise ValueError('unsupported cURL option or shell syntax')
    if not spec.get('url'): raise ValueError('cURL URL is required')
    if body is not None and get_data:
        spec['query'].extend({'key': key, 'value': value} for key, value in parse_qsl(body, keep_blank_values=True))
        body = None
    if body is not None:
        json_type = any(header['key'].lower() == 'content-type' and 'json' in header['value'] for header in spec['headers'])
        content_type = next((header['value'] for header in spec['headers'] if header['key'].lower() == 'content-type'), 'application/x-www-form-urlencoded')
        spec['body'] = {'mode': 'json' if json_type else 'raw', 'text': body, 'content_type': content_type}
        if not explicit_method: spec['method'] = 'POST'
    return ApiRequest.model_validate(spec).model_dump()


def export_safe(spec):
    value = deepcopy(spec)
    secrets = set()
    for key in ['password', 'token', 'value']:
        actual = spec.get('auth', {}).get(key)
        if actual and not PLACEHOLDER.fullmatch(str(actual)): secrets.add(str(actual))
    for item in spec.get('variables', []):
        if item.get('secret') or SENSITIVE.search(item['key']): secrets.update(secret_strings({'secret': item['value']}))
    value['url'] = redact(value.get('url', ''))
    auth = value.get('auth', {})
    for key in ['password', 'token', 'value']:
        actual = str(auth.get(key, ''))
        if actual and not PLACEHOLDER.fullmatch(actual) and not actual.startswith('env:'): auth[key] = '[redacted]'
    for kind in ['headers', 'query']:
        for item in value.get(kind, []):
            if SENSITIVE.search(item['key']) and not PLACEHOLDER.fullmatch(item['value']): item['value'] = '[redacted]'
    for item in value.get('variables', []):
        if item.get('secret') or SENSITIVE.search(item['key']): item['value'] = ''
    body = value.get('body', {})
    for field in body.get('fields', []):
        if SENSITIVE.search(field['key']) and not PLACEHOLDER.fullmatch(field['value']): field['value'] = '[redacted]'
        else: field['value'] = redact(field['value'], secrets)
    if body.get('mode') == 'raw': body['text'] = redact(body.get('text', ''), secrets)
    if body.get('mode') == 'json':
        try: body['text'] = json.dumps(redact(json.loads(body['text']), secrets), ensure_ascii=False)
        except ValueError: pass
    return value


def export_postman(collection, requests, folders=None):
    items = []
    for record in requests:
        spec = export_safe(record)
        for field in ['id', 'version', 'created_at', 'updated_at']: spec.pop(field, None)
        auth = spec['auth']; kind = {'none': 'noauth', 'api_key': 'apikey'}.get(auth['type'], auth['type'])
        auth_items = {'basic': [('username', auth['username']), ('password', auth['password'])],
            'bearer': [('token', auth['token'])], 'api_key': [('key', auth['key']), ('value', auth['value']), ('in', auth['location'])]}.get(auth['type'], [])
        request = {'method': spec['method'], 'url': {'raw': spec['url'], 'query': [
            {'key': item['key'], 'value': item['value'], 'disabled': not item['enabled']} for item in spec['query']]},
            'header': [{'key': item['key'], 'value': item['value'], 'disabled': not item['enabled']} for item in spec['headers']],
            'auth': {'type': kind, **({kind: [{'key': key, 'value': val, 'type': 'string'} for key, val in auth_items]} if auth_items else {})},
            'x-autorush': {'version': 1, 'request': spec}}
        body = spec['body']
        if body['mode'] in {'json', 'raw'}:
            request['body'] = {'mode': 'raw', 'raw': body['text'], 'options': {'raw': {'language': 'json' if body['mode'] == 'json' else 'text'}}}
        elif body['mode'] in {'urlencoded', 'formdata'}:
            request['body'] = {'mode': body['mode'], body['mode']: [
                {'key': field['key'], 'value': field['value'], 'type': field['type'], 'disabled': not field['enabled']} for field in body['fields']]}
        elif body['mode'] == 'binary':
            request['body'] = {'mode': 'file', 'file': {'src': body['filename']}}
        items.append({'name': spec['name'], 'request': request})
    if folders is not None:
        request_items = [(record, item) for record, item in zip(requests, items)]
        def children(parent_id):
            entries = [(record, item) for record, item in request_items if record.get('folder_id') == parent_id]
            entries.extend((folder, {'name': folder['name'], 'item': children(folder['id'])})
                for folder in folders if folder.get('parent_id') == parent_id)
            entries.sort(key=lambda pair: (pair[0].get('position', 0), pair[0].get('created_at', '')))
            return [item for _, item in entries]
        items = children(None)
    return {'info': {'name': collection['name'], 'schema': SCHEMA}, 'item': items,
        'variable': [{'key': item['key'], 'value': '' if item.get('secret') or SENSITIVE.search(item['key']) else item['value'], 'disabled': not item.get('enabled', True)}
            for item in collection.get('variables', [])]}


def export_curl(request):
    spec = export_safe(request)
    parts = urlsplit(spec['url'])
    query = parse_qsl(parts.query, keep_blank_values=True) + [(item['key'], item['value']) for item in spec['query'] if item['enabled']]
    auth = spec['auth']
    if auth['type'] == 'api_key' and auth['location'] == 'query':
        query = [(key, value) for key, value in query if key != auth['key']] + [(auth['key'], auth['value'])]
    url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, safe='{}'), parts.fragment))
    tokens = ['curl', '-X', spec['method'], url]
    for item in spec['headers']:
        if item['enabled']: tokens.extend(['-H', item['key'] + ': ' + item['value']])
    if auth['type'] == 'basic': tokens.extend(['-u', auth['username'] + ':' + auth['password']])
    elif auth['type'] == 'bearer': tokens.extend(['-H', 'Authorization: Bearer ' + auth['token']])
    elif auth['type'] == 'api_key':
        if auth['location'] == 'header': tokens.extend(['-H', auth['key'] + ': ' + auth['value']])
    if spec['body']['mode'] in {'json', 'raw'}:
        if spec['body']['mode'] == 'json': tokens.extend(['-H', 'Content-Type: application/json'])
        elif not any(item['enabled'] and item['key'].lower() == 'content-type' for item in spec['headers']):
            tokens.extend(['-H', 'Content-Type: ' + spec['body']['content_type']])
        tokens.extend(['--data-raw', spec['body']['text']])
    elif spec['body']['mode'] == 'urlencoded':
        tokens.extend(['-H', 'Content-Type: application/x-www-form-urlencoded', '--data-raw',
            urlencode([(field['key'], field['value']) for field in spec['body']['fields'] if field['enabled']])])
    elif spec['body']['mode'] != 'none': raise ValueError('use Postman export for uploads or form bodies')
    if spec['follow_redirects']: tokens.append('-L')
    return shlex.join(tokens)
