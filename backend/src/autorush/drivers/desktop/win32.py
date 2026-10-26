"""Windows target identity, physical client coordinates and balanced allowed hotkeys."""
from __future__ import annotations
import ctypes as c
import sys
from ctypes import wintypes as w
from autorush.domain.models import DesktopTarget
from autorush.drivers.base import DriverBlockedError


class KeyboardInput(c.Structure):
    _fields_=[('wVk',w.WORD),('wScan',w.WORD),('dwFlags',w.DWORD),('time',w.DWORD),('dwExtraInfo',w.WPARAM)]
class MouseInput(c.Structure):
    _fields_=[('dx',w.LONG),('dy',w.LONG),('mouseData',w.DWORD),('dwFlags',w.DWORD),('time',w.DWORD),('dwExtraInfo',w.WPARAM)]
class InputData(c.Union):
    _fields_=[('ki',KeyboardInput),('mi',MouseInput)]
class Input(c.Structure):
    _anonymous_=('data',)
    _fields_=[('type',w.DWORD),('data',InputData)]


class WindowsApi:
    def __init__(self):
        if sys.platform != 'win32': raise DriverBlockedError('desktop automation requires Windows')
        self.u=c.WinDLL('user32',use_last_error=True)
        self.k=c.WinDLL('kernel32',use_last_error=True)
        definitions={'GetForegroundWindow':([],w.HWND),'GetWindow':([w.HWND,w.UINT],w.HWND),
            'GetAncestor':([w.HWND,w.UINT],w.HWND),'WindowFromPoint':([w.POINT],w.HWND),
            'GetClientRect':([w.HWND,c.POINTER(w.RECT)],w.BOOL), 'GetWindowRect':([w.HWND,c.POINTER(w.RECT)],w.BOOL),
            'ClientToScreen':([w.HWND,c.POINTER(w.POINT)],w.BOOL), 'IsWindowVisible':([w.HWND],w.BOOL),
            'IsIconic':([w.HWND],w.BOOL),'IsWindow':([w.HWND],w.BOOL),
            'GetWindowTextLengthW':([w.HWND],c.c_int),'GetWindowTextW':([w.HWND,w.LPWSTR,c.c_int],c.c_int),
            'GetClassNameW':([w.HWND,w.LPWSTR,c.c_int],c.c_int),
            'GetWindowThreadProcessId':([w.HWND,c.POINTER(w.DWORD)],w.DWORD), 'GetSystemMetrics':([c.c_int],c.c_int)}
        for name,(args,result) in definitions.items():
            fn=getattr(self.u,name);fn.argtypes=args;fn.restype=result
        self.k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];self.k.OpenProcess.restype=w.HANDLE
        self.k.CloseHandle.argtypes=[w.HANDLE];self.k.CloseHandle.restype=w.BOOL
        self.k.GetProcessTimes.argtypes=[w.HANDLE,*([c.POINTER(w.FILETIME)]*4)];self.k.GetProcessTimes.restype=w.BOOL
        try:
            self.u.SetThreadDpiAwarenessContext.argtypes=[c.c_void_p];self.u.SetThreadDpiAwarenessContext.restype=c.c_void_p
            self.u.SetThreadDpiAwarenessContext(c.c_void_p(-4))
        except AttributeError: self.u.SetProcessDPIAware()

    def identity(self, hwnd):
        if not self.u.IsWindow(hwnd): raise DriverBlockedError('target window no longer exists')
        pid=w.DWORD();self.u.GetWindowThreadProcessId(hwnd,c.byref(pid))
        process=self.k.OpenProcess(0x1000,False,pid.value)
        if not process: raise DriverBlockedError('cannot inspect target process')
        try:
            times=[w.FILETIME() for _ in range(4)]
            if not self.k.GetProcessTimes(process,*(c.byref(t) for t in times)):
                raise DriverBlockedError('cannot identify target process')
        finally: self.k.CloseHandle(process)
        size=self.u.GetWindowTextLengthW(hwnd)
        title=c.create_unicode_buffer(size+1);self.u.GetWindowTextW(hwnd,title,size+1)
        return DesktopTarget(hwnd=hwnd,pid=pid.value,process_started_at=str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime),
            title=title.value,screen_width=self.u.GetSystemMetrics(0),screen_height=self.u.GetSystemMetrics(1))

    def describe(self, hwnd):
        target=self.identity(hwnd)
        rect=w.RECT();point=w.POINT(0,0)
        if not self.u.GetClientRect(hwnd,c.byref(rect)) or not self.u.ClientToScreen(hwnd,c.byref(point)):
            raise DriverBlockedError('cannot inspect target client area')
        area=(point.x,point.y,rect.right,rect.bottom)
        occluded=False;occluder=None;occluder_class=None
        previous=self.u.GetWindow(hwnd,3)  # GW_HWNDPREV: higher windows only.
        seen=set()
        while previous and previous not in seen:
            seen.add(previous)
            if self.u.IsWindowVisible(previous) and not self.u.IsIconic(previous):
                r=w.RECT()
                if self.u.GetWindowRect(previous,c.byref(r)) and r.left < point.x+rect.right and r.right > point.x and r.top < point.y+rect.bottom and r.bottom > point.y:
                    occluded=True;occluder=int(previous)
                    name=c.create_unicode_buffer(256);self.u.GetClassNameW(previous,name,256);occluder_class=name.value
                    break
            previous=self.u.GetWindow(previous,3)
        return {'target':target,'rect':area,'foreground':self.u.GetForegroundWindow(),
                'usable':bool(self.u.IsWindowVisible(hwnd) and not self.u.IsIconic(hwnd)), 'occluded':occluded,'occluder':occluder,'occluder_class':occluder_class}

    def root_at(self,x,y): return self.u.GetAncestor(self.u.WindowFromPoint(w.POINT(x,y)),2)

    def hotkey(self,keys):
        from autorush.drivers.desktop.contracts import HOTKEYS
        if tuple(keys) not in HOTKEYS: raise ValueError('unsupported native hotkey')
        codes={'ctrl':17,'shift':16,'a':65,'tab':9,'enter':13,'esc':27,'backspace':8,'delete':46,
               'home':36,'end':35,'left':37,'right':39,'up':38,'down':40}
        def event(key,up):
            extended=1 if key in {'delete','home','end','left','right','up','down'} else 0
            return Input(type=1,data=InputData(ki=KeyboardInput(wVk=codes[key],dwFlags=extended|(2 if up else 0))))
        events=[event(key,False) for key in keys]+[event(key,True) for key in reversed(keys)]
        self.u.SendInput.argtypes=[w.UINT,c.POINTER(Input),c.c_int];self.u.SendInput.restype=w.UINT
        batch=(Input*len(events))(*events)
        if self.u.SendInput(len(events),batch,c.sizeof(Input)) != len(events):
            release=(Input*len(keys))(*(event(key,True) for key in reversed(keys)))
            self.u.SendInput(len(keys),release,c.sizeof(Input))
            raise DriverBlockedError('Windows refused the complete keyboard batch')

    def windows(self):
        result=[]
        callback_type=c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
        def visit(hwnd,_):
            if self.u.IsWindowVisible(hwnd) and not self.u.IsIconic(hwnd):
                try:
                    target=self.identity(hwnd)
                    WindowGuard(target,api=self).check(foreground=False)
                    result.append(target)
                except (ValueError,DriverBlockedError): pass
            return True
        self.u.EnumWindows.argtypes=[callback_type,w.LPARAM];self.u.EnumWindows.restype=w.BOOL
        self.u.EnumWindows(callback_type(visit),0)
        return result[:200]


