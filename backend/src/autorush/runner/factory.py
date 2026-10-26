"""Own a complete driver set, including partially initialized cancellation cleanup."""
import asyncio
from uuid import UUID
from autorush.drivers.android.portal import AndroidPortalDriver
from autorush.drivers.api.http import HttpApiDriver
from autorush.runner.engine import Runner


class DriverSession:
    def __init__(self,drivers): self.drivers=drivers;self._closed=False

    @classmethod
    async def create(cls,settings,plan,case_snapshots,run_id:UUID,*,web_factory,desktop_factory,device_hub,api_transport=None):
        kinds={step.driver for case in case_snapshots for step in case.steps+case.postconditions}
        drivers={}
        try:
            if 'desktop' in kinds:
                drivers['desktop']=await desktop_factory(plan.desktop_target,capture_screenshots=True,evidence_directory=settings.report_dir,
                    run_id=run_id,start_delay_seconds=plan.desktop_start_delay_seconds)
            if 'android' in kinds:
                drivers['android']=await AndroidPortalDriver.create(device_hub,plan.android_device_id,plan.android_package,
                    capture_screenshots=plan.capture_screenshots,evidence_directory=settings.report_dir,run_id=run_id)
            if 'api' in kinds:
                drivers['api']=HttpApiDriver(plan.api_base_url,set(settings.allowed_api_hosts),transport=api_transport)
            if 'web' in kinds:
                drivers['web']=await web_factory(plan.web_base_url,set(settings.allowed_web_hosts),headless=plan.web_headless,
                    viewport=plan.web_viewport.model_dump(),capture_screenshots=plan.capture_screenshots,
                    evidence_directory=settings.report_dir,run_id=run_id)
            return cls(drivers)
        except BaseException as exc:
            try: await asyncio.shield(Runner(drivers).close())
            except BaseException as cleanup: exc.add_note(f'driver cleanup also failed: {type(cleanup).__name__}')
            raise

    async def close(self):
        if not self._closed:
            self._closed=True
            await Runner(self.drivers).close()
