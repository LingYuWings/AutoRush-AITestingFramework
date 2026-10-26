"""Natural expectations use actual observations or explicit visual judgment."""
from dataclasses import dataclass
from autorush.assertions.evaluate import evaluate_assertion
from autorush.agent.contracts import ActionDecision
from autorush.drivers.base import DriverBlockedError


@dataclass
class VerificationResult:
    passed: bool
    messages: list[str]
    kind: str
    evidence: dict


async def verify_expected(decision,step,observation,driver,*,vision_verified,observer,executor):
    if decision.observation_id!=observation.id or decision.expected_result!=step.expected_result:
        raise DriverBlockedError('completion must match the expected result and current observation')
    if observation.startup or (step.driver!='api' and not observation.screenshot):
        raise DriverBlockedError('completion requires fresh screenshot evidence')
    if decision.check.kind=='visual':
        if not vision_verified or not observation.image_bytes: raise DriverBlockedError('visual capability has not been verified')
        return VerificationResult(decision.check.passed,[decision.check.explanation],'visual',{'screenshot':observation.screenshot})
    check=decision.check
    permitted={'web':{'text_contains','element_visible','url_contains','url_equals'},
               'android':{'text_contains','element_visible','package_equals'},'desktop':{'pixel_rgb_equals'},
               'api':{'status_code','json_field_equals','body_contains'}}[step.driver]
    if any(a.kind not in permitted for a in check.assertions): raise ValueError('assertion is incompatible with the observed driver')
    if check.operation:
        action=ActionDecision(kind='action',driver=step.driver,observation_id=observation.id,operation=check.operation,
            parameters=check.parameters,coordinate_space=check.coordinate_space,element_id=check.element_id,brief_reason='verify expected result')
        executable=await observer.resolve_action(action,observation)
        executable=executable.model_copy(update={'assertions':check.assertions})
        result=await executor.execute_step(executable,capture_evidence=False)
        if observation.screenshot:result.evidence['screenshot']=observation.screenshot
        return VerificationResult(result.status.value=='passed',result.assertions or [result.detail],'deterministic',result.evidence)
    if check.parameters or check.element_id: raise ValueError('verification parameters require a read-only operation')
    if any(a.kind in {'pixel_rgb_equals','element_visible'} for a in check.assertions):
        raise ValueError('pixel or element verification requires a specific read-only operation')
    output={'text':observation.text,**observation.last_output}
    if step.driver=='web': output['url']=observation.target.get('url')
    if step.driver=='android': output['package']=observation.target.get('package')
    checks=[evaluate_assertion(a,output) for a in check.assertions]
    return VerificationResult(all(ok for ok,_ in checks),[text for _,text in checks],'deterministic',
        {'screenshot':observation.screenshot} if observation.screenshot else {'api_output':observation.last_output})
