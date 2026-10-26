"""One bounded HTTP implementation for standalone requests and test-case nodes."""
from __future__ import annotations
import asyncio
import base64
from dataclasses import dataclass
import json
import time
from urllib.parse import urljoin, urlsplit

import httpx

from autorush.api_testing.models import ApiRequest
from autorush.api_testing.variables import ApiBlocked, SENSITIVE, json_field, redact, substitute, variable_values

MAX_RESPONSE = 1048576
MAX_REQUEST = 1048576
FORBIDDEN_HEADERS = {'host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization', 'upgrade'}


@dataclass
class ApiExecution:
    public: dict
    output: dict
    checks: list[tuple[bool, str]]


def validate_url(url, allowed_hosts):
    try:
        parsed = urlsplit(url)
        _ = parsed.port
    except ValueError:
        raise ApiBlocked('invalid HTTP URL') from None
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
        raise ApiBlocked('URL must be absolute HTTP(S), without user information')
    if parsed.fragment or '\\' in url or any(ord(char) < 32 for char in url):
        raise ApiBlocked('URL cannot contain a fragment, backslash or control characters')
    if parsed.hostname.lower() not in {host.lower() for host in allowed_hosts}:
        raise ApiBlocked('API host is not in AUTORUSH_ALLOWED_API_HOSTS')
    return parsed


def evaluate_check(spec, output):
    kind, path, expected = spec.kind, spec.path, spec.expected
    try:
        if kind == 'status_code': actual = output['status_code']
        elif kind == 'json_field_equals': actual = json_field(output['body'], path)
        elif kind == 'json_field_exists':
            try: json_field(output['body'], path); actual = True
            except (KeyError, IndexError, TypeError): actual = False
            expected = True if expected is None else expected
        elif kind == 'header_equals': actual = output['headers'].get(path.lower())
        elif kind == 'response_time_less_than':
            actual = output['elapsed_ms']
            return actual < expected, f'{kind}: expected < {expected}, got {actual:.1f} ms'
        elif kind == 'body_contains':
            return str(expected) in output['text'], f'{kind}: expected {expected!r}'
        else: raise ValueError('unsupported API assertion')
    except (KeyError, IndexError, TypeError):
        return False, f'{kind}: missing {path}'
    return actual == expected, f'{kind}: expected {expected!r}, got {actual!r}'


def decode_file(encoded):
    try: value = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError): raise ApiBlocked('invalid base64 upload') from None
    if len(value) > MAX_REQUEST: raise ApiBlocked('upload exceeds 1 MiB')
    return value


