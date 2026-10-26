"""Local-only execution discovery and target preflight."""
import asyncio
import importlib.util
import sys
from fastapi import APIRouter, Header, HTTPException, Request
from autorush.drivers.desktop.win32 import WindowGuard, list_windows
from autorush.drivers.base import DriverBlockedError


def check_desktop_target(settings,plan):
    if not settings.desktop_enabled:
        raise HTTPException(409,'desktop requires a trusted agent on the local machine; start with -DesktopAutomation')
    if plan.desktop_target is None or not plan.capture_screenshots:
        raise HTTPException(409,'desktop requires desktop_target and screenshot evidence')
    try: WindowGuard(plan.desktop_target).check(foreground=False)
    except (DriverBlockedError,ValueError) as exc: raise HTTPException(409,str(exc)) from exc


def create_automation_router(settings,require_operator,trusted_local_request):
    router=APIRouter(prefix='/api/v1/automation')
    def authorize(request,token):
        require_operator(token)
        if not trusted_local_request(request): raise HTTPException(403,'desktop requires a trusted local browser')

    @router.get('/capabilities')
    async def capabilities(request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        installed={name:importlib.util.find_spec(name) is not None for name in ('playwright','pyautogui','PIL')}
        usable=sys.platform=='win32' and installed['pyautogui'] and installed['PIL']
        return {'web':{'available':installed['playwright'] and installed['PIL'],'browser':'chromium'},
            'desktop':{'enabled':settings.desktop_enabled,'available':bool(settings.desktop_enabled and usable),
                'reason':None if settings.desktop_enabled and usable else 'Enable -DesktopAutomation on Windows and install backend[desktop]',
                'primary_monitor_only':True},'dependencies':installed}

    @router.get('/desktop/windows')
    async def windows(request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        if not settings.desktop_enabled: raise HTTPException(409,'desktop automation is not enabled')
        try: return {'windows':[item.model_dump() for item in await asyncio.to_thread(list_windows)]}
        except (DriverBlockedError,ValueError) as exc: raise HTTPException(409,str(exc)) from exc
    return router
