"""Common screenshot binding and current-observation action resolution."""
import hashlib
import json
import time
from uuid import uuid4
from autorush.agent.contracts import AgentObservation,ObservedElement,desktop_action_parameters
from autorush.domain.models import StepSpec
from autorush.drivers.base import DriverBlockedError
from autorush.evidence.screenshot import evidence_path

class ObservationChangedError(DriverBlockedError):
    """Same authorized target changed before dispatch; discard this decision."""


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()


class AgentObserver:
    kind=''
    def __init__(self,driver,directory,run_id):
        self.driver,self.directory,self.run_id=driver,directory,run_id

    async def observe(self,*,previous_screenshot=None):
        raw=await self.driver.observe()
        screenshot=None;image=None
        startup=bool(raw.get('startup',False))
        if self.kind!='api' and not startup:
            captured=await self.driver.capture_evidence()
            screenshot=captured.get('screenshot')
            if not screenshot: raise DriverBlockedError('agent observation requires screenshot evidence')
            path=evidence_path(self.directory,self.run_id,screenshot['file'])
            image=path.read_bytes()
            if len(image)>1_000_000 or len(image)!=screenshot['bytes'] or hashlib.sha256(image).hexdigest()!=screenshot['sha256']:
                raise DriverBlockedError('observation screenshot checksum mismatch')
        output=dict(raw.get('last_output',{}))
        if raw.get('geometry'): output['geometry']=raw['geometry']
        return AgentObservation(id=uuid4().hex,driver=self.kind,captured_at=int(time.time()*1000),target=raw['target'],
            text=raw.get('text','')[:12000],elements=[ObservedElement(**item) for item in raw.get('elements',[])[:200]],
            screenshot=screenshot,image_bytes=image,fingerprint=raw['fingerprint'],last_output=output,startup=startup)

    async def resolve_action(self,decision,observation):
        if decision.observation_id!=observation.id or decision.driver!=self.kind or observation.driver!=self.kind:
            raise DriverBlockedError('decision does not match the current observation')
        current=await self.driver.observe()
        if current.get('startup') and not observation.startup:
            raise DriverBlockedError('authorized foreground target was lost after observation')
        if current['target']!=observation.target:
            raise DriverBlockedError('execution target changed after observation')
        if current['fingerprint']!=observation.fingerprint:
            raise ObservationChangedError('page changed after observation; discard the old decision and observe again')
        if observation.startup and decision.operation!={'web':'web.open','android':'android.launch'}.get(self.kind):
            raise DriverBlockedError('startup observation only permits opening the configured target')
        params=dict(decision.parameters)
        if self.kind=='desktop':params=desktop_action_parameters(decision.operation,params)
        if decision.element_id:
            matches=[element for element in observation.elements if element.id==decision.element_id]
            if len(matches)!=1 or not matches[0].locator: raise DriverBlockedError('element_id was not uniquely observed')
            params['target']=matches[0].locator
        if self.kind=='desktop' and 'x' in params:
            geometry=observation.last_output.get('geometry')
            shot=observation.screenshot
            if not geometry or not shot: raise DriverBlockedError('desktop coordinates require image and client dimensions')
            x,y=params['x'],params['y'];width,height=shot['width'],shot['height']
            if decision.coordinate_space=='normalized_1000':width=height=1000
            if not 0<=x<width or not 0<=y<height: raise DriverBlockedError('model coordinates exceed the observed image')
            params.update(x=min(geometry[0]-1,round(x*geometry[0]/width)),y=min(geometry[1]-1,round(y*geometry[1]/height)))
        if self.kind=='android' and decision.operation=='android.swipe':
            shot=observation.screenshot
            bounds=shot.get('source_bounds') if shot else None
            if not shot or not isinstance(bounds,list) or len(bounds)!=4 or any(type(v) is not int for v in bounds):
                raise DriverBlockedError('Android image swipe requires exact screenshot crop bounds; update Portal or use an observed element action')
            left,top,right,bottom=bounds
            if left<0 or top<0 or right<=left or bottom<=top or abs((right-left)/(bottom-top)-shot['width']/shot['height'])>.02:
                raise DriverBlockedError('Android screenshot crop cannot be mapped to observed application bounds')
            for axis in ('x','y'):
                dimension='width' if axis=='x' else 'height'
                source=right-left if axis=='x' else bottom-top
                origin=left if axis=='x' else top
                size=1000 if decision.coordinate_space=='normalized_1000' else shot[dimension]
                for endpoint in ('from_','to_'):
                    key=endpoint+axis;value=params[key]
                    if not 0<=value<size:raise DriverBlockedError('model coordinates exceed the observed image')
                    params[key]=origin+min(source-1,round(value*source/size))
        return StepSpec(order=1,intent=decision.brief_reason,driver=self.kind,operation=decision.operation,parameters=params)


def observer_for(driver_kind,driver,directory,run_id):
    from autorush.agent.web_observer import WebObserver
    from autorush.agent.android_observer import AndroidObserver
    from autorush.agent.desktop_observer import DesktopObserver
    from autorush.agent.api_observer import ApiObserver
    return {'web':WebObserver,'android':AndroidObserver,'desktop':DesktopObserver,'api':ApiObserver}[driver_kind](driver,directory,run_id)
