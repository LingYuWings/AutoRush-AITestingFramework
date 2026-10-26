"""Persisted execution lifecycle is separate from immutable final test outcomes."""
from datetime import datetime,timezone
from typing import Literal
from uuid import UUID,uuid4
from pydantic import BaseModel,Field
from autorush.domain.models import CaseRecord,PlanRecord


class AgentExecutionRecord(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    plan_id: UUID
    idempotency_key: UUID
    state: Literal['running','stopping','finished','interrupted'] = 'running'
    plan_snapshot: PlanRecord
    case_snapshots: list[CaseRecord]
    progress: dict = Field(default_factory=dict)
    termination_reason: str | None = None
    final_run_id: UUID | None = None
    created_at: datetime = Field(default_factory=lambda:datetime.now(timezone.utc))


def validate_agent_configuration(settings,store,plan,cases):
    from urllib.parse import urlsplit
    from autorush.llm.service import preflight_provider
    from autorush.llm.protocols import SUPPORTED_PROTOCOLS,is_loopback_url
    if not plan.agent_options: raise ValueError('natural cases require agent_options and a selected model')
    config=store.get_provider_config(plan.agent_options.provider_config_id)
    if config is None or config.status!='verified': raise ValueError('selected model must pass text connection verification')
    if config.protocol not in SUPPORTED_PROTOCOLS or 'structured_output' not in config.capabilities:
        raise ValueError('selected model cannot produce supported structured decisions')
    if not preflight_provider(config).secret_available: raise ValueError('selected model credential reference is unavailable')
    if config.credential_type!='local' and (urlsplit(config.base_url).hostname or '').lower() not in settings.allowed_llm_hosts:
        raise ValueError('model host is not in AUTORUSH_ALLOWED_LLM_HOSTS')
    if config.credential_type=='local' and not is_loopback_url(config.base_url): raise ValueError('local model must be loopback')
    steps=[s for case in cases for s in case.steps+case.postconditions]
    if any(s.driver!='api' for s in steps) and not plan.capture_screenshots: raise ValueError('UI agent execution requires screenshots')
    if any(s.driver=='desktop' for case in cases if case.execution_mode=='agent' for s in case.steps+case.postconditions) and not config.vision_verified:
        raise ValueError('desktop natural execution requires verified visual capability')
    return config
