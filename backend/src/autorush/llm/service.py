"""Provider policy enforcement, local preflight and explicit connection test."""

from __future__ import annotations

import os
from time import perf_counter
from urllib.parse import urlsplit

import httpx

from autorush.llm.client import OpenAICompatibleClient
from autorush.llm.models import CredentialType, ModelCapability, ProviderConfigCreate, ProviderConfigRecord, ProviderConnectionTest, ProviderPreflight
from autorush.llm.presets import PRESETS_BY_ID
from autorush.llm.protocols import is_loopback_url


def validate_provider_config(payload: ProviderConfigCreate) -> None:
    preset = PRESETS_BY_ID.get(payload.provider_id)
    if preset is None:
        raise ValueError("unknown provider preset")
    if payload.region not in preset.regions:
        raise ValueError("region is not supported by this preset")
    if payload.protocol not in preset.protocols:
        raise ValueError("protocol is not supported by this preset")
    if payload.credential_type not in preset.credential_types:
        raise ValueError("credential type is not supported by this preset")
    if payload.credential_type == CredentialType.CODING_PLAN:
        raise ValueError("Coding Plan credentials are not authorized for automated backend execution")
    if not payload.capabilities.issubset(set(preset.capabilities)):
        raise ValueError("requested capabilities exceed the provider preset")
    parsed = urlsplit(payload.base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base_url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("base_url cannot contain credentials, query or fragment")
    local = payload.credential_type == CredentialType.LOCAL and is_loopback_url(payload.base_url)
    if payload.credential_type == CredentialType.LOCAL and not local:
        raise ValueError('local model address must be loopback')
    if parsed.scheme != "https" and not local:
        raise ValueError("remote provider base_url must use HTTPS")


def preflight_provider(config: ProviderConfigRecord) -> ProviderPreflight:
    validate_provider_config(ProviderConfigCreate(**config.model_dump(exclude={"id", "status", "created_at"})))
    secret_available = config.secret_ref is None or bool(os.getenv(config.secret_ref.removeprefix("env:")))
    messages = ["配置字段与套餐策略校验通过。"]
    if not secret_available:
        messages.append(f"运行环境中未找到 {config.secret_ref}。")
    messages.append("尚未向服务商发起网络请求；连接状态仍为 unverified。")
    return ProviderPreflight(config_id=config.id, configuration_valid=True, secret_available=secret_available, messages=messages)


async def test_provider_connection(
    config: ProviderConfigRecord,
    allowed_hosts: set[str],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ProviderConnectionTest:
    if ModelCapability.STRUCTURED_OUTPUT not in config.capabilities:
        raise ValueError("connection test requires structured_output capability")
    client = OpenAICompatibleClient(config, allowed_hosts, transport=transport)
    started = perf_counter()
    try:
        response = await client.generate_json(
            "Return only a JSON object with an ok boolean.",
            'Return {"ok": true}.',
        )
    finally:
        await client.close()
    latency_ms = round((perf_counter() - started) * 1000)
    if response.value.get("ok") is not True:
        raise ValueError("model connection succeeded but structured JSON verification failed")
    return ProviderConnectionTest(
        config_id=config.id, connected=True, request_id=response.request_id, latency_ms=latency_ms,
        usage=response.usage, message="鉴权、文本请求和结构化 JSON 响应验证通过。",
    )
