"""Validated background collection-run inputs."""
from typing import Any, Literal
from pydantic import Field, model_validator
from autorush.api_testing.models import ApiModel


class DatasetInput(ApiModel):
    format: Literal['csv', 'json']
    content: str = Field(max_length=1048576)


class RunCommand(ApiModel):
    collection_id: str
    folder_id: str | None = None
    request_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)
    environment_id: str | None = None
    iterations: int | None = Field(default=None, ge=1, le=1000)
    data: DatasetInput | None = None
    variables: dict[str, Any] = Field(default_factory=dict, max_length=100)
    delay_ms: int = Field(default=0, ge=0, le=60000)
    timeout_seconds: int = Field(default=300, ge=5, le=1800)
    stop_on_failure: bool = True
    idempotency_key: str = Field(min_length=8, max_length=100)

    @model_validator(mode='after')
    def distinct_requests(self):
        if self.request_ids and len(set(self.request_ids)) != len(self.request_ids):
            raise ValueError('selected requests must be unique')
        return self
