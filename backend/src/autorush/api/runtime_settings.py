"""Expose effective settings and save overrides for the next local launch."""

import os
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from autorush.config.runtime import config_path, normalize, read_overrides, write_overrides


class RuntimeUpdate(BaseModel):
    """Carry only changed keys; a null value removes the saved override."""

    overrides: dict[str, str | None] = Field(max_length=16)


def create_runtime_settings_router(settings, require_operator, trusted_local_request):
    """Register local operator endpoints without exposing startup credentials."""
    router = APIRouter(prefix='/api/v1/runtime-settings')
    path = config_path()
    lock = Lock()
    effective = {
        'AUTORUSH_DB_PATH': str(settings.database_path.resolve()),
        'AUTORUSH_REPORT_DIR': str(settings.report_dir.resolve()),
        'AUTORUSH_LOG_DIR': str(Path(os.getenv('AUTORUSH_LOG_DIR', Path.cwd() / 'artifacts/dev-logs')).resolve()),
        'AUTORUSH_ALLOWED_API_HOSTS': ','.join(sorted(settings.allowed_api_hosts)),
        'AUTORUSH_ALLOWED_WEB_HOSTS': ','.join(sorted(settings.allowed_web_hosts)),
        'AUTORUSH_ALLOWED_LLM_HOSTS': ','.join(sorted(settings.allowed_llm_hosts)),
        'AUTORUSH_BACKEND_PORT': str(settings.backend_port),
        'AUTORUSH_FRONTEND_PORT': str(settings.frontend_port),
        'AUTORUSH_LOCAL_DEVICE_PORT': str(settings.local_device_port),
        'AUTORUSH_DESKTOP_ENABLED': '1' if settings.desktop_enabled else '0',
        'AUTORUSH_LOCAL_VISION_LAUNCHER': str(settings.local_vision_launcher or ''),
        'PLAYWRIGHT_BROWSERS_PATH': os.getenv('PLAYWRIGHT_BROWSERS_PATH', ''),
        'AUTORUSH_VITE_CACHE_DIR': os.getenv('AUTORUSH_VITE_CACHE_DIR', ''),
        'AUTORUSH_MCP_API_URL': os.getenv('AUTORUSH_MCP_API_URL', 'http://127.0.0.1:8000'),
        'AUTORUSH_MCP_CONSOLE_ORIGIN': os.getenv('AUTORUSH_MCP_CONSOLE_ORIGIN', 'http://127.0.0.1:5173'),
        'AUTORUSH_MCP_ALLOWED_PACKAGES': os.getenv('AUTORUSH_MCP_ALLOWED_PACKAGES', 'com.autorush.fixture'),
    }
    mode = os.getenv('AUTORUSH_LAUNCH_MODE', 'external')
    locked = {'AUTORUSH_FRONTEND_PORT', 'AUTORUSH_VITE_CACHE_DIR'} if mode == 'packaged' else set()
    if mode == 'unix':
        locked.add('AUTORUSH_DESKTOP_ENABLED')

    def authorize(request, token):
        """Limit filesystem and network settings to the trusted local console."""
        require_operator(token)
        if not trusted_local_request(request):
            raise HTTPException(403, 'Runtime settings require a trusted local operator')

    def snapshot(overrides):
        """Describe the running process and saved values separately."""
        return {'effective': effective, 'overrides': overrides, 'path': str(path), 'mode': mode,
                'locked': sorted(locked), 'portal_token_configured': bool(settings.portal_token),
                'operator_token_configured': bool(settings.operator_token)}

    @router.get('')
    def get_settings(request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        """Read the current settings without mutating the filesystem."""
        authorize(request, x_autorush_operator_token)
        try:
            return snapshot(read_overrides(path))
        except (OSError, ValueError) as exc:
            raise HTTPException(409, 'Could not read the runtime settings file') from exc

    @router.put('')
    def update_settings(payload: RuntimeUpdate, request: Request, x_autorush_operator_token: str | None = Header(default=None)):
        """Merge edits atomically and leave the currently running service intact."""
        authorize(request, x_autorush_operator_token)
        try:
            with lock:
                values = read_overrides(path)
                for key, value in payload.overrides.items():
                    if key not in effective or key in locked:
                        raise ValueError('Unknown or unavailable setting')
                    if value is None:
                        values.pop(key, None)
                    else:
                        values[key] = normalize(key, value)
                ports = [effective[key] if key in locked else values.get(key, effective[key]) for key in
                         ('AUTORUSH_BACKEND_PORT', 'AUTORUSH_FRONTEND_PORT', 'AUTORUSH_LOCAL_DEVICE_PORT')
                         if mode != 'packaged' or key != 'AUTORUSH_FRONTEND_PORT']
                if len(set(ports)) != len(ports):
                    raise ValueError('The backend, frontend and pairing ports must be different')
                write_overrides(path, values)
            return snapshot(values)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(409, 'Could not save the runtime settings file') from exc

    return router
