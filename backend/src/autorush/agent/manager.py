"""Single-process background runs with durable checkpoints and explicit cancellation."""
import asyncio
import logging
import os
from collections import OrderedDict
from uuid import UUID
from autorush.agent.executions import AgentExecutionRecord,validate_agent_configuration
from autorush.agent.live_output import LiveOutput
from autorush.agent.runner import AgentRunner
from autorush.api_testing.variables import secret_strings
from autorush.domain.models import CaseResult,ResultStatus,RunRecord,StepResult
from autorush.evidence.report import save_reports
from autorush.events import PlatformEvent
from autorush.llm.client import ModelClient
from autorush.runner.engine import Runner


# Manage the lifecycle and persisted progress of agent executions.
class AgentRunManager:
    # Store execution dependencies and initialize task tracking.
    def __init__(self,settings,store,session_factory,client_factory,broker,*,collect_live_output=True):
        self.settings,self.store=settings,store
        self.session_factory,self.client_factory,self.broker=session_factory,client_factory,broker
        self.tasks={};self.cancel_events={};self.started=set();self.start_lock=asyncio.Lock()
        self.collect_live_output=collect_live_output
        self.active_output={}
        self.recent_output=OrderedDict()

    # Publish an execution event when a broker is available.
    async def emit(self,event_type,payload):
        if self.broker: await self.broker.publish(PlatformEvent(type=event_type,payload=payload))

    # Load an execution record by ID.
    def get(self,execution_id):
        return self.store.get_agent_execution(execution_id)

    # Return a snapshot without reloading the plan's checkpoints during every live poll.
    def get_live_output(self,execution_id):
        if execution_id in self.active_output:
            return {'active': True, 'entries': self.active_output[execution_id].snapshot()}
        if execution_id in self.recent_output:
            return {'active': False, 'entries': self.recent_output[execution_id]}
        record=self.get(execution_id)
        if record is not None:
            return {'active': record.state in {'running','stopping'}, 'entries': []}
        return None

    # Create or reuse an execution for the supplied idempotency key.
    async def start(self,plan_id,*,idempotency_key):
        async with self.start_lock:
            existing=self.store.find_agent_execution(idempotency_key)
            if existing:
                if existing.plan_id!=plan_id: raise ValueError('idempotency key belongs to another plan')
                return existing
            plan=self.store.get_plan(plan_id)
            if plan is None or plan.status.value!='ready': raise ValueError('plan must be ready')
            cases=[self.store.get_case(case_id) for case_id in plan.case_ids]
            if any(case is None or case.status.value!='approved' for case in cases): raise ValueError('all cases must be approved')
            if not any(case.execution_mode=='agent' for case in cases): raise ValueError('plan has no natural cases')
            validate_agent_configuration(self.settings,self.store,plan,cases)
            record=AgentExecutionRecord(plan_id=plan.id,idempotency_key=idempotency_key,plan_snapshot=plan,case_snapshots=cases)
            self.store.save_agent_execution(record)
            return self._schedule(record)

    # Start a background task and register its cancellation signal.
    def _schedule(self, record):
        self.cancel_events[record.id]=asyncio.Event()
        if self.collect_live_output:
            self.active_output[record.id]=LiveOutput()
            self.active_output[record.id].publish('execution', '准备执行环境')
        task=asyncio.create_task(self._execute(record));self.tasks[record.id]=task
        # Handle task completion and clear its in-memory tracking.
        def done(completed):
            if not completed.cancelled():
                error=completed.exception()
                if error:
                    logging.getLogger(__name__).error('Agent task failed: %s',type(error).__name__)
                    try:
                        saved=self.get(record.id)
                        if saved and saved.state in {'running','stopping'}:
                            saved.state='interrupted';saved.termination_reason=f'execution persistence failed: {type(error).__name__}'
                            self.store.update_agent_execution(saved)
                    except Exception:
                        logging.getLogger(__name__).error('Agent failure state could not be persisted')
            self.tasks.pop(record.id,None);self.cancel_events.pop(record.id,None);self.started.discard(record.id)
            output=self.active_output.pop(record.id,None)
            if output is not None:
                self.recent_output[record.id]=output.snapshot()
                if len(self.recent_output)>10:
                    self.recent_output.popitem(last=False)
        task.add_done_callback(done)
        return record

    # Mark the execution as stopping and signal its task.
    async def cancel(self,execution_id):
        record=self.get(execution_id)
        if record is None: return None
        if record.state in {'finished','interrupted','stopping'}: return record
        record.state='stopping';self.store.update_agent_execution(record)
        if execution_id in self.cancel_events: self.cancel_events[execution_id].set()
        if execution_id in self.started and execution_id in self.tasks: self.tasks[execution_id].cancel()
        return record

    # Build interrupted case results from completed results and saved progress.
    def interrupted_results(self,record,completed,reason):
        results=list(completed);done={r.case_id for r in results}
        active=record.progress.get('active',{})
        for case in record.case_snapshots:
            if case.id in done: continue
            steps=[]
            if active.get('case_id')==str(case.id):
                steps=[StepResult.model_validate(s) for s in active.get('steps',[])]
                current=active.get('active_step')
                if current:
                    pending=active.get('pending_action')
                    if case.execution_mode=='agent':
                        evidence={'agent':{**current,'pending_action':pending}}
                    else:
                        # Older checkpoints can contain plaintext request headers or input.
                        action={key: pending[key] for key in ('operation', 'lifecycle') if key in pending} if pending else None
                        active['pending_action']=action
                        evidence={'interrupted_action':action}
                    steps.append(StepResult(order=current['order'],intent=current['intent'],status=ResultStatus.BLOCKED,detail=reason,
                        evidence=evidence))
            ordered=sorted(case.steps,key=lambda s:s.order)+sorted(case.postconditions,key=lambda s:s.order)
            for step in ordered[len(steps):]:
                steps.append(StepResult(order=step.order,intent=step.intent,status=ResultStatus.SKIPPED,detail=reason))
            results.append(CaseResult(case_id=case.id,title=case.title,status=ResultStatus.BLOCKED,steps=steps))
        return results

    # Persist the final run and mark the execution's terminal state.
    async def finish(self,record,results,reason=None,*,interrupted=False):
        prior=self.store.get_run(record.id)
        if prior is None:
            status=ResultStatus.BLOCKED if reason else next((s for s in [ResultStatus.ERROR,ResultStatus.FAILED,ResultStatus.BLOCKED]
                if any(case.status==s for case in results)),ResultStatus.PASSED)
            run=RunRecord(id=record.id,plan_id=record.plan_id,status=status,cases=results,termination_reason=reason)
            try:
                paths=save_reports(run,self.settings.report_dir)
                run=run.model_copy(update={'report_path':str(paths['json']),'report_paths':{k:str(v) for k,v in paths.items()}})
                self.store.save_run(run)
            except Exception as exc:
                record.state='interrupted';record.termination_reason=f'report persistence failed: {type(exc).__name__}'
                record.final_run_id=None;self.store.update_agent_execution(record)
                await self.emit('agent.run.failed',{'run_id':str(record.id),'reason':record.termination_reason})
                return
        record.state='interrupted' if interrupted else 'finished';record.termination_reason=reason;record.final_run_id=record.id
        self.store.update_agent_execution(record)
        await self.emit('report.ready',{'run_id':str(record.id),'plan_id':str(record.plan_id),
            'status':self.store.get_run(record.id).status.value,'report_url':f'/api/v1/runs/{record.id}/report'})

    # Run the saved cases with an execution session and model client.
    async def _execute(self,record):
        self.started.add(record.id)
        session=None;client=None;results=[];reason=None
        event=self.cancel_events[record.id]
        output=self.active_output.get(record.id)
        try:
            if event.is_set(): raise asyncio.CancelledError()
            config=validate_agent_configuration(self.settings,self.store,record.plan_snapshot,record.case_snapshots) if any(c.execution_mode=='agent' for c in record.case_snapshots) else None
            session=await self.session_factory(record.plan_snapshot,record.case_snapshots,record.id)
            client=self.client_factory(config,set(self.settings.allowed_llm_hosts),timeout=record.plan_snapshot.agent_options.model_timeout_seconds) if config else None
            if output:
                for case in record.case_snapshots:
                    output.secrets.update(secret_strings(case.model_dump(mode='json')))
                if config and config.secret_ref:
                    token=os.getenv(config.secret_ref.removeprefix('env:'))
                    if token: output.secrets.add(token)
                if isinstance(client, ModelClient):
                    # Merge streamed reasoning fragments while keeping decisions as separate entries.
                    def model_activity(kind,text):
                        output.publish(kind,text,append=kind=='reasoning')
                    client.set_live_output(model_activity)
            await self.emit('run.started',{'run_id':str(record.id),'plan_id':str(record.plan_id),'case_count':len(record.case_snapshots)})
            # Save completed and active case progress and honor cancellation.
            async def checkpoint(value):
                record.progress={'completed_cases':[c.model_dump(mode='json') for c in results],'active':value}
                if event.is_set(): record.state='stopping'
                self.store.update_agent_execution(record)
                if event.is_set(): raise asyncio.CancelledError()
            for index,case in enumerate(record.case_snapshots,1):
                if event.is_set(): raise asyncio.CancelledError()
                api_driver=session.drivers.get('api')
                if output:
                    output.case=index;output.step=None
                    output.secrets.update(getattr(api_driver,'runtime_secrets', ()))
                    output.publish('execution', '开始用例')
                if case.execution_mode=='agent':
                    runner=AgentRunner(session.drivers,client,record.plan_snapshot.agent_options,directory=self.settings.report_dir,
                        run_id=record.id,checkpoint=checkpoint,emit=self.emit,vision_verified=config.vision_verified,cancelled=event.is_set,
                        live_output=output)
                    result=await runner.run_case(case)
                else:
                    # Translate structured runner progress into an execution checkpoint.
                    async def structured_progress(steps,current):
                        if output:
                            output.secrets.update(getattr(api_driver,'runtime_secrets', ()))
                            output.step=current.order if current else steps[-1].order
                            output.publish('execution', f'正在执行 · {current.operation}' if current else f'步骤结果 · {steps[-1].status.value}')
                        await checkpoint({'case_id':str(case.id),'steps':[s.model_dump(mode='json') for s in steps],
                            'active_step':{'order':current.order,'intent':current.intent,'expected_result':'结构化断言','traces':[]} if current else None,
                            'pending_action':{'operation':current.operation,'lifecycle':'pending'} if current else None})
                    result=await Runner(session.drivers).run_case(case,on_progress=structured_progress)
                results.append(result)
                if output:
                    output.step=None
                    output.publish('execution', f'用例结果 · {result.status.value}')
                record.progress={'completed_cases':[c.model_dump(mode='json') for c in results]};self.store.update_agent_execution(record)
                await self.emit('case.completed',{'run_id':str(record.id),'plan_id':str(record.plan_id),'case_id':str(case.id),
                    'status':result.status.value,'completed':index,'total':len(record.case_snapshots)})
        except asyncio.CancelledError: reason='cancelled by operator; no further application input sent'
        except Exception as exc: reason=f'{type(exc).__name__}: {str(exc)[:1000]}'
        finally:
            for resource in [client,session]:
                if resource is not None:
                    try: await asyncio.shield(resource.close())
                    except BaseException as exc:
                        reason=(reason+'; ' if reason else '')+f'resource cleanup failed: {type(exc).__name__}'
        if reason: results=self.interrupted_results(record,results,reason)
        await self.finish(record,results,reason)
        if output:
            output.case=output.step=None
            output.publish('execution', '执行已结束' if reason is None else '执行提前结束，详情见运行卡片')

    # Finalize unfinished executions found in storage after a restart.
    async def recover_interrupted(self):
        for record in self.store.list_agent_executions():
            if record.state in {'running','stopping'} and record.id not in self.tasks:
                reason='interrupted by server restart; pending action outcome is unknown and will not be replayed'
                completed=[CaseResult.model_validate(c) for c in record.progress.get('completed_cases',[])]
                await self.finish(record,self.interrupted_results(record,completed,reason),reason,interrupted=True)

    # Cancel active executions and wait for their tasks to exit.
    async def close(self):
        tasks=list(self.tasks.items())
        for ident,_ in tasks: await self.cancel(ident)
        if tasks: await asyncio.gather(*(task for _,task in tasks),return_exceptions=True)