class ApiEngine:
    def __init__(self, allowed_hosts, *, variables=None, secret_values=(), transport=None):
        self.allowed_hosts = set(allowed_hosts)
        self.initial_variables = dict(variables or {})
        self.variables = dict(self.initial_variables)
        self.secrets = set(secret_values)
        self.transport = transport
        self.cookies = httpx.Cookies()

    def reset(self):
        self.variables = dict(self.initial_variables)
        self.cookies = httpx.Cookies()

    async def execute(self, spec: ApiRequest) -> ApiExecution:
        started = time.perf_counter()
        request_evidence = {'method': spec.method, 'url': spec.url}
        output, checks = {}, []
        public = {'name': spec.name, 'method': spec.method, 'url': spec.url,
            'status': 'blocked', 'detail': '', 'request': request_evidence, 'response': None,
            'assertions': [], 'extracted': {}, 'elapsed_ms': 0}
        try:
            if spec.compatibility_warnings:
                raise ApiBlocked('review imported incompatibilities before executing: ' + '; '.join(spec.compatibility_warnings)[:700])
            local, secrets = variable_values([item.model_dump() for item in spec.variables])
            self.secrets.update(secrets)
            variables = {**self.variables, **local}
            for key, value in variables.items():
                if SENSITIVE.search(key) and value is not None: self.secrets.add(str(value))
            # Parse JSON before interpolation, preserving types in exact placeholders.
            source = spec.model_dump()
            source['variables'] = []
            if spec.body.mode == 'json':
                try: json_body = substitute(json.loads(spec.body.text), variables)
                except json.JSONDecodeError:
                    json_body = json.loads(substitute(spec.body.text, variables))
                source['body']['text'] = ''
            else: json_body = None
            resolved = substitute(source, variables)
            url = resolved['url']
            validate_url(url, self.allowed_hosts)
            auth = resolved['auth']
            self.secrets.update(str(auth[key]) for key in ['password', 'token', 'value'] if auth.get(key))
            headers = [(item['key'], str(item['value'])) for item in resolved['headers'] if item['enabled'] and item['key']]
            if any(key.lower() in FORBIDDEN_HEADERS for key, _ in headers):
                raise ApiBlocked('Host and transport headers cannot be overridden')
            if any('\r' in str(value) or '\n' in str(value) or '\x00' in str(value)
                   for item in headers for value in item): raise ApiBlocked('invalid header characters')
            query = [(item['key'], str(item['value'])) for item in resolved['query'] if item['enabled'] and item['key']]
            url = httpx.URL(url)
            for key, value in query: url = url.copy_add_param(key, value)
            if auth['type'] != 'none': headers = [(key, value) for key, value in headers if key.lower() != 'authorization']
            if auth['type'] == 'basic':
                encoded = base64.b64encode((str(auth['username']) + ':' + str(auth['password'])).encode()).decode()
                headers.append(('Authorization', 'Basic ' + encoded)); self.secrets.add(encoded)
            elif auth['type'] == 'bearer': headers.append(('Authorization', 'Bearer ' + str(auth['token'])))
            elif auth['type'] == 'api_key':
                if auth['location'] == 'query': url = url.copy_set_param(str(auth['key']), str(auth['value']))
                else: headers.append((str(auth['key']), str(auth['value'])))
            if any(not key or '\r' in key or '\n' in key or '\r' in value or '\n' in value or '\x00' in value
                   or key.lower() in FORBIDDEN_HEADERS for key, value in headers): raise ApiBlocked('invalid authentication headers')
            body = resolved['body']; kwargs = {}
            if body['mode'] == 'json': kwargs['json'] = json_body
            elif body['mode'] == 'raw': kwargs['content'] = body['text'].encode()
            elif body['mode'] == 'binary': kwargs['content'] = decode_file(body['data_base64'])
            elif body['mode'] == 'urlencoded':
                from urllib.parse import urlencode
                kwargs['content'] = urlencode([(field['key'], field['value']) for field in body['fields'] if field['enabled']]).encode()
            elif body['mode'] == 'formdata':
                kwargs['files'] = [(field['key'], (field['filename'], decode_file(field['data_base64']), field['content_type'])
                    if field['type'] == 'file' else (None, field['value'])) for field in body['fields'] if field['enabled']]
                headers = [(key, value) for key, value in headers if key.lower() != 'content-type']
            if body['mode'] in {'raw', 'binary', 'urlencoded'} and not any(key.lower() == 'content-type' for key, _ in headers):
                content_type = 'application/x-www-form-urlencoded' if body['mode'] == 'urlencoded' else body['content_type']
                if '\r' in content_type or '\n' in content_type: raise ApiBlocked('invalid content type')
                headers.append(('Content-Type', content_type))
            size = len(kwargs.get('content', b'')) + len(json.dumps(json_body).encode() if body['mode'] == 'json' else b'')
            size += sum(len(item[1][1]) for item in kwargs.get('files', []))
            if size > MAX_REQUEST: raise ApiBlocked('request body exceeds 1 MiB')
            request_evidence.update(url=str(url), headers=dict(headers), body=json_body if body['mode'] == 'json' else
                {'mode': body['mode'], 'text': body['text'][:4096] if body['mode'] == 'raw' else '', 'bytes': size})
            method = spec.method
            async with asyncio.timeout(spec.timeout_ms / 1000):
                async with httpx.AsyncClient(follow_redirects=False, trust_env=spec.proxy == 'system',
                    timeout=spec.timeout_ms / 1000, cookies=self.cookies, transport=self.transport) as client:
                    for hop in range(6):
                        validate_url(str(url), self.allowed_hosts)
                        async with client.stream(method, url, headers=headers, **kwargs) as response:
                            chunks, received = [], 0
                            async for chunk in response.aiter_bytes(chunk_size=65536):
                                received += len(chunk)
                                if received > MAX_RESPONSE: raise OverflowError('HTTP response exceeds 1 MiB')
                                chunks.append(chunk)
                            content = b''.join(chunks)
                            status_code = response.status_code
                            response_headers = dict(response.headers)
                            next_location = response.headers.get('location')
                            encoding = response.encoding or 'utf-8'
                        if spec.follow_redirects and status_code in {301, 302, 303, 307, 308} and next_location:
                            if hop == 5: raise ApiBlocked('HTTP redirect limit exceeded')
                            next_url = urljoin(str(url), next_location)
                            previous, following = urlsplit(str(url)), validate_url(next_url, self.allowed_hosts)
                            if previous.scheme == 'https' and following.scheme != 'https': raise ApiBlocked('HTTPS downgrade redirect refused')
                            if status_code == 303 and method != 'HEAD' or status_code in {301, 302} and method == 'POST':
                                method, kwargs = 'GET', {}
                                headers = [(key, value) for key, value in headers if key.lower() != 'content-type']
                            if (previous.scheme, previous.hostname, previous.port) != (following.scheme, following.hostname, following.port):
                                if kwargs: raise ApiBlocked('cross-origin redirect with a request body is not supported')
                                headers = [(key, value) for key, value in headers if not SENSITIVE.search(key)
                                    and not any(secret and secret in value for secret in self.secrets)]
                                client.cookies.clear()
                            url = httpx.URL(next_url)
                            continue
                        self.cookies = httpx.Cookies(client.cookies)
                        break
            text = content.decode(encoding, errors='replace')
            try: parsed_body = json.loads(text)
            except ValueError: parsed_body = text
            elapsed = (time.perf_counter() - started) * 1000
            output = {'status_code': status_code, 'body': parsed_body, 'text': text,
                'headers': response_headers, 'elapsed_ms': elapsed, 'bytes': len(content), 'url': str(url)}
            resolved_spec = ApiRequest.model_validate(resolved)
            checks = [evaluate_check(check, output) for check in resolved_spec.assertions]
            extracted = {}
            for extraction in resolved_spec.extractions:
                try:
                    value = json_field(parsed_body, extraction.path) if extraction.source == 'json' else (
                        response_headers[extraction.path.lower()] if extraction.source == 'header' else self.cookies[extraction.path])
                    extracted[extraction.key] = value
                    if extraction.secret or SENSITIVE.search(extraction.key): self.secrets.add(str(value))
                except (KeyError, IndexError, TypeError):
                    if extraction.required: checks.append((False, 'extraction missing: ' + extraction.key))
            passed = all(ok for ok, _ in checks)
            if passed: self.variables.update(extracted)
            public.update(status='passed' if passed else 'failed',
                detail=f'{method} → HTTP {status_code}; {sum(ok for ok, _ in checks)}/{len(checks)} checks passed',
                response=output, extracted=extracted,
                assertions=[{'passed': ok, 'detail': detail} for ok, detail in checks])
        except (ApiBlocked, ValueError, TypeError) as exc:
            public.update(status='blocked', detail=str(exc) if isinstance(exc, ApiBlocked) else 'invalid request configuration')
        except (httpx.HTTPError, TimeoutError, OverflowError, LookupError) as exc:
            public.update(status='error', detail='HTTP request failed: ' + type(exc).__name__)
        public['elapsed_ms'] = round((time.perf_counter() - started) * 1000, 2)
        public = redact(public, self.secrets)
        return ApiExecution(public, output, [(ok, redact(message, self.secrets)) for ok, message in checks])
