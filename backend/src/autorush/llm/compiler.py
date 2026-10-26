"""Natural-language step compiler with schema and operation policy validation."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from autorush.domain.models import CaseCreate
from autorush.llm.client import ModelClientError, OpenAICompatibleClient
from autorush.llm.models import CaseCompileRequest, CaseCompileResult, ModelCapability, ProviderConfigRecord


ALLOWED_OPERATIONS = {
    "api": {"api.request"},
    "web": {"web.open", "web.click", "web.fill", "web.inspect"},
}

SYSTEM_PROMPT = """You compile human-written test steps into a safe JSON test case draft.
Return one JSON object only. Preserve the number, order, driver, intent, and always_run value of every supplied step.
Allowed operations: api.request; web.open, web.click, web.fill, web.inspect.
API paths and Web open paths must begin with / and must not contain a host. Never emit credentials, shell commands, code, scripts, or extra steps.
Web targets must contain exactly one locator: role (optionally with name), label, test_id, or css.
Assertions may use status_code, json_field_equals, body_contains, url_equals, url_contains, text_contains, or element_visible.
If details are missing, use conservative placeholders and include a warning string instead of inventing credentials or external hosts."""


async def compile_case(
    request: CaseCompileRequest,
    config: ProviderConfigRecord,
    allowed_hosts: set[str],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> CaseCompileResult:
    if ModelCapability.STRUCTURED_OUTPUT not in config.capabilities:
        raise ModelClientError("selected model configuration lacks structured_output capability")
    input_value = request.model_dump(mode="json", exclude={"provider_config_id"})
    prompt = (
        "Compile this test case. The output must match this JSON Schema:\n"
        + json.dumps(CaseCreate.model_json_schema(), ensure_ascii=False)
        + "\nInput:\n"
        + json.dumps(input_value, ensure_ascii=False)
    )
    client = OpenAICompatibleClient(config, allowed_hosts, transport=transport)
    try:
        response = await client.generate_json(SYSTEM_PROMPT, prompt)
    finally:
        await client.close()
    raw_draft = response.value.get("draft", response.value)
    warnings = response.value.get("warnings", [])
    if not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings):
        warnings = ["模型返回的 warnings 字段无效，已忽略。"]
    try:
        draft = CaseCreate.model_validate(raw_draft)
    except ValidationError as exc:
        raise ModelClientError("model output failed the test-case schema") from exc
    _validate_draft_matches_request(request, draft)
    return CaseCompileResult(
        draft=draft,
        provider_id=config.provider_id,
        model_id=config.model_id,
        request_id=response.request_id,
        usage=response.usage,
        warnings=warnings,
    )


def _validate_draft_matches_request(request: CaseCompileRequest, draft: CaseCreate) -> None:
    if draft.title != request.title or draft.description != request.description:
        raise ModelClientError("model changed the case title or description")
    for source, compiled, label in (
        (request.steps, draft.steps, "steps"),
        (request.postconditions, draft.postconditions, "postconditions"),
    ):
        if len(source) != len(compiled):
            raise ModelClientError(f"model changed the number of {label}")
        for index, (natural, step) in enumerate(zip(source, compiled, strict=True), start=1):
            if natural.driver != step.driver:
                raise ModelClientError(f"model changed driver for {label} item {index}")
            if natural.intent != step.intent:
                raise ModelClientError(f"model changed intent for {label} item {index}")
            if step.order != index:
                raise ModelClientError(f"model changed order for {label} item {index}")
            if step.operation not in ALLOWED_OPERATIONS[step.driver]:
                raise ModelClientError(f"model selected an unsupported operation for {label} item {index}")
            if natural.always_run != step.always_run:
                raise ModelClientError(f"model changed always_run for {label} item {index}")
            _validate_operation_parameters(step.driver, step.operation, step.parameters, label, index)
            allowed_assertions = ({"status_code", "json_field_equals", "body_contains"} if step.driver == "api"
                                  else {"url_equals", "url_contains", "text_contains", "element_visible"})
            if any(assertion.kind not in allowed_assertions for assertion in step.assertions):
                raise ModelClientError(f"model selected an incompatible assertion for {label} item {index}")


def _validate_operation_parameters(driver: str, operation: str, parameters: dict[str, object], label: str, index: int) -> None:
    prefix = f"{label} item {index}"
    if driver == "api":
        if set(parameters) - {"method", "path", "query", "json"}:
            raise ModelClientError(f"model emitted unsupported API parameters for {prefix}")
        method = parameters.get("method", "GET")
        if not isinstance(method, str) or method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}:
            raise ModelClientError(f"model emitted an unsupported HTTP method for {prefix}")
        _validate_local_path(parameters.get("path"), prefix)
        if "query" in parameters and not isinstance(parameters["query"], dict):
            raise ModelClientError(f"model emitted an invalid query object for {prefix}")
        return
    if operation == "web.open":
        if set(parameters) != {"path"}:
            raise ModelClientError(f"model emitted unsupported web.open parameters for {prefix}")
        _validate_local_path(parameters.get("path"), prefix)
        return
    expected_keys = {"target", "value"} if operation == "web.fill" else {"target"}
    if set(parameters) != expected_keys:
        raise ModelClientError(f"model emitted unsupported Web parameters for {prefix}")
    target = parameters.get("target")
    if not isinstance(target, dict):
        raise ModelClientError(f"model omitted the Web target for {prefix}")
    locator_keys = [key for key in ("role", "label", "test_id", "css") if key in target]
    if len(locator_keys) != 1 or set(target) - {locator_keys[0], "name"}:
        raise ModelClientError(f"model emitted an invalid Web locator for {prefix}")
    if "name" in target and locator_keys[0] != "role":
        raise ModelClientError(f"model used name with a non-role locator for {prefix}")
    if operation == "web.fill" and not isinstance(parameters.get("value"), str):
        raise ModelClientError(f"model omitted the Web fill value for {prefix}")


def _validate_local_path(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//"):
        raise ModelClientError(f"model emitted an invalid local path for {label}")
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.fragment or "\\" in value or any(ord(char) < 32 for char in value):
        raise ModelClientError(f"model emitted a path that can leave the configured host for {label}")
