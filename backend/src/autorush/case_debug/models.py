from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator
from autorush.agent.executions import AgentExecutionRecord
from autorush.domain.models import AgentOptions, CaseCreate, CaseResult, DesktopTarget, WebViewport


class DebugTargets(BaseModel):
    model_config = ConfigDict(extra='forbid')
    api_base_url: str | None = None
    api_environment_id: UUID | None = None
    web_base_url: str | None = None
    web_headless: bool = False
    web_viewport: WebViewport = Field(default_factory=WebViewport)
    android_device_id: UUID | None = None
    android_package: str | None = None
    desktop_target: DesktopTarget | None = None
    desktop_start_delay_seconds: int = Field(default=3, strict=True, ge=0, le=10)
    agent_options: AgentOptions | None = None


class DebugStart(BaseModel):
    model_config = ConfigDict(extra='forbid')
    idempotency_key: UUID
    source_case_id: UUID | None = None
    source_version: int | None = Field(default=None, ge=1)
    session_id: UUID | None = None
    case: CaseCreate | None = None
    targets: DebugTargets = Field(default_factory=DebugTargets)

    @model_validator(mode='after')
    def source_required(self):
        if self.source_case_id is None and self.case is None:
            raise ValueError('select a case or provide current editor content')
        if self.source_case_id is not None and self.source_version is None:
            raise ValueError('source_version is required')
        if self.case and len(self.case.steps) + len(self.case.postconditions) > 120:
            raise ValueError('debug case exceeds 120 steps')
        return self


class DebugRecord(AgentExecutionRecord):
    source_case_id: UUID | None = None
    source_version: int | None = None
    session_id: UUID | None = None
    unsaved: bool = False
    request_hash: str
    result: CaseResult | None = None


def debug_summary(record: DebugRecord) -> dict:
    return {'id':str(record.id),'state':record.state,'title':record.case_snapshots[0].title,
        'source_case_id':str(record.source_case_id) if record.source_case_id else None,
        'source_version':record.source_version,'session_id':str(record.session_id) if record.session_id else None,
        'unsaved':record.unsaved,'execution_mode':record.case_snapshots[0].execution_mode,
        'platform':record.case_snapshots[0].platform or 'mixed','created_at':record.created_at.isoformat(),
        'status':record.result.status.value if record.result else None}
