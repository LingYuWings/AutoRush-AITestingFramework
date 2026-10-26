"""Bounded multimodal JSON client with explicit destinations and compatibility retry."""
from __future__ import annotations
import inspect
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx
from autorush.llm.models import ProviderConfigRecord
from autorush.llm.protocols import SUPPORTED_PROTOCOLS, build_model_request, is_loopback_url, parse_model_response


@dataclass(frozen=True)
class ModelJsonResponse:
    value: dict[str, Any]
    request_id: str | None
    usage: dict[str, Any]
    attempts: int = 1
    latency_ms: int = 0
    finish_reason: str | None = None
    attempt_stats: list[dict] = field(default_factory=list)


class ModelClientError(RuntimeError):
    pass


class ModelClient:
    def __init__(self, config: ProviderConfigRecord, allowed_hosts: set[str], *, transport=None, timeout=90):
        parsed = urlsplit(config.base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ModelClientError('model base_url must be an HTTP(S) endpoint without credentials or parameters')
        local = config.credential_type == 'local' and is_loopback_url(config.base_url)
        if config.credential_type == 'local' and not local:
            raise ModelClientError('no-key model endpoints must be loopback')
        if not local and parsed.hostname.lower() not in {host.lower() for host in allowed_hosts}:
            raise ModelClientError('model host is not in AUTORUSH_ALLOWED_LLM_HOSTS')
        if parsed.scheme != 'https' and not local:
            raise ModelClientError('remote model endpoint must use HTTPS')
        if config.protocol not in SUPPORTED_PROTOCOLS:
            raise ModelClientError('selected provider protocol is not implemented')
        if config.credential_type == 'coding_plan':
            raise ModelClientError('Coding Plan is not authorized for backend execution')
        if not config.secret_ref and not local:
            raise ModelClientError('model credential reference is missing')
        token = os.getenv(config.secret_ref.removeprefix('env:')) if config.secret_ref else None
        if config.secret_ref and not token:
            raise ModelClientError(f'environment variable {config.secret_ref} is not configured')
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
        if token:
            if config.protocol == 'anthropic_messages': headers['x-api-key'] = token
            else: headers['Authorization'] = f'Bearer {token}'
        self._config = config
        self._client = httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(timeout, connect=min(timeout,10)),
                                         follow_redirects=False, trust_env=False, transport=transport)

    async def generate_json(self, system_prompt, user_prompt, *, images=None, schema=None, on_attempt=None):
        try:
            endpoint, payload, headers = build_model_request(self._config, system_prompt, user_prompt, images or [], schema)
        except ValueError as exc: raise ModelClientError(str(exc)) from exc
        started = time.monotonic()
        stats = []
        last_error = 'model response was not a valid JSON object'
        for attempt in range(2):
            if on_attempt:
                result = on_attempt()
                if inspect.isawaitable(result): await result
            attempt_start = time.monotonic()
            if attempt:
                payload.pop('response_format',None)
                payload.pop('text',None)
                if self._config.protocol == 'anthropic_messages': payload['system'] += '\nReturn complete valid JSON only.'
                elif self._config.protocol == 'openai_responses': payload['instructions'] += '\nReturn complete valid JSON only.'
                else: payload['messages'][0]['content'] += '\nReturn complete valid JSON only, without markdown or reasoning.'
            try:
                async with self._client.stream('POST', endpoint, json=payload, headers=headers) as response:
                    if response.status_code in {400,422} and attempt == 0:
                        last_error = 'model service rejected structured output format'
                        stats.append({'http_status':response.status_code,'latency_ms':round((time.monotonic()-attempt_start)*1000)})
                        continue
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data)>2_000_000: raise ModelClientError('model response exceeds limit')
                    body = json.loads(data)
                    text, reason, usage = parse_model_response(body,self._config.protocol)
                    value = json.loads(_strip_code_fence(text))
                    if not isinstance(value,dict): raise ValueError('model response must be a JSON object')
                    stats.append({'latency_ms':round((time.monotonic()-attempt_start)*1000),'usage':usage,'finish_reason':reason})
                    return ModelJsonResponse(value=value,request_id=response.headers.get('x-request-id') or body.get('id'),
                        usage=usage,attempts=attempt+1,latency_ms=round((time.monotonic()-started)*1000),finish_reason=reason,attempt_stats=stats)
            except httpx.HTTPStatusError as exc:
                raise ModelClientError(f'model service returned HTTP {exc.response.status_code}') from exc
            except httpx.HTTPError as exc:
                raise ModelClientError(f'model service request failed: {type(exc).__name__}') from exc
            except (ValueError,KeyError,IndexError,TypeError) as exc:
                last_error = 'model response was truncated or incomplete' if 'truncated' in str(exc) else 'model response was not a valid JSON object'
                stats.append({'error':last_error,'latency_ms':round((time.monotonic()-attempt_start)*1000)})
        raise ModelClientError(last_error)

    async def close(self):
        await self._client.aclose()


class OpenAICompatibleClient(ModelClient):
    """Compatibility entry point for existing case compilation callers."""


def _response_text(body, protocol):
    return parse_model_response(body, protocol)[0]


def _strip_code_fence(value):
    stripped=value.strip()
    if stripped.startswith('```') and stripped.endswith('```'):
        return '\n'.join(stripped.splitlines()[1:-1]).strip()
    return stripped
