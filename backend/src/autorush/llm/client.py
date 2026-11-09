"""Bounded multimodal JSON client with explicit destinations and compatibility retry."""
from __future__ import annotations
import asyncio
import inspect
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx
from autorush.llm.local_runtime import LocalVisionError, LocalVisionRuntime, managed_profile
from autorush.llm.models import ProviderConfigRecord
from autorush.llm.protocols import SUPPORTED_PROTOCOLS, build_model_request, is_loopback_url, parse_model_response
from autorush.llm.streaming import MAX_RESPONSE_BYTES, read_model_stream, response_reasoning


# Carry the parsed model response and metadata about the request attempts.
@dataclass(frozen=True)
class ModelJsonResponse:
    value: dict[str, Any]
    request_id: str | None
    usage: dict[str, Any]
    attempts: int = 1
    latency_ms: int = 0
    finish_reason: str | None = None
    attempt_stats: list[dict] = field(default_factory=list)


# Report a model request or response failure.
class ModelClientError(RuntimeError):
    pass


# Send structured requests using the configured model provider protocol.
class ModelClient:
    # Validate the provider endpoint and configure the HTTP client.
    def __init__(self, config: ProviderConfigRecord, allowed_hosts: set[str], *, transport=None, timeout=90,
                 local_runtime: LocalVisionRuntime | None = None):
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
        self._local_runtime = local_runtime
        self._profile = managed_profile(config) if local_runtime is not None else None
        self._resolved_endpoint: str | None = None
        self._managed = False
        self._endpoint_lock = asyncio.Lock()
        self._closed = False
        self._live_output = None
        self._stream_unavailable = False
        self._client = httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(timeout, connect=min(timeout,10)),
                                         follow_redirects=False, trust_env=False, transport=transport)

    # Attach a run-local observer without changing callers that only need JSON.
    def set_live_output(self, callback):
        self._live_output = callback

    # Forward provider activity to the current run's in-memory log.
    def _publish(self, kind, text):
        if self._live_output:
            self._live_output(kind, text)

    # Request a JSON object, retrying invalid responses when allowed.
    async def generate_json(self, system_prompt, user_prompt, *, images=None, schema=None, on_attempt=None):
        try:
            endpoint, payload, headers = build_model_request(self._config, system_prompt, user_prompt, images or [], schema)
        except ValueError as exc: raise ModelClientError(str(exc)) from exc
        self._publish('model', '正在连接模型')
        endpoint = await self._resolve_endpoint(endpoint)
        started = time.monotonic()
        stats = []
        last_error = 'model response was not a valid JSON object'
        streaming = self._live_output is not None and not self._stream_unavailable
        stream_rejected = False
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
                self._publish('model', f'等待模型输出 · 第 {attempt + 1} 次请求')
                request_payload = {**payload, 'stream': True} if streaming else payload
                if streaming and self._config.protocol == 'openai_chat':
                    request_payload['stream_options'] = {'include_usage': True}
                async with self._client.stream('POST', endpoint, json=request_payload, headers=headers) as response:
                    if attempt == 0 and (response.status_code in {400,422} or (streaming and response.status_code in {415,501})):
                        if streaming:
                            streaming = False
                            stream_rejected = True
                            self._publish('model', '流式请求未被接受，将尝试完整响应')
                        last_error = 'model service rejected structured output format'
                        stats.append({'http_status':response.status_code,'latency_ms':round((time.monotonic()-attempt_start)*1000)})
                        continue
                    response.raise_for_status()
                    if 'text/event-stream' in response.headers.get('content-type', '').lower():
                        body = await read_model_stream(response, self._config.protocol, lambda text: self._publish('reasoning', text))
                    else:
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data)>MAX_RESPONSE_BYTES: raise ModelClientError('model response exceeds limit')
                        body = json.loads(data)
                        if self._live_output:
                            for reasoning in response_reasoning(body, self._config.protocol):
                                self._publish('reasoning', reasoning)
                    text, reason, usage = parse_model_response(body,self._config.protocol)
                    value = json.loads(_strip_code_fence(text))
                    if not isinstance(value,dict): raise ValueError('model response must be a JSON object')
                    stats.append({'latency_ms':round((time.monotonic()-attempt_start)*1000),'usage':usage,'finish_reason':reason})
                    if stream_rejected:
                        self._stream_unavailable = True
                    self._publish('model', '模型响应已通过 JSON 校验')
                    return ModelJsonResponse(value=value,request_id=response.headers.get('x-request-id') or body.get('id'),
                        usage=usage,attempts=attempt+1,latency_ms=round((time.monotonic()-started)*1000),finish_reason=reason,attempt_stats=stats)
            except httpx.HTTPStatusError as exc:
                self._publish('model', f'模型服务返回 HTTP {exc.response.status_code}')
                raise ModelClientError(f'model service returned HTTP {exc.response.status_code}') from exc
            except httpx.HTTPError as exc:
                self._publish('model', '模型服务连接中断')
                raise ModelClientError(f'model service request failed: {type(exc).__name__}') from exc
            except (ValueError,KeyError,IndexError,TypeError) as exc:
                last_error = 'model response was truncated or incomplete' if 'truncated' in str(exc) else 'model response was not a valid JSON object'
                self._publish('model', '模型响应不完整或 JSON 无效')
                stats.append({'error':last_error,'latency_ms':round((time.monotonic()-attempt_start)*1000)})
        raise ModelClientError(last_error)

    async def _resolve_endpoint(self, endpoint: str) -> str:
        """Keep a reachable server in use, or load the project's model on demand."""
        async with self._endpoint_lock:
            if self._closed:
                raise ModelClientError("model client is closed")
            return await self._resolve_local_endpoint(endpoint)

    async def _resolve_local_endpoint(self, endpoint: str) -> str:
        """Acquire at most one local model lease for this client."""
        if self._profile is None or self._local_runtime is None:
            return endpoint
        if self._resolved_endpoint is None:
            try:
                await self._client.get("http://127.0.0.1:8080/health", timeout=2)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                try:
                    port = await self._local_runtime.acquire(self._profile)
                except LocalVisionError as exc:
                    raise ModelClientError(str(exc)) from exc
                self._managed = True
                endpoint = f"http://127.0.0.1:{port}/v1/chat/completions"
            except httpx.RequestError:
                # A listener answered slowly or closed the probe. Leave it in control of its endpoint.
                pass
            self._resolved_endpoint = endpoint
        return self._resolved_endpoint

    # Close HTTP resources and release any owned model lease.
    async def close(self):
        async with self._endpoint_lock:
            self._closed = True
            try:
                await self._client.aclose()
            finally:
                if self._managed and self._local_runtime is not None:
                    self._managed = False
                    await self._local_runtime.release()


# Retain the client entry point used by existing case compilation callers.
class OpenAICompatibleClient(ModelClient):
    """Compatibility entry point for existing case compilation callers."""


# Extract the text from a provider's response body.
def _response_text(body, protocol):
    return parse_model_response(body, protocol)[0]


# Remove a surrounding Markdown code fence before parsing JSON.
def _strip_code_fence(value):
    stripped=value.strip()
    if stripped.startswith('```') and stripped.endswith('```'):
        return '\n'.join(stripped.splitlines()[1:-1]).strip()
    return stripped
