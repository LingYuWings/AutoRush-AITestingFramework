"""Environment-backed settings for the local development server."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_path: Path
    report_dir: Path
    allowed_api_hosts: frozenset[str]
    allowed_web_hosts: frozenset[str] = frozenset()
    allowed_llm_hosts: frozenset[str] = frozenset()
    frontend_port: int = 5173
    portal_token: str = ""
    operator_token: str = ""
    backend_port: int = 8000
    local_device_port: int = 8443
    desktop_enabled: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        workspace = Path.cwd()
        return cls(
            database_path=Path(os.getenv("AUTORUSH_DB_PATH", workspace / "data" / "autorush.sqlite3")),
            report_dir=Path(os.getenv("AUTORUSH_REPORT_DIR", workspace / "reports")),
            allowed_api_hosts=frozenset(
                item.strip().lower()
                for item in os.getenv("AUTORUSH_ALLOWED_API_HOSTS", "").split(",")
                if item.strip()
            ),
            allowed_web_hosts=frozenset(
                item.strip().lower()
                for item in os.getenv("AUTORUSH_ALLOWED_WEB_HOSTS", "").split(",")
                if item.strip()
            ),
            allowed_llm_hosts=frozenset(
                item.strip().lower()
                for item in os.getenv("AUTORUSH_ALLOWED_LLM_HOSTS", "").split(",")
                if item.strip()
            ),
            frontend_port=int(os.getenv("AUTORUSH_FRONTEND_PORT", "5173")),
            portal_token=os.getenv("AUTORUSH_PORTAL_TOKEN", ""),
            operator_token=os.getenv("AUTORUSH_OPERATOR_TOKEN", ""),
            backend_port=int(os.getenv("AUTORUSH_BACKEND_PORT", "8000")),
            local_device_port=int(os.getenv("AUTORUSH_LOCAL_DEVICE_PORT", "8443")),
            desktop_enabled=os.getenv('AUTORUSH_DESKTOP_ENABLED','0') == '1',
        )
