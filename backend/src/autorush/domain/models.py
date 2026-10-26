"""Validated, versionable case and plan payloads for the first API slice."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator


class CaseStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"


class PlanStatus(StrEnum):
    DRAFT = "draft"
    READY = "ready"


class ResultStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    ERROR = "error"
    BLOCKED = "blocked"
    SKIPPED = "skipped"


class AssertionSpec(BaseModel):
    kind: Literal["status_code", "json_field_equals", "body_contains", "url_equals", "url_contains", "text_contains", "element_visible", "pixel_rgb_equals", "package_equals"]
    expected: Any
    path: str | None = None

    @model_validator(mode="after")
    def require_path_for_json_field(self) -> "AssertionSpec":
        if self.kind == "json_field_equals" and not self.path:
            raise ValueError("json_field_equals requires path")
        if self.kind == "pixel_rgb_equals" and (
            not isinstance(self.expected, list)
            or len(self.expected) != 3
            or any(type(channel) is not int or not 0 <= channel <= 255 for channel in self.expected)
        ):
            raise ValueError("pixel_rgb_equals requires three RGB values in 0..255")
        return self


class StepSpec(BaseModel):
    order: int = Field(ge=1)
    intent: str = Field(min_length=1, max_length=1000)
    expected_result: str | None = Field(default=None,min_length=1,max_length=2000)
    driver: Literal["api", "web", "android", "desktop"]
    operation: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    assertions: list[AssertionSpec] = Field(default_factory=list)
    always_run: bool = False


class CaseCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    execution_mode: Literal['structured','agent'] = 'structured'
    platform: Literal['api','web','android','desktop'] | None = None
    steps: list[StepSpec] = Field(min_length=1)
    postconditions: list[StepSpec] = Field(default_factory=list)

    @model_validator(mode="after")
    def orders_must_be_unique(self) -> "CaseCreate":
        if self.platform and any(step.driver!=self.platform for step in self.steps+self.postconditions):
            raise ValueError('case steps must match the selected execution platform; mix platforms in a plan')
        for collection in (self.steps, self.postconditions):
            orders = [step.order for step in collection]
            if len(orders) != len(set(orders)):
                raise ValueError("step order must be unique within each list")
        if self.execution_mode=='agent':
            if len(self.steps)>50 or len(self.postconditions)>20: raise ValueError('natural case exceeds step limit')
            for step in self.steps+self.postconditions:
                if not step.expected_result or not step.expected_result.strip(): raise ValueError('natural steps require expected_result')
                if step.operation or step.parameters or step.assertions: raise ValueError('natural steps cannot contain compiled actions or assertions')
        return self


class CaseRecord(CaseCreate):
    id: UUID = Field(default_factory=uuid4)
    version: int = 1
    status: CaseStatus = CaseStatus.DRAFT
    source_case_id: UUID | None = None
    archived_at: datetime | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WebViewport(BaseModel):
    width: int = Field(default=1280, strict=True, ge=320, le=3840)
    height: int = Field(default=800, strict=True, ge=240, le=2160)


class DesktopTarget(BaseModel):
    hwnd: int = Field(strict=True, ge=1, le=2**53 - 1)
    pid: int = Field(strict=True, ge=1, le=2**32 - 1)
    process_started_at: str = Field(pattern=r"^[0-9]{1,20}$")
    title: str = Field(min_length=1, max_length=512)
    screen_width: int = Field(strict=True, ge=1, le=16384)
    screen_height: int = Field(strict=True, ge=1, le=16384)


class AgentOptions(BaseModel):
    provider_config_id: UUID
    max_rounds_per_step: int = Field(default=8,strict=True,ge=1,le=20)
    max_rounds_per_case: int = Field(default=40,strict=True,ge=1,le=200)
    model_timeout_seconds: int = Field(default=90,strict=True,ge=10,le=300)
    case_timeout_seconds: int = Field(default=600,strict=True,ge=30,le=1800)


class PlanCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    environment: str = Field(min_length=1, max_length=100)
    case_ids: list[UUID] = Field(min_length=1)
    agent_options: AgentOptions | None = None
    api_base_url: str | None = None
    web_base_url: str | None = None
    web_headless: bool = True
    web_viewport: WebViewport = Field(default_factory=WebViewport)
    desktop_target: DesktopTarget | None = None
    desktop_start_delay_seconds: int = Field(default=3, strict=True, ge=0, le=10)
    android_device_id: UUID | None = None
    capture_screenshots: bool = False
    android_package: str | None = Field(default=None, max_length=200, pattern=r"^(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*$")


class PlanRecord(PlanCreate):
    id: UUID = Field(default_factory=uuid4)
    version: int = 1
    status: PlanStatus = PlanStatus.DRAFT
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StepResult(BaseModel):
    order: int
    intent: str
    status: ResultStatus
    detail: str = ""
    assertions: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] = Field(default_factory=dict)


class CaseResult(BaseModel):
    case_id: UUID
    title: str = ""
    status: ResultStatus
    steps: list[StepResult]


class RunRecord(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    plan_id: UUID
    status: ResultStatus
    termination_reason: str | None = None
    cases: list[CaseResult]
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    report_path: str | None = None
    report_paths: dict[str, str] = Field(default_factory=dict)
