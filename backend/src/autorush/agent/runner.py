"""Bounded observe/decide/execute/verify loop over the existing deterministic runner."""
import asyncio
import inspect
import json
from autorush.agent.decision import decide
from autorush.agent.observers import observer_for,fingerprint,ObservationChangedError
from autorush.agent.verification import verify_expected
from autorush.agent.expectations import prepare_expectation,check_expectation
from autorush.agent.intent import action_scope_violation
from autorush.domain.models import CaseResult,ResultStatus,StepResult
from autorush.drivers.base import DriverBlockedError
from autorush.llm.client import ModelClientError
from autorush.runner.engine import Runner


class Budget:
    def __init__(self,options,case_used): self.options=options;self.case_used=case_used;self.step_used=0
    @property
    def remaining(self): return min(self.options.max_rounds_per_step-self.step_used,self.options.max_rounds_per_case-self.case_used[0])
    def consume(self):
        if self.remaining<=0: raise DriverBlockedError('model decision budget exhausted')
        self.step_used+=1;self.case_used[0]+=1


async def notify(callback,*args):
    if callback:
        result=callback(*args)
        if inspect.isawaitable(result): await result


class AgentRunner:
    def __init__(self,drivers,client,options,*,observer_factory=observer_for,directory=None,run_id=None,
                 checkpoint=None,emit=None,vision_verified=False,cancelled=lambda:False):
        self.drivers,self.client,self.options=drivers,client,options
        self.observer_factory,self.directory,self.run_id=observer_factory,directory,run_id
        self.checkpoint,self.emit=checkpoint,emit
        self.vision_verified,self.cancelled=vision_verified,cancelled
        self.executor=Runner(drivers);self.results=[];self.active=None;self.case_used=[0]

    def ensure_running(self):
        if self.cancelled(): raise asyncio.CancelledError()

    async def save(self,case,pending=None):
        progress={'case_id':str(case.id),'steps':[s.model_dump(mode='json') for s in self.results],
                  'active_step':self.active,'pending_action':pending,'rounds_used':self.case_used[0]}
        await notify(self.checkpoint,json.loads(json.dumps(progress,ensure_ascii=False)))

    async def run_case(self,case):
        self.executor.begin_case()
        self.results=[];self.active=None;self.case_used=[0]
        try:
            async with asyncio.timeout(self.options.case_timeout_seconds):
                failed=False
                for step in sorted(case.steps,key=lambda s:s.order):
                    self.ensure_running()
                    if failed: self.results.append(StepResult(order=step.order,intent=step.intent,status=ResultStatus.SKIPPED));continue
                    result=await self.run_step(case,step);self.results.append(result)
                    failed=result.status!=ResultStatus.PASSED
                    self.active=None;await self.save(case)
                for step in sorted(case.postconditions,key=lambda s:s.order):
                    self.ensure_running()
                    if step.always_run or not failed: self.results.append(await self.run_step(case,step))
                    else: self.results.append(StepResult(order=step.order,intent=step.intent,status=ResultStatus.SKIPPED))
                    self.active=None;await self.save(case)
        except TimeoutError:
            ordered=sorted(case.steps,key=lambda s:s.order)+sorted(case.postconditions,key=lambda s:s.order)
            if self.active:
                self.results.append(StepResult(order=self.active['order'],intent=self.active['intent'],status=ResultStatus.BLOCKED,
                    detail='agent case deadline exceeded',evidence={'agent':self.active}))
            elif len(self.results)<len(ordered):
                interrupted=ordered[len(self.results)]
                self.results.append(StepResult(order=interrupted.order,intent=interrupted.intent,status=ResultStatus.BLOCKED,detail='agent case deadline exceeded'))
            elif self.results:
                self.results[-1]=self.results[-1].model_copy(update={'status':ResultStatus.BLOCKED,'detail':'agent case deadline exceeded during checkpoint'})
            self.active=None
            done=len(self.results)
            for step in ordered[done:]: self.results.append(StepResult(order=step.order,intent=step.intent,status=ResultStatus.SKIPPED))
            await self.save(case)
        status=next((status for status in [ResultStatus.ERROR,ResultStatus.BLOCKED,ResultStatus.FAILED]
                     if any(result.status==status for result in self.results)),ResultStatus.PASSED)
        return CaseResult(case_id=case.id,title=case.title,status=status,steps=self.results)

    async def run_step(self,case,step):
        from autorush.api_testing.nodes import resolve_ui_step
        from autorush.api_testing.variables import ApiBlocked
        if step.driver == 'api' and step.operation == 'api.request':
            self.active = {'order': step.order, 'intent': step.intent, 'expected_result': step.expected_result,
                'kind': 'api', 'traces': []}
            await self.save(case)
            return await self.executor.execute_step(step, capture_evidence=False)
        try:
            step = resolve_ui_step(step, self.drivers, model_context=True)
        except ApiBlocked as exc:
            return StepResult(order=step.order, intent=step.intent, status=ResultStatus.BLOCKED, detail=str(exc))
        traces=[];history=[];feedback='';repeats=0;last_signature=None;failed_verifications=0
        self.active={'order':step.order,'intent':step.intent,'expected_result':step.expected_result,'traces':traces}
        def finish(status,detail,*,evidence=None,assertions=None,verification_kind=None):
            agent={**self.active,'verification_kind':verification_kind,'rounds_used':budget.step_used}
            return StepResult(order=step.order,intent=step.intent,status=status,detail=detail,
                assertions=assertions or [],evidence={**(evidence or {}),'agent':agent})
        budget=Budget(self.options,self.case_used)
        if step.driver not in self.drivers: return finish(ResultStatus.BLOCKED,'driver is not registered')
        driver=self.drivers[step.driver]
        async def rejected_preparation(metadata):
            self.active['goal_preparation']=metadata
            await self.save(case)
        try:
            async with asyncio.timeout(self.options.model_timeout_seconds):
                criteria,preparation=await prepare_expectation(self.client,step,budget,on_rejected=rejected_preparation)
            self.ensure_running()
            self.active['goal_criteria']=criteria.model_dump(mode='json')
            self.active['goal_preparation']=preparation
            await self.save(case)
        except (ValueError,DriverBlockedError,ModelClientError) as exc:return finish(ResultStatus.BLOCKED,'goal preparation: '+str(exc))
        except TimeoutError:return finish(ResultStatus.BLOCKED,'model request deadline exceeded')
        observer=self.observer_factory(step.driver,driver,self.directory,self.run_id)
        pending_observation=None
        while budget.remaining>0:
            self.ensure_running()
            before_round=budget.step_used
            try:
                observation=pending_observation if pending_observation is not None else await observer.observe()
                pending_observation=None
                async with asyncio.timeout(self.options.model_timeout_seconds):
                    decision,model=await decide(self.client,step,observation,history,budget=budget,feedback=feedback,send_images=self.vision_verified)
                self.ensure_running()
                stats={'request_id':model.request_id,'usage':model.usage,'latency_ms':model.latency_ms,'attempts':model.attempts}
                trace={'round':budget.step_used,'observation_id':observation.id,'brief_reason':decision.brief_reason,
                       'decision':decision.model_dump(mode='json'),
                       'model':stats,'observation':{'text':observation.text[:4000],'target':observation.target,'screenshot':observation.screenshot}}
                if decision.kind=='blocked':
                    traces.append(trace);await self.save(case)
                    return finish(ResultStatus.BLOCKED,decision.brief_reason)
                if decision.kind=='verify':
                    verification=await verify_expected(decision,step,observation,driver,vision_verified=self.vision_verified,
                        observer=observer,executor=self.executor)
                    async with asyncio.timeout(self.options.model_timeout_seconds):
                        goal_passed,goal_messages,goal_kind,goal_model=await check_expectation(criteria,observation,self.client,budget,vision_verified=self.vision_verified)
                    verification.passed=verification.passed and goal_passed
                    verification.messages.extend(goal_messages)
                    if goal_kind!='deterministic':verification.kind=goal_kind
                    if goal_model:trace['goal_model']=goal_model
                    trace.update(operation='verify',verification_kind=verification.kind,
                        result={'status':'passed' if verification.passed else 'failed','assertions':verification.messages,'evidence':verification.evidence})
                    traces.append(trace);await self.save(case)
                    if not verification.passed:
                        failed_verifications+=1
                        feedback='Expected result is NOT satisfied. '+str(verification.messages)[:1800]+'. Complete any missing action before verifying again.'
                        history.append({'operation':'verify','status':'failed','result':feedback})
                        if budget.remaining>0 and failed_verifications<3: continue
                    return finish(ResultStatus.PASSED if verification.passed else ResultStatus.FAILED,
                        'expected result verified' if verification.passed else 'expected result did not match',
                        evidence=verification.evidence,assertions=verification.messages,verification_kind=verification.kind)
                if budget.remaining==0: return finish(ResultStatus.BLOCKED,'last decision round is reserved for verification')
                reason=action_scope_violation(step,decision)
                if reason:
                    trace.update(operation=decision.operation,lifecycle='not_dispatched',result={'status':'blocked','detail':reason})
                    traces.append(trace);await self.save(case)
                    return finish(ResultStatus.BLOCKED,reason)
                executable=await observer.resolve_action(decision,observation)
                state=[observation.text,[e.model_dump(exclude={'locator'}) for e in observation.elements]]
                if step.driver=='desktop': state.append((observation.screenshot or {}).get('sha256'))
                signature=fingerprint([decision.operation,decision.parameters,decision.element_id,state])
                repeats=repeats+1 if signature==last_signature else 1;last_signature=signature
                if repeats>3: return finish(ResultStatus.BLOCKED,'three identical actions produced no observed progress')
                trace.update(operation=decision.operation,parameters=executable.parameters,lifecycle='pending')
                traces.append(trace)
                await self.save(case,trace)
                self.ensure_running()
                result=await self.executor.execute_step(executable,capture_evidence=False)
                try:
                    pending_observation=await observer.observe()
                    if pending_observation.screenshot:result.evidence['screenshot']=pending_observation.screenshot
                except Exception as capture_error:
                    result.evidence['screenshot_error']=f'{type(capture_error).__name__}: {capture_error}'
                    if result.status==ResultStatus.PASSED:result.status=ResultStatus.ERROR
                trace.update(result=result.model_dump(mode='json'),lifecycle='done')
                await self.save(case)
                await notify(self.emit,'agent.action.completed',{'case_id':str(case.id),'step':step.order,'round':budget.step_used,
                    'operation':decision.operation,'status':result.status.value})
                if result.evidence.get('screenshot_error'):
                    return finish(result.status,'action screenshot evidence is incomplete',evidence=result.evidence)
                history.append({'operation':decision.operation,'parameters':decision.parameters,'element_id':decision.element_id,
                    'brief_reason':decision.brief_reason,'result':result.detail,'status':result.status.value})
                feedback='' if result.status==ResultStatus.PASSED else result.detail
            except ObservationChangedError as exc:
                feedback=str(exc)
                trace.update(operation=decision.operation if decision.kind=='action' else 'verify',lifecycle='not_dispatched',
                    result={'status':'blocked','detail':feedback})
                traces.append(trace);pending_observation=None
                history.append({'operation':trace['operation'],'status':'not_dispatched','result':feedback})
                await self.save(case)
            except (DriverBlockedError,ModelClientError) as exc:
                return finish(ResultStatus.BLOCKED,str(exc))
            except TimeoutError:
                return finish(ResultStatus.BLOCKED,'model request deadline exceeded')
            except (ValueError,KeyError,TypeError) as exc:
                feedback=f'Invalid decision: {str(exc)[:700]}. Correct the JSON using only the current observation.'
                trace={'round':budget.step_used,'operation':None,'error':feedback}
                response=getattr(exc,'response',None)
                if response:
                    trace.update(model={'request_id':response.request_id,'usage':response.usage,'latency_ms':response.latency_ms,'attempts':response.attempts},
                        invalid_response=json.dumps(response.value,ensure_ascii=False)[:4000])
                traces.append(trace)
                # Observation errors before any request must not spin without budget.
                if budget.step_used==before_round: return finish(ResultStatus.BLOCKED,feedback)
                await self.save(case)
            except Exception as exc:
                return finish(ResultStatus.ERROR,f'{type(exc).__name__}: {str(exc)[:700]}')
        return finish(ResultStatus.BLOCKED,'model decision budget exhausted')
