"""Async controller for this server's own desktop worker only."""
from __future__ import annotations
import asyncio
import base64
import json
import os
import subprocess
import sys
from autorush.drivers.base import ActionResult, DriverBlockedError
from autorush.drivers.desktop.contracts import validate_desktop_step
from autorush.evidence.images import record_local_image


class DesktopProcessDriver:
    def __init__(self,process,target,evidence_directory,run_id,*,capture_screenshots=True):
        self.process=process;self.target=target;self.directory=evidence_directory;self.run_id=run_id
        self.capture=capture_screenshots;self._lock=asyncio.Lock();self._id=0;self._closed=False

    @classmethod
    async def create(cls,target,*,capture_screenshots,evidence_directory,run_id,start_delay_seconds=3):
        env=dict(os.environ)
        env['PYTHONPATH']=os.pathsep.join(p for p in sys.path if p)
        spawning=asyncio.create_task(asyncio.create_subprocess_exec(getattr(sys,'_base_executable',sys.executable),
            '-m','autorush.drivers.desktop.worker',stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,limit=1_500_000,env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0))
        driver=None
        try:
            process=await asyncio.shield(spawning)
            driver=cls(process,target,evidence_directory,run_id,capture_screenshots=capture_screenshots)
            await driver._request('init',target.model_dump(),timeout=10)
            await asyncio.sleep(start_delay_seconds)
            return driver
        except BaseException:
            if driver is None:
                process=await spawning
                driver=cls(process,target,evidence_directory,run_id)
            await asyncio.shield(driver._terminate())
            raise

    async def _request(self,kind,payload,*,timeout=20):
        async with self._lock:
            if self._closed: raise DriverBlockedError('desktop worker is closed')
            self._id+=1
            data=json.dumps({'id':self._id,'type':kind,'payload':payload},separators=(',',':')).encode()+b'\n'
            if len(data)>65536: raise ValueError('desktop request exceeds limit')
            async def exchange():
                self.process.stdin.write(data);await self.process.stdin.drain()
                line=await self.process.stdout.readline()
                if not line or len(line)>1_500_000: raise DriverBlockedError('desktop worker disconnected or oversized response')
                response=json.loads(line)
                if response.get('id')!=self._id: raise DriverBlockedError('desktop worker response ID mismatch')
                if response.get('ok') is not True:
                    error=response.get('error',{})
                    error_type=DriverBlockedError if error.get('kind')=='blocked' else ValueError if error.get('kind')=='validation' else RuntimeError
                    raise error_type(error.get('message','desktop worker failed'))
                return response['result']
            try: return await asyncio.wait_for(exchange(),timeout)
            except (asyncio.TimeoutError,asyncio.CancelledError,ConnectionError, json.JSONDecodeError) as exc:
                await asyncio.shield(self._terminate())
                if isinstance(exc,asyncio.CancelledError): raise
                raise DriverBlockedError('desktop worker timed out or disconnected; stopped') from exc

    async def execute(self,step):
        validate_desktop_step(step)
        result=await self._request('execute',step.model_dump(mode='json'))
        return ActionResult(**result)

    async def observe(self):
        return await self._request('observe',{},timeout=5)

    async def capture_evidence(self):
        if not self.capture: return {}
        result=await self._request('capture',{},timeout=5)
        data=base64.b64decode(result['data_base64'],validate=True)
        return {'screenshot':record_local_image(data,report_dir=self.directory,run_id=self.run_id,driver='desktop',
            target=self.target.model_dump(),width=result['width'],height=result['height'],captured_at=result['captured_at'])}

    async def _terminate(self):
        if self._closed: return
        self._closed=True
        if self.process.stdin: self.process.stdin.close()
        if self.process.returncode is None:
            # Force completion after a bounded grace period; never target other PIDs.
            try: await asyncio.wait_for(self.process.wait(),0.5)
            except asyncio.TimeoutError:
                self.process.kill();await asyncio.wait_for(self.process.wait(),2)
            # A test double may report wait completion while still alive.
            if self.process.returncode is None:
                self.process.kill();await asyncio.wait_for(self.process.wait(),2)

    async def close(self):
        if self._closed: return
        try: await self._request('close',{},timeout=2)
        except Exception: pass
        finally: await self._terminate()
