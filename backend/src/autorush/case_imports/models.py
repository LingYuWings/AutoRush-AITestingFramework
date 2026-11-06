"""Editable import candidates and bounded, deterministic parsing contracts."""
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

Platform = Literal['web', 'android', 'desktop', 'api']


class ImportOptions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    default_platform: Platform | None = None
    case_heading_level: int = Field(default=2, ge=1, le=6)
    case_depth: int | None = Field(default=None, ge=0, le=63)
    sheet_ids: list[str] | None = Field(default=None, max_length=100)


@dataclass(frozen=True)
class ImportLimits:
    max_file_bytes: int = 10 * 1024 * 1024
    max_uncompressed_bytes: int = 50 * 1024 * 1024
    max_entries: int = 500
    max_cases: int = 500
    max_nodes: int = 20_000
    max_depth: int = 64


class ImportParseError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ImportSource(BaseModel):
    line_start: int | None = None
    line_end: int | None = None
    sheet_id: str | None = None
    sheet_title: str | None = None
    topic_path: list[str] = Field(default_factory=list)
    topic_ids: list[str] = Field(default_factory=list)


class ImportDiagnostic(BaseModel):
    code: str
    message: str
    severity: Literal['error', 'warning'] = 'error'
    field: str | None = None
    source: ImportSource | None = None


class ImportCandidate(BaseModel):
    candidate_id: str
    source: ImportSource
    draft: dict[str, Any]
    diagnostics: list[ImportDiagnostic] = Field(default_factory=list)

    @computed_field
    @property
    def valid(self) -> bool:
        return not any(item.severity == 'error' for item in self.diagnostics)


class ImportPreview(BaseModel):
    filename: str
    file_sha256: str
    format: Literal['markdown', 'xmind_json', 'xmind_xml']
    parser_version: str = '1'
    candidates: list[ImportCandidate] = Field(default_factory=list)
    diagnostics: list[ImportDiagnostic] = Field(default_factory=list)