class WindowGuard:
    def __init__(self,target:DesktopTarget,*,api=None):
        self.target=target;self.api=api or WindowsApi()

    def check(self,*,foreground=True):
        info=self.api.describe(self.target.hwnd)
        if info['target'] != self.target: raise DriverBlockedError('desktop target identity or screen resolution changed')
        x,y,width,height=info['rect']
        if not info['usable'] or width<=0 or height<=0 or x<0 or y<0 or x+width>self.target.screen_width or y+height>self.target.screen_height:
            raise DriverBlockedError('target must be visible and entirely on the primary monitor')
        if foreground and info['foreground'] != self.target.hwnd:
            raise DriverBlockedError(f"target window lost focus (foreground HWND {info['foreground']})")
        if foreground and info['occluded']:
            raise DriverBlockedError(f"target window is covered (HWND {info.get('occluder')}, class {info.get('occluder_class')})")
        return x,y,width,height

    def screen_point(self,x,y):
        left,top,width,height=self.check()
        if type(x) is not int or type(y) is not int or not 0<=x<width or not 0<=y<height:
            raise ValueError('desktop coordinates are outside the target client area')
        point=(left+x,top+y)
        if self.api.root_at(*point) != self.target.hwnd: raise DriverBlockedError('another window covers the target point')
        if point[0] in {0,self.target.screen_width-1} and point[1] in {0,self.target.screen_height-1}:
            raise ValueError('cannot target fail-safe corners')
        return point


def list_windows(): return WindowsApi().windows()
