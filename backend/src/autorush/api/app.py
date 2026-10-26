"""Local development API for the first executable test framework slice."""

from __future__ import annotations

import asyncio
import hmac
import hashlib
import ipaddress
import json
import secrets
import threading
from collections.abc import Awaitable, Callable
from datetime import datetime,timezone
from typing import Any, Literal
from uuid import UUID, uuid4
from urllib.parse import urlsplit

import httpx
import anyio
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from autorush.config.settings import Settings
from autorush.domain.models import (
    CaseResult,
    CaseCreate,
    CaseRecord,
    CaseStatus,
    PlanCreate,
    PlanRecord,
    PlanStatus,
    ResultStatus,
    RunRecord,
)
from autorush.devices.hub import DeviceAlreadyConnectedError, DeviceHub
from autorush.devices import adb
from autorush.devices.local_server import LocalDeviceServer
from autorush.devices.screen import ScreenHub, serve_viewer
from autorush.devices.adb_screen import AdbScreenHub, serve_adb_viewer
from contextlib import asynccontextmanager
from autorush.devices.pairing import PairingClaim, PairingCreate, PairingStore, validate_wss_url
from autorush.drivers.api.http import HttpApiDriver
from autorush.drivers.android.portal import AndroidPortalDriver, validate_android_step
from autorush.drivers.base import Driver
from autorush.drivers.web.playwright import PlaywrightWebDriver
from autorush.drivers.web.validation import validate_web_step
from autorush.drivers.desktop.contracts import validate_desktop_step
from autorush.drivers.desktop.process import DesktopProcessDriver
from autorush.api.automation import create_automation_router, check_desktop_target
from autorush.api.model_catalog import create_model_catalog_router
from autorush.api.agent_runs import create_agent_run_router
from autorush.agent.executions import validate_agent_configuration
from autorush.agent.manager import AgentRunManager
from autorush.llm.client import ModelClient
from autorush.runner.factory import DriverSession
from autorush.evidence.report import save_reports
from autorush.evidence.agent_trace import iter_run_screenshots
from autorush.evidence.screenshot import evidence_path
from autorush.events import EventBroker, PlatformEvent
from autorush.llm.client import ModelClientError
from autorush.llm.compiler import compile_case
from autorush.llm.models import ProviderConfigCreate, ProviderConfigRecord, ProviderConnectionTest, ProviderPreflight, ProviderPreset
from autorush.llm.models import CaseCompileRequest, CaseCompileResult
from autorush.llm.presets import PROVIDER_PRESETS
from autorush.llm.service import preflight_provider, test_provider_connection, validate_provider_config
from autorush.runner.engine import Runner
from autorush.storage.sqlite import SqliteStore


class DeviceCommand(BaseModel):
    method: Literal[
        "device.info", "ui.snapshot", "ui.tap_element", "ui.tap", "ui.long_press",
        "ui.swipe", "ui.input_text", "ui.back", "app.launch", "ui.screenshot",
    ]
    params: dict[str, Any] = Field(default_factory=dict)


