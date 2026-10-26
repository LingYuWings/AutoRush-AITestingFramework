"""Private, bounded stdio desktop worker. Never a network service."""
from __future__ import annotations
import asyncio
import base64
import ctypes as c
from ctypes import wintypes as w
import json
import os
import sys
import time
from autorush.domain.models import DesktopTarget, StepSpec
from autorush.drivers.base import DriverBlockedError


class SessionLease:
    def __init__(self):
        if sys.platform!='win32': raise DriverBlockedError('desktop requires Windows')
        self.k=c.WinDLL('kernel32',use_last_error=True)
        self.k.CreateMutexW.argtypes=[c.c_void_p,w.BOOL,w.LPCWSTR];self.k.CreateMutexW.restype=w.HANDLE
        self.k.CloseHandle.argtypes=[w.HANDLE];self.k.CloseHandle.restype=w.BOOL
        session=w.DWORD()
        if not self.k.ProcessIdToSessionId(os.getpid(),c.byref(session)): raise DriverBlockedError('cannot identify desktop session')
        self.handle=self.k.CreateMutexW(None,False,f'Local\\AutoRushDesktop-v1-{session.value}')
        if not self.handle: raise DriverBlockedError('cannot acquire desktop lease')
        if c.get_last_error()==183:
            self.close();raise DriverBlockedError('another desktop worker owns this Windows session')
    def close(self):
        if self.handle: self.k.CloseHandle(self.handle);self.handle=None


def main():
    driver=None;lease=None
    try:
        while True:
            line=sys.stdin.buffer.readline(65537)
            if not line: break
            request=None;stop=False
            try:
                if len(line)>65536 or not line.endswith(b'\n'): raise ValueError('worker request exceeds limit')
                request=json.loads(line)
                if not isinstance(request,dict) or set(request)!={'id','type','payload'} or type(request['id']) is not int or not isinstance(request['payload'],dict):
                    raise ValueError('invalid worker envelope')
                kind=request['type'];payload=request['payload']
                if kind=='close': result={};stop=True
                elif kind=='init':
                    if driver is not None: raise ValueError('worker already initialized')
                    target=DesktopTarget.model_validate(payload)
                    from autorush.drivers.desktop.pyautogui import PyAutoGuiDesktopDriver
                    lease=SessionLease()
                    driver=PyAutoGuiDesktopDriver.from_system(target=target)
                    driver._guard.check(foreground=False)
                    result={'worker_pid':os.getpid()}
                elif kind=='execute' and driver is not None:
                    result=asyncio.run(driver.execute(StepSpec.model_validate(payload)))
                    result={'output':result.output,'summary':result.summary,'evidence':result.evidence}
                elif kind=='capture' and driver is not None:
                    from autorush.evidence.images import encode_jpeg
                    data,width,height=encode_jpeg(driver.capture_image())
                    result={'data_base64':base64.b64encode(data).decode('ascii'),'width':width,'height':height,'captured_at':int(time.time()*1000)}
                elif kind=='observe' and driver is not None:
                    from autorush.agent.observers import fingerprint
                    driver._preflight()
                    rect=driver._guard.check()
                    target=driver._guard.target.model_dump()
                    result={'target':target,'geometry':list(rect[2:]),'text':target['title'],
                            'fingerprint':fingerprint([target,rect])}
                else: raise ValueError('unknown worker command or missing initialization')
                response={'id':request['id'],'ok':True,'result':result}
            except Exception as exc:
                response={'id':request.get('id') if isinstance(request,dict) else None,'ok':False,
                    'error':{'kind':'blocked' if isinstance(exc,DriverBlockedError) else 'validation' if isinstance(exc,ValueError) else 'runtime',
                             'message':str(exc)[:1000]}}
                if len(line)>65536: stop=True
            encoded=json.dumps(response,separators=(',',':')).encode()+b'\n'
            if len(encoded)>1_500_000: raise ValueError('worker response exceeds limit')
            sys.stdout.buffer.write(encoded);sys.stdout.buffer.flush()
            if stop: break
    finally:
        if driver is not None: asyncio.run(driver.close())
        if lease is not None: lease.close()


if __name__=='__main__': main()
