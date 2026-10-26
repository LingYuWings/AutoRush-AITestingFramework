"""Provider preset and secret-reference-only configuration models."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator, model_validator

from autorush.domain.models import CaseCreate


class CredentialType(StrEnum):
    API_KEY = "api_key"
    TOKEN_PLAN = "token_plan"
    CODING_PLAN = "coding_plan"
    LOCAL = "local"


class ModelCapability(StrEnum):
    TEXT_ONLY = "text_only"
    STRUCTURED_OUTPUT = "structured_output"
    TOOL_CALLING = "tool_calling"
    VISION = "vision"


class ProviderPreset(BaseModel):
    id: str
    display_name: str
    regions: list[str]
    protocols: list[str]
    credential_types: list[CredentialType]
    capabilities: list[ModelCapability]
    suggested_base_url: str | None = None
    documentation_url: str | None = None
    compliance_note: str


class ProviderConfigCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider_id: str = Field(min_length=1, max_length=60)
    region: str = Field(min_length=1, max_length=60)
    credential_type: CredentialType
    protocol: str = Field(min_length=1, max_length=60)
    base_url: str = Field(min_length=1, max_length=500)
    secret_ref: str | None = Field(default=None, max_length=140)
    model_id: str = Field(min_length=1, max_length=200)
    capabilities: set[ModelCapability] = Field(min_length=1)

    @field_validator("secret_ref")
    @classmethod
    def validate_secret_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.startswith("env:"):
            raise ValueError("secret_ref must use env:VARIABLE_NAME and cannot contain a raw token")
        variable = value.removeprefix("env:")
        if not variable or not variable.replace("_", "A").isalnum() or variable.upper() != variable:
            raise ValueError("secret_ref environment variable must contain uppercase letters, digits or underscores")
        return value

    @model_validator(mode="after")
    def secret_required_for_remote_provider(self) -> "ProviderConfigCreate":
        if self.credential_type != CredentialType.LOCAL and not self.secret_ref:
            raise ValueError("remote provider credentials require secret_ref")
        if self.credential_type == CredentialType.LOCAL and self.secret_ref:
            raise ValueError("local provider must not declare secret_ref")
        return self


class ProviderConfigRecord(ProviderConfigCreate):
    id: UUID = Field(default_factory=uuid4)
    status: str = "unverified"
    vision_verified: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProviderPreflight(BaseModel):
    config_id: UUID
    configuration_valid: bool
    secret_available: bool
    connection_tested: bool = False
    messages: list[str]


class ProviderConnectionTest(BaseModel):
    config_id: UUID
    connected: bool
    request_id: str | None = None
    latency_ms: int = Field(ge=0)
    usage: dict[str, Any] = Field(default_factory=dict)
    message: str


class ModelCatalogRequest(BaseModel):
    provider_id: str = Field(min_length=1,max_length=60)
    region: str = Field(min_length=1,max_length=60)
    credential_type: CredentialType
    protocol: str = Field(min_length=1,max_length=60)
    base_url: str = Field(min_length=1,max_length=500)
    secret_ref: str | None = None


class LocalRuntime(BaseModel):
    id: str
    name: str
    base_url: str
    models: list[str]
    latency_ms: int


class LocalDiscoveryResult(BaseModel):
    runtimes: list[LocalRuntime]
    scanned: int
    duration_ms: int


class ProviderVisionTest(BaseModel):
    config_id: UUID
    verified: bool
    request_id: str | None = None
    latency_ms: int
    message: str


class NaturalStepInput(BaseModel):
    intent: str = Field(min_length=1, max_length=1000)
    driver: Literal["api", "web"]
    always_run: bool = False


class CaseCompileRequest(BaseModel):
    provider_config_id: UUID
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    steps: list[NaturalStepInput] = Field(min_length=1, max_length=50)
    postconditions: list[NaturalStepInput] = Field(default_factory=list, max_length=20)


class CaseCompileResult(BaseModel):
    draft: CaseCreate
    provider_id: str
    model_id: str
    request_id: str | None = None
    usage: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
