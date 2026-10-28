"""API execution adapter over the shared workbench HTTP engine."""
from __future__ import annotations
import json
from urllib.parse import urlsplit
import httpx
from autorush.api_testing.engine import ApiEngine, bounded_evidence, validate_url
from autorush.api_testing.models import ApiRequest
from autorush.api_testing.nodes import request_snapshot
from autorush.api_testing.variables import redact, variable_values
from autorush.domain.models import StepSpec
from autorush.drivers.base import ActionResult


class HttpApiDriver:
    def __init__(self, base_url: str | None, allowed_hosts: set[str], *, transport: httpx.AsyncBaseTransport | None = None,
        store=None, variables=None, secret_values=()):
        if base_url:
            parsed = urlsplit(base_url)
            if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError('api_base_url must be an absolute HTTP(S) URL without credentials, query or fragment')
            if parsed.hostname.lower() not in {host.lower() for host in allowed_hosts}:
                raise PermissionError('API host is not in AUTORUSH_ALLOWED_API_HOSTS')
            validate_url(base_url, allowed_hosts)
        self._base_url, self._store = base_url, store
        self._engine = ApiEngine(allowed_hosts, variables=variables, secret_values=secret_values, transport=transport)
        self._last_output = {}

    @property
    def runtime_variables(self): return self._engine.variables

    @property
    def runtime_secrets(self): return frozenset(self._engine.secrets)

    def begin_case(self): self._engine.reset()

    def sanitize_result(self, result):
        data = result.model_dump()
        for key in ['intent', 'detail', 'assertions', 'evidence']: data[key] = redact(data[key], self._engine.secrets)
        return result.model_validate(data)

    async def execute(self, step: StepSpec) -> ActionResult:
        if step.driver != 'api' or step.operation != 'api.request': raise ValueError('HTTP driver only accepts api.request')
        spec, inherited = request_snapshot(step, self._store)
        legacy = spec is None
        if legacy:
            path = step.parameters.get('path')
            if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or not self._base_url:
                raise ValueError('path must be an absolute path on the configured host')
            if urlsplit(path).netloc or urlsplit(path).scheme or '#' in path or chr(92) in path or any(ord(char) < 32 for char in path):
                raise ValueError('path cannot change host or contain a fragment')
            headers = step.parameters.get('headers') or {}
            query = step.parameters.get('query') or {}
            spec = ApiRequest.model_validate({'name': step.intent, 'method': str(step.parameters.get('method', 'GET')).upper(),
                'url': self._base_url.rstrip('/') + '/' + path.lstrip('/'),
                'headers': [{'key': key, 'value': str(value)} for key, value in headers.items()],
                'query': [{'key': key, 'value': str(value)} for key, value in query.items()],
                'body': {'mode': 'json', 'text': json.dumps(step.parameters['json'])} if 'json' in step.parameters else {'mode': 'none'}})
        elif spec.url.startswith('/') and self._base_url:
            spec = spec.model_copy(update={'url': self._base_url.rstrip('/') + '/' + spec.url.lstrip('/')})
        values, secrets = variable_values(inherited)
        self._engine.secrets.update(secrets)
        execution = await self._engine.execute(spec, inherited_variables=values)
        self._last_output = execution.output
        public = execution.public
        output = ({key: execution.output[key] for key in ['status_code', 'body'] if key in execution.output}
                  if legacy else execution.output)
        return ActionResult(output=output, summary=public['detail'], evidence={'api': bounded_evidence(public)},
            checks=execution.checks, status=public['status'] if public['status'] != 'passed' else None)

    async def observe(self):
        from autorush.agent.observers import fingerprint
        output = redact(self._last_output, self._engine.secrets)
        text = json.dumps(output, ensure_ascii=False, default=str)
        if len(text) > 12000: output = {'status_code': output.get('status_code'), 'body': str(output.get('body'))[:10000], 'truncated': True}
        return {'target': {'base_url': self._base_url}, 'text': text[:12000], 'last_output': output, 'elements': [], 'fingerprint': fingerprint(output)}

    async def close(self):
        pass  # Each HTTP exchange owns and closes its client, including cancellation paths.
