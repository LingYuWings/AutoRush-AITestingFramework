"""Strict model decisions; observations never serialize raw image payloads."""
from typing import Annotated,Literal,Union
from pydantic import BaseModel,ConfigDict,Field,TypeAdapter,model_validator
from autorush.domain.models import AssertionSpec,StepSpec
from autorush.drivers.web.validation import validate_web_step
from autorush.drivers.android.portal import validate_android_step
from autorush.drivers.desktop.contracts import validate_desktop_step

DriverKind=Literal['api','web','android','desktop']


# Convert a semantic scroll direction and amount to signed desktop wheel clicks.
def desktop_action_parameters(operation,parameters):
    """Bind semantic model direction to the existing signed native wheel contract."""
    params=dict(parameters)
    if operation=='desktop.scroll' and ('direction' in params or 'amount' in params):
        if set(params)-{'x','y','direction','amount'}:
            raise ValueError('scroll direction cannot be mixed with native clicks')
        direction=params.get('direction');amount=params.get('amount')
        if direction not in {'up','down'} or type(amount) is not int or not 1<=amount<=20:
            raise ValueError('scroll requires up/down direction and amount 1..20')
        params={'x':params.get('x'),'y':params.get('y'),'clicks':amount if direction=='up' else -amount}
    return params


# Reject unexpected fields in agent model payloads.
class StrictModel(BaseModel):
    model_config=ConfigDict(extra='forbid')


# Describe an observed element and the details available for targeting it.
class ObservedElement(StrictModel):
    id: str = Field(min_length=1,max_length=100)
    role: str = Field(default='',max_length=100)
    name: str = Field(default='',max_length=1000)
    value: str = Field(default='',max_length=1000)
    bounds: list[int] | None = None
    locator: dict = Field(default_factory=dict,exclude=True)
    options: list[dict[str,str]] = Field(default_factory=list,max_length=50)


# Capture the target, evidence, and state from one agent observation.
class AgentObservation(StrictModel):
    id: str = Field(min_length=1,max_length=100)
    driver: DriverKind
    captured_at: int
    target: dict
    text: str = Field(default='',max_length=12000)
    elements: list[ObservedElement] = Field(default_factory=list,max_length=200)
    screenshot: dict | None = None
    image_bytes: bytes | None = Field(default=None,exclude=True)
    fingerprint: str
    last_output: dict = Field(default_factory=dict)
    startup: bool = False

    # Prepare the observation data the model is allowed to see.
    def public_dict(self):
        public=self.model_dump(mode='json')
        if self.driver=='android':
            bounds=(self.screenshot or {}).get('source_bounds')
            valid=isinstance(bounds,list) and len(bounds)==4 and all(type(v) is int for v in bounds) and bounds[2]>bounds[0] and bounds[3]>bounds[1]
            public['bounds_coordinate_space']='normalized_1000'
            for element in public['elements']:
                rectangle=element.get('bounds')
                if not valid or not isinstance(rectangle,list) or len(rectangle)!=4 or any(type(v) is not int for v in rectangle):
                    element['bounds']=None;continue
                left,top,right,bottom=bounds
                element['bounds']=[max(0,min(1000,round((value-origin)*1000/size))) for value,origin,size in
                    zip(rectangle,[left,top,left,top],[right-left,bottom-top,right-left,bottom-top])]
        return public


# Describe a model-proposed action tied to an observation.
class ActionDecision(StrictModel):
    kind: Literal['action']
    observation_id: str = Field(min_length=1,max_length=100)
    driver: DriverKind
    operation: str = Field(min_length=1,max_length=60)
    parameters: dict = Field(default_factory=dict)
    coordinate_space: Literal['image','normalized_1000'] = 'image'
    element_id: str | None = Field(default=None,min_length=1,max_length=100)
    brief_reason: str = Field(min_length=1,max_length=1000)

    # Check driver-specific operation parameters and element references.
    @model_validator(mode='after')
    def validate_operation(self):
        params=dict(self.parameters)
        if 'target' in params: raise ValueError('model must reference an observed element_id')
        if self.driver=='web':
            if self.operation!='web.open':
                if not self.element_id: raise ValueError('Web action requires observed element_id')
                params['target']={'test_id':'__observed__'}
            validate_web_step(StepSpec(order=1,intent='decision',driver='web',operation=self.operation,parameters=params))
        elif self.driver=='android':
            if self.operation in {'android.tap','android.input_text'} or self.element_id:
                if not self.element_id: raise ValueError('Android action requires observed element_id')
                params['target']={'resource_id':'__observed__'}
            validate_android_step(StepSpec(order=1,intent='decision',driver='android',operation=self.operation,parameters=params))
        elif self.driver=='desktop':
            if self.element_id: raise ValueError('Desktop actions use observed image coordinates')
            params=desktop_action_parameters(self.operation,params)
            validate_desktop_step(StepSpec(order=1,intent='decision',driver='desktop',operation=self.operation,parameters=params))
        else:
            from urllib.parse import urlsplit
            if self.operation!='api.request' or set(params)-{'method','path','query','json'}: raise ValueError('unsupported API decision')
            method=params.get('method','GET');path=params.get('path')
            if not isinstance(method,str) or method.upper() not in {'GET','POST','PUT','PATCH','DELETE','HEAD'}: raise ValueError('invalid API method')
            if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or '\\' in path or any(ord(c)<32 for c in path): raise ValueError('invalid local API path')
            parsed=urlsplit(path)
            if parsed.netloc or parsed.scheme or parsed.fragment: raise ValueError('API path cannot change target')
            if 'query' in params and not isinstance(params['query'],dict): raise ValueError('API query must be an object')
        return self


# Describe an assertion or read-only operation for deterministic verification.
class DeterministicCheck(StrictModel):
    kind: Literal['deterministic']
    operation: Literal['web.inspect','android.inspect','desktop.inspect_pixel'] | None = None
    parameters: dict = Field(default_factory=dict)
    coordinate_space: Literal['image','normalized_1000'] = 'image'
    element_id: str | None = None
    assertions: list[AssertionSpec] = Field(min_length=1,max_length=10)


# Record a visual verdict and its explanation.
class VisualCheck(StrictModel):
    kind: Literal['visual']
    passed: bool = Field(strict=True)
    explanation: str = Field(min_length=1,max_length=1000)


# Bind a proposed verification to the observation and expected result.
class VerifyDecision(StrictModel):
    kind: Literal['verify']
    observation_id: str = Field(min_length=1,max_length=100)
    expected_result: str = Field(min_length=1,max_length=2000)
    check: Annotated[Union[DeterministicCheck,VisualCheck],Field(discriminator='kind')]
    brief_reason: str = Field(min_length=1,max_length=1000)


# Explain why the model cannot proceed.
class BlockedDecision(StrictModel):
    kind: Literal['blocked']
    brief_reason: str = Field(min_length=1,max_length=1000)


AgentDecision=Annotated[Union[ActionDecision,VerifyDecision,BlockedDecision],Field(discriminator='kind')]
DECISION_ADAPTER=TypeAdapter(AgentDecision)


# Validate a model response against the supported decision types.
def parse_decision(value):
    return DECISION_ADAPTER.validate_python(value)