def create_app(
    settings: Settings | None = None,
    *,
    api_transport: httpx.AsyncBaseTransport | None = None,
    web_driver_factory: Callable[..., Awaitable[Driver]] | None = None,
    desktop_driver_factory: Callable[..., Awaitable[Driver]] | None = None,
    model_client_factory: Callable[..., Any] | None = None,
    event_broker: EventBroker | None = None,
    llm_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = SqliteStore(settings.database_path)
    web_driver_factory = web_driver_factory or PlaywrightWebDriver.create
    desktop_driver_factory = desktop_driver_factory or DesktopProcessDriver.create
    event_broker = event_broker or EventBroker()
    device_hub = DeviceHub()
    pairing_store = PairingStore(settings.database_path)
    operator_token = settings.operator_token
    operator_lock = threading.Lock()
    app = FastAPI(title="AutoRush-AITester", version="0.1.0")
    local_server = LocalDeviceServer(app, settings.database_path.parent / 'device-tls', settings.local_device_port)
    app.state.local_device_server = local_server
    @asynccontextmanager
    async def lifespan(_):
        try:
            await agent_manager.recover_interrupted()
            yield
        finally:
            await agent_manager.close()
            await adb_screen_hub.close()
            await local_server.stop()
    app.router.lifespan_context = lifespan
    app.state.device_hub = device_hub
    screen_hub = ScreenHub()
    app.state.screen_hub = screen_hub
    adb_screen_hub = AdbScreenHub(pairing_store)
    app.state.adb_screen_hub = adb_screen_hub
    async def make_agent_session(plan,cases,run_id):
        if any(step.driver=='desktop' for case in cases for step in case.steps+case.postconditions):
            check_desktop_target(settings,plan)
        return await DriverSession.create(settings,plan,cases,run_id,web_factory=web_driver_factory,
            desktop_factory=desktop_driver_factory,device_hub=device_hub,api_transport=api_transport)
    agent_manager=AgentRunManager(settings,store,make_agent_session,
        model_client_factory or (lambda config,hosts,**kwargs:ModelClient(config,hosts,transport=llm_transport,**kwargs)),event_broker)
    app.state.agent_runs=agent_manager
    browser_origins = {
        f"http://127.0.0.1:{settings.frontend_port}",
        f"http://localhost:{settings.frontend_port}",
    }
    allowed_origins = sorted(browser_origins | {"app://autorush"})
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Autorush-Operator-Token"],
    )

    @app.middleware("http")
    async def do_not_cache_device_credentials(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/api/v1/devices", "/api/v1/automation", "/api/v1/providers")) or '/agent-runs' in request.url.path:
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def pairing_validation_error(request: Request, exc: RequestValidationError):
        # FastAPI's default validation payload includes raw request values.
        if request.url.path.startswith("/api/v1/devices/pairings"):
            return JSONResponse(status_code=422, content={"detail": "invalid pairing request"})
        return await request_validation_exception_handler(request, exc)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    def require_operator(token: str | None) -> None:
        if len(operator_token) < 32:
            raise HTTPException(503, "Android operator bridge is not configured")
        if token is None or not hmac.compare_digest(token.encode(), operator_token.encode()):
            raise HTTPException(403, "invalid operator token")

    def trusted_local_request(request: Request) -> bool:
        if request.client is None:
            return False
        try:
            if not ipaddress.ip_address(request.client.host).is_loopback:
                return False
            host_values = request.headers.getlist("host")
            if len(host_values) != 1 or any(character.isspace() for character in host_values[0]):
                return False
            host = urlsplit("//" + host_values[0])
            if host.username is not None or host.password is not None or host.path or host.query or host.fragment:
                return False
            _ = host.port
            hostname = host.hostname or ""
            if hostname != "localhost" and not ipaddress.ip_address(hostname).is_loopback:
                return False
        except ValueError:
            return False
        origin = request.headers.get("origin")
        if origin is not None:
            return origin in allowed_origins
        return (request.headers.get("sec-fetch-site") == "same-origin"
                and request.headers.get("sec-fetch-mode") == "cors")

    @app.get("/api/v1/devices/operator-session")
    def operator_session(request: Request) -> dict[str, Any]:
        nonlocal operator_token
        if not trusted_local_request(request):
            raise HTTPException(403, "operator bootstrap requires a trusted local browser")
        with operator_lock:
            if len(operator_token) < 32:
                operator_token = secrets.token_urlsafe(32)
        result: dict[str, Any] = {"operator_token": operator_token,
                                 "usb_server_url": f"ws://127.0.0.1:{settings.backend_port}/api/v1/devices/ws",
                                 "adb_devices": []}
        try:
            result["adb_devices"] = adb.list_devices()
        except adb.AdbError as exc:
            result["adb_error"] = str(exc)
        return result

    def public_server_info(info: dict) -> dict:
        return {key: value for key, value in info.items() if key != 'certificate_path'}

    @app.get('/api/v1/devices/local-server')
    def local_server_status(x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        return public_server_info(local_server.status())

    @app.post('/api/v1/devices/local-server/start')
    async def start_local_server(request: Request, x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        if request.client is None or not ipaddress.ip_address(request.client.host).is_loopback:
            raise HTTPException(403, 'start the listener from the local console')
        try:
            return public_server_info(await local_server.start())
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post('/api/v1/devices/local-server/stop')
    async def stop_local_server(x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        return public_server_info(await local_server.stop())

    @app.post("/api/v1/devices/pairings", status_code=201)
    def create_pairing(payload: PairingCreate, x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        try:
            if payload.connection == 'lan':
                info = local_server.status()
                if not info['running']:
                    raise ValueError('Start the local WSS device server before creating a Wi-Fi pairing')
                return pairing_store.create(info['server_url'], payload.allowed_packages, payload.expires_in, info['tls_sha256'])
            if payload.connection == "usb":
                adb.reverse(payload.adb_serial, settings.backend_port)
                server_url = f"ws://127.0.0.1:{settings.backend_port}/api/v1/devices/ws"
            else:
                server_url = validate_wss_url(payload.server_url)
            return pairing_store.create(server_url, payload.allowed_packages, payload.expires_in)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/v1/devices/pairings/{pairing_id}")
    def get_pairing(pairing_id: UUID, x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        result = pairing_store.get(pairing_id)
        if result is None:
            raise HTTPException(404, "pairing not found")
        return result

    @app.post("/api/v1/devices/pairings/{pairing_id}/cancel")
    def cancel_pairing(pairing_id: UUID, x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        result = pairing_store.cancel(pairing_id)
        if result is None:
            raise HTTPException(404, "pairing not found")
        return result

    @app.post("/api/v1/devices/pairings/claim")
    async def claim_pairing(payload: PairingClaim) -> dict:
        result = pairing_store.claim(payload)
        if result is None:
            raise HTTPException(403, "invalid or unavailable pairing code")
        adb_screen_hub.revoke(payload.device_id)
        await device_hub.disconnect(payload.device_id)
        return result

    @app.get("/api/v1/devices/paired")
    def list_paired_devices(x_autorush_operator_token: str | None = Header(default=None)) -> list[dict]:
        require_operator(x_autorush_operator_token)
        online = set(device_hub.list_devices())
        return [{**device, "online": device["device_id"] in online} for device in pairing_store.list_devices()]

    @app.post("/api/v1/devices/paired/{device_id}/revoke")
    async def revoke_paired_device(device_id: UUID, x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        if not pairing_store.revoke(device_id):
            raise HTTPException(404, "paired device not found")
        adb_screen_hub.revoke(device_id)
        await device_hub.disconnect(device_id)
        return {"device_id": str(device_id), "revoked": True}

    @app.websocket("/api/v1/devices/ws")
    async def device_stream(websocket: WebSocket) -> None:
        supplied = websocket.headers.get("authorization", "")
        expected = f"Bearer {settings.portal_token}"
        raw_token = supplied[7:] if supplied.startswith("Bearer ") else ""
        bound_device_id = pairing_store.authenticate(raw_token) if raw_token else None
        legacy = len(settings.portal_token) >= 32 and hmac.compare_digest(supplied.encode(), expected.encode())
        if bound_device_id is None and not legacy:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        session = None
        try:
            raw_hello = await asyncio.wait_for(websocket.receive_text(), timeout=5)
            if len(raw_hello) > 4096:
                await websocket.close(code=1009)
                return
            hello = json.loads(raw_hello)
            if not isinstance(hello, dict) or hello.get("type") != "hello" or hello.get("protocol") != 1:
                await websocket.close(code=1008)
                return
            if not isinstance(hello.get("device_id"), str):
                await websocket.close(code=1008)
                return
            device_id = UUID(hello["device_id"])
            # Recheck after receiving hello: revocation or rotation may have
            # happened while this client was waiting to identify itself.
            if bound_device_id is not None:
                if device_id != bound_device_id or pairing_store.authenticate(raw_token) != device_id:
                    await websocket.close(code=1008)
                    return
            elif pairing_store.has_device(device_id):
                await websocket.close(code=1008)
                return
            session = device_hub.register(device_id, websocket)
            await websocket.send_json({"type": "hello.ack", "protocol": 1})
            while True:
                incoming = await websocket.receive()
                if incoming['type'] == 'websocket.disconnect':
                    break
                if incoming.get('bytes') is not None:
                    screen_hub.frame(session, incoming['bytes'])
                    continue
                raw = incoming.get('text', '')
                if len(raw) > 2_000_000:
                    await websocket.close(code=1009)
                    return
                message = json.loads(raw)
                if isinstance(message, dict):
                    if message.get('type') == 'screen.status':
                        screen_hub.status(session, message)
                    else:
                        device_hub.response(session, message)
        except WebSocketDisconnect:
            pass
        except DeviceAlreadyConnectedError:
            # The Portal retries 4009 with backoff; 1008 remains a pairing/protocol rejection.
            await websocket.close(code=4009, reason="device already connected; retry")
        except (asyncio.TimeoutError, ValueError, KeyError, json.JSONDecodeError):
            try:
                await websocket.close(code=1008)
            except RuntimeError:
                pass
        finally:
            if session is not None:
                screen_hub.disconnected(session)
                device_hub.unregister(session)

    @app.get('/api/v1/devices/adb')
    def adb_devices(x_autorush_operator_token: str | None = Header(default=None)) -> dict:
        require_operator(x_autorush_operator_token)
        try:
            return {'devices': adb.list_devices()}
        except adb.AdbError as exc:
            return {'devices': [], 'error': str(exc)}

    @app.websocket('/api/v1/devices/adb/screen/ws')
    async def adb_screen_view(websocket: WebSocket):
        await serve_adb_viewer(websocket, adb_screen_hub, require_operator, allowed_origins)

    @app.websocket('/api/v1/devices/{device_id}/screen/ws')
    async def screen_view(websocket: WebSocket, device_id: UUID):
        await serve_viewer(websocket, device_id, device_hub, screen_hub, require_operator, allowed_origins)

    @app.get("/api/v1/devices")
    def list_android_devices(x_autorush_operator_token: str | None = Header(default=None)) -> dict[str, list[str]]:
        require_operator(x_autorush_operator_token)
        return {"devices": device_hub.list_devices()}

    @app.post("/api/v1/devices/{device_id}/commands")
    async def command_android_device(
        device_id: UUID, payload: DeviceCommand, x_autorush_operator_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        require_operator(x_autorush_operator_token)
        if len(json.dumps(payload.params, ensure_ascii=False)) > 12_000:
            raise HTTPException(422, "device command parameters are too large")
        try:
            return await device_hub.call(device_id, payload.method, payload.params)
        except ConnectionError as exc:
            raise HTTPException(409, str(exc)) from exc
        except asyncio.TimeoutError as exc:
            raise HTTPException(504, "device command timed out") from exc
        except RuntimeError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.websocket("/api/v1/events/ws")
    async def event_stream(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        async with event_broker.subscribe() as queue:
            event_task: asyncio.Task[PlatformEvent] | None = None
            receive_task: asyncio.Task[dict] | None = None
            try:
                await websocket.send_json(PlatformEvent(type="stream.ready", payload={}).model_dump(mode="json"))
                while True:
                    event_task = asyncio.create_task(queue.get())
                    receive_task = asyncio.create_task(websocket.receive())
                    done, pending = await asyncio.wait(
                        {event_task, receive_task}, return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    if receive_task in done:
                        if receive_task.result()["type"] == "websocket.disconnect":
                            return
                        if event_task not in done:
                            continue
                    event = event_task.result()
                    await websocket.send_json(event.model_dump(mode="json"))
            except (WebSocketDisconnect, asyncio.CancelledError):
                return
            finally:
                remaining = [task for task in (event_task, receive_task) if task is not None and not task.done()]
                for task in remaining:
                    task.cancel()
                if remaining:
                    await asyncio.gather(*remaining, return_exceptions=True)

    @app.get("/api/v1/providers/presets", response_model=list[ProviderPreset])
    def list_provider_presets() -> list[ProviderPreset]:
        return PROVIDER_PRESETS

    @app.post("/api/v1/providers/configs", response_model=ProviderConfigRecord, status_code=201)
    def create_provider_config(payload: ProviderConfigCreate) -> ProviderConfigRecord:
        try:
            validate_provider_config(payload)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        config = ProviderConfigRecord(**payload.model_dump())
        store.save_provider_config(config)
        return config

    @app.get("/api/v1/providers/configs", response_model=list[ProviderConfigRecord])
    def list_provider_configs() -> list[ProviderConfigRecord]:
        return store.list_provider_configs()

    @app.post("/api/v1/providers/configs/{config_id}/preflight", response_model=ProviderPreflight)
    def preflight_provider_config(config_id: UUID) -> ProviderPreflight:
        config = store.get_provider_config(config_id)
        if config is None:
            raise HTTPException(404, "provider config not found")
        try:
            return preflight_provider(config)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/cases/compile", response_model=CaseCompileResult)
    async def compile_case_draft(payload: CaseCompileRequest) -> CaseCompileResult:
        config = store.get_provider_config(payload.provider_config_id)
        if config is None:
            raise HTTPException(404, "provider config not found")
        try:
            return await compile_case(payload, config, set(settings.allowed_llm_hosts), transport=llm_transport)
        except ModelClientError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/v1/providers/configs/{config_id}/test-connection", response_model=ProviderConnectionTest)
    async def connect_provider_config(config_id: UUID) -> ProviderConnectionTest:
        config = store.get_provider_config(config_id)
        if config is None:
            raise HTTPException(404, "provider config not found")
        try:
            result = await test_provider_connection(
                config, set(settings.allowed_llm_hosts), transport=llm_transport,
            )
            store.set_provider_status(config_id, "verified")
            return result
        except (ValueError, ModelClientError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/v1/cases", response_model=CaseRecord, status_code=201)
    def create_case(payload: CaseCreate) -> CaseRecord:
        case = CaseRecord(**payload.model_dump())
        store.save_case(case)
        return case

    @app.get("/api/v1/cases", response_model=list[CaseRecord])
    def list_cases(include_archived:bool=False) -> list[CaseRecord]:
        return store.list_cases(include_archived=include_archived)

    def authorize_case_change(request,token):
        require_operator(token)
        if not trusted_local_request(request):raise HTTPException(403,'case changes require a trusted local operator')

    @app.put('/api/v1/cases/{case_id}',response_model=CaseRecord)
    def update_case(case_id:UUID,payload:CaseCreate,expected_version:int,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize_case_change(request,x_autorush_operator_token)
        case=store.get_case(case_id)
        if case is None:raise HTTPException(404,'case not found')
        if case.archived_at:raise HTTPException(409,'restore archived case before editing')
        if case.version!=expected_version:raise HTTPException(409,'case version changed; reload before editing')
        if case.status==CaseStatus.APPROVED:
            revised=CaseRecord(**payload.model_dump(),version=case.version+1,source_case_id=case.id)
            store.save_case(revised);return revised
        updated=CaseRecord(**payload.model_dump(),id=case.id,version=case.version+1,created_at=case.created_at,source_case_id=case.source_case_id)
        if not store.replace_case(case,updated):raise HTTPException(409,'case changed; reload before editing')
        return updated

    @app.delete('/api/v1/cases/{case_id}',response_model=CaseRecord)
    def archive_case(case_id:UUID,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize_case_change(request,x_autorush_operator_token)
        case=store.get_case(case_id)
        if case is None:raise HTTPException(404,'case not found')
        if case.archived_at:return case
        updated=case.model_copy(update={'archived_at':datetime.now(timezone.utc)})
        if not store.replace_case(case,updated):raise HTTPException(409,'case changed; reload before deleting')
        return updated

    @app.post('/api/v1/cases/{case_id}/restore',response_model=CaseRecord)
    def restore_case(case_id:UUID,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize_case_change(request,x_autorush_operator_token)
        case=store.get_case(case_id)
        if case is None:raise HTTPException(404,'case not found')
        updated=case.model_copy(update={'archived_at':None})
        if not store.replace_case(case,updated):raise HTTPException(409,'case changed; reload before restoring')
        return updated

    @app.get("/api/v1/cases/{case_id}", response_model=CaseRecord)
    def get_case(case_id: UUID) -> CaseRecord:
        case = store.get_case(case_id)
        if case is None:
            raise HTTPException(404, "case not found")
        return case

    @app.post("/api/v1/cases/{case_id}/approve", response_model=CaseRecord)
    def approve_case(case_id: UUID) -> CaseRecord:
        case = store.get_case(case_id)
        if case is None:
            raise HTTPException(404, "case not found")
        if case.archived_at:raise HTTPException(409,'restore archived case before approving')
        def approve_reviewed_snapshot():
            approved=case.model_copy(update={'status':CaseStatus.APPROVED})
            if not store.replace_case(case,approved):raise HTTPException(409,'case changed; reload before approving')
            return approved
        if case.execution_mode=='agent':
            return approve_reviewed_snapshot()
        for step in case.steps + case.postconditions:
            if not step.operation or not step.operation.startswith(f"{step.driver}."):
                raise HTTPException(409, "all steps need a namespaced compiled operation")
            if step.driver == "android":
                try:
                    validate_android_step(step)
                except ValueError as exc:
                    raise HTTPException(409, str(exc)) from exc
            if step.driver in {'web','desktop'}:
                try: (validate_web_step if step.driver=='web' else validate_desktop_step)(step)
                except ValueError as exc: raise HTTPException(409,str(exc)) from exc
        return approve_reviewed_snapshot()

    @app.post("/api/v1/plans", response_model=PlanRecord, status_code=201)
    def create_plan(payload: PlanCreate) -> PlanRecord:
        if len(set(payload.case_ids)) != len(payload.case_ids):
            raise HTTPException(422, "case_ids must be unique")
        missing = [str(case_id) for case_id in payload.case_ids if store.get_case(case_id) is None]
        if missing:
            raise HTTPException(422, {"missing_cases": missing})
        if any(store.get_case(case_id).archived_at for case_id in payload.case_ids):raise HTTPException(409,'archived cases cannot be added to a new plan')
        plan = PlanRecord(**payload.model_dump())
        store.save_plan(plan)
        return plan

    @app.get("/api/v1/plans", response_model=list[PlanRecord])
    def list_plans() -> list[PlanRecord]:
        return store.list_plans()

    @app.get("/api/v1/plans/{plan_id}", response_model=PlanRecord)
    def get_plan(plan_id: UUID) -> PlanRecord:
        plan = store.get_plan(plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        return plan

    @app.post("/api/v1/plans/{plan_id}/ready", response_model=PlanRecord)
    def ready_plan(plan_id: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)) -> PlanRecord:
        plan = store.get_plan(plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        cases = [store.get_case(case_id) for case_id in plan.case_ids]
        if any(case is None or case.status != CaseStatus.APPROVED for case in cases):
            raise HTTPException(409, "all referenced cases must be approved")
        all_steps = [step for case in cases if case for step in case.steps + case.postconditions]
        if any(step.driver == "desktop" for step in all_steps):
            if not settings.desktop_enabled:
                check_desktop_target(settings,plan)
            require_operator(x_autorush_operator_token)
            if not trusted_local_request(request): raise HTTPException(403,'desktop requires a trusted local browser')
            check_desktop_target(settings,plan)
        if any(case.execution_mode=='agent' for case in cases if case):
            try: validate_agent_configuration(settings,store,plan,cases)
            except ValueError as exc: raise HTTPException(409,str(exc)) from exc
        compiled_steps=[step for case in cases if case and case.execution_mode=='structured' for step in case.steps+case.postconditions]
        for step in compiled_steps:
            if step.driver in {'web','desktop'}:
                try: (validate_web_step if step.driver=='web' else validate_desktop_step)(step)
                except ValueError as exc: raise HTTPException(409,str(exc)) from exc
        if any(step.driver == "android" for step in all_steps):
            require_operator(x_autorush_operator_token)
            if not plan.android_device_id or not plan.android_package:
                raise HTTPException(409, "Android cases require android_device_id and android_package")
            if str(plan.android_device_id) not in device_hub.list_devices():
                raise HTTPException(409, "Android device is offline")
        if any(step.driver == "api" for step in all_steps) and not plan.api_base_url:
            raise HTTPException(409, "API cases require api_base_url")
        if any(step.driver == "web" for step in all_steps) and not plan.web_base_url:
            raise HTTPException(409, "Web cases require web_base_url")
        return store.set_plan_status(plan_id, PlanStatus.READY)  # type: ignore[return-value]

    @app.post("/api/v1/plans/{plan_id}/runs", response_model=RunRecord, status_code=201)
    async def run_plan(plan_id: UUID, request: Request, x_autorush_operator_token: str | None = Header(default=None)) -> RunRecord:
        plan = store.get_plan(plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        if plan.status != PlanStatus.READY:
            raise HTTPException(409, "plan is not ready")
        cases = [store.get_case(case_id) for case_id in plan.case_ids]
        if any(case is None for case in cases):
            raise HTTPException(409, "plan references a missing case")
        if any(case.execution_mode=='agent' for case in cases):
            raise HTTPException(409,'natural cases require the agent-runs endpoint')
        if any(case.status != CaseStatus.APPROVED for case in cases if case):
            raise HTTPException(409, "plan references an unapproved case")
        all_steps = [step for case in cases if case for step in case.steps + case.postconditions]
        needs_android = any(step.driver == "android" for step in all_steps)
        needs_desktop = any(step.driver=='desktop' for step in all_steps)
        if needs_desktop:
            require_operator(x_autorush_operator_token)
            if not trusted_local_request(request): raise HTTPException(403,'desktop requires a trusted local browser')
            check_desktop_target(settings,plan)
        for step in all_steps:
            if step.driver in {'web','desktop'}:
                try: (validate_web_step if step.driver=='web' else validate_desktop_step)(step)
                except ValueError as exc: raise HTTPException(409,str(exc)) from exc
        if needs_android:
            require_operator(x_autorush_operator_token)
            if not plan.android_device_id or not plan.android_package:
                raise HTTPException(409, "Android target is not configured")
        run_id = uuid4()
        try:
            session = await DriverSession.create(settings,plan,cases,run_id,web_factory=web_driver_factory,
                desktop_factory=desktop_driver_factory,device_hub=device_hub,api_transport=api_transport)
        except (ValueError,PermissionError,RuntimeError,ConnectionError) as exc:
            raise HTTPException(409,str(exc)) from exc
        drivers = session.drivers
        runner = Runner(drivers)
        try:
            await event_broker.publish(PlatformEvent(type="run.started", payload={
                "run_id": str(run_id), "plan_id": str(plan.id), "case_count": len(cases),
            }))
            results = []
            for index, case in enumerate(cases, start=1):
                assert case is not None
                case_result = await runner.run_case(case)
                results.append(case_result)
                await event_broker.publish(PlatformEvent(type="case.completed", payload={
                    "run_id": str(run_id), "plan_id": str(plan.id), "case_id": str(case.id),
                    "status": case_result.status.value, "completed": index, "total": len(cases),
                }))
        finally:
            with anyio.CancelScope(shield=True):
                await asyncio.shield(session.close())
        status = next(
            (candidate for candidate in (ResultStatus.ERROR, ResultStatus.FAILED, ResultStatus.BLOCKED)
             if any(item.status == candidate for item in results)),
            ResultStatus.PASSED,
        )
        run = RunRecord(id=run_id, plan_id=plan.id, status=status, cases=results)
        report_paths = save_reports(run, settings.report_dir)
        serialized_paths = {name: str(path) for name, path in report_paths.items()}
        run = run.model_copy(update={"report_path": serialized_paths["json"], "report_paths": serialized_paths})
        store.save_run(run)
        await event_broker.publish(PlatformEvent(type="report.ready", payload={
            "run_id": str(run.id),
            "plan_id": str(run.plan_id),
            "status": run.status.value,
            "report_url": f"/api/v1/runs/{run.id}/report",
        }))
        return run

    @app.get("/api/v1/runs/{run_id}", response_model=RunRecord)
    def get_run(run_id: UUID) -> RunRecord:
        run = store.get_run(run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        return run

    @app.get("/api/v1/runs", response_model=list[RunRecord])
    def list_runs() -> list[RunRecord]:
        return store.list_runs()

    @app.get("/api/v1/runs/{run_id}/report")
    def get_report(run_id: UUID) -> FileResponse:
        run = store.get_run(run_id)
        if run is None or not run.report_path:
            raise HTTPException(404, "report not found")
        return FileResponse(run.report_path, media_type="application/json", filename=f"{run_id}.json")

    @app.get("/api/v1/runs/{run_id}/evidence/{filename}")
    def get_screenshot(run_id: UUID, filename: str, x_autorush_operator_token: str | None = Header(default=None)) -> Response:
        require_operator(x_autorush_operator_token)
        run = store.get_run(run_id)
        if run is None:
            execution=agent_manager.get(run_id)
            if execution and execution.state in {'running','stopping'}:
                completed=[CaseResult.model_validate(item) for item in execution.progress.get('completed_cases',[])]
                run=RunRecord(id=run_id,plan_id=execution.plan_id,status=ResultStatus.BLOCKED,
                    cases=agent_manager.interrupted_results(execution,completed,'live evidence snapshot'))
        relative = f"{run_id}/{filename}"
        metadata = next((meta for meta in iter_run_screenshots(run) if meta.get('file') == relative), None) if run else None
        if metadata is None:
            raise HTTPException(404, "screenshot evidence not found")
        try:
            path = evidence_path(settings.report_dir, run_id, relative)
        except ValueError as exc:
            raise HTTPException(404, "screenshot evidence not found") from exc
        if not path.is_file():
            raise HTTPException(404, "screenshot evidence not found")
        try:
            with path.open('rb') as source:
                jpeg = source.read(1_000_001)
        except OSError as exc:
            raise HTTPException(404, "screenshot evidence not found") from exc
        if len(jpeg) > 1_000_000 or len(jpeg) != metadata.get('bytes') or hashlib.sha256(jpeg).hexdigest() != metadata.get('sha256'):
            raise HTTPException(409, "screenshot evidence checksum or size mismatch")
        return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/runs/{run_id}/report/{report_format}")
    def get_formatted_report(run_id: UUID, report_format: str, x_autorush_operator_token: str | None = Header(default=None)) -> FileResponse:
        run = store.get_run(run_id)
        if run is None or report_format not in {"json", "html", "junit"}:
            raise HTTPException(404, "report not found")
        if report_format == 'html' and next(iter_run_screenshots(run),None) is not None:
            require_operator(x_autorush_operator_token)
        path = run.report_paths.get(report_format)
        if not path:
            raise HTTPException(404, "report format not found")
        media_types = {"json": "application/json", "html": "text/html", "junit": "application/xml"}
        suffixes = {"json": "json", "html": "html", "junit": "xml"}
        return FileResponse(path, media_type=media_types[report_format], filename=f"{run_id}.{suffixes[report_format]}")

    from autorush.api.api_testing import create_api_testing_router
    app.include_router(create_api_testing_router(settings,require_operator,trusted_local_request))
    app.include_router(create_automation_router(settings,require_operator,trusted_local_request))
    app.include_router(create_model_catalog_router(settings,store,require_operator,trusted_local_request))
    app.include_router(create_agent_run_router(agent_manager,settings,store,device_hub,require_operator,trusted_local_request))
    return app


app = create_app()
