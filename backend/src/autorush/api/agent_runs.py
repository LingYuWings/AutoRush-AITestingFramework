"""Background natural-language execution, restricted to the local operator."""
from uuid import UUID
from fastapi import APIRouter,Header,HTTPException,Request
from pydantic import BaseModel
from autorush.api.automation import check_desktop_target


# Carries the caller's retry key for an agent execution.
class StartAgentRun(BaseModel):
    idempotency_key: UUID


# Expose the background execution lifecycle for natural-language plans.
def create_agent_run_router(manager,settings,store,device_hub,require_operator,trusted_local_request):
    router=APIRouter(prefix='/api/v1')
    # Require an operator token from the trusted local console.
    def authorize(request,token):
        require_operator(token)
        if not trusted_local_request(request): raise HTTPException(403,'agent runs require a trusted local operator')

    # Preflight the plan and schedule a run using the supplied retry key.
    @router.post('/plans/{plan_id}/agent-runs',status_code=202)
    async def start(plan_id:UUID,payload:StartAgentRun,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        existing=store.find_agent_execution(payload.idempotency_key)
        if existing:
            if existing.plan_id!=plan_id: raise HTTPException(409,'idempotency key belongs to another plan')
            return existing
        plan=store.get_plan(plan_id)
        if plan is None: raise HTTPException(404,'plan not found')
        cases=[store.get_case(ident) for ident in plan.case_ids]
        if any(case is None for case in cases): raise HTTPException(409,'plan references missing cases')
        kinds={step.driver for case in cases for step in case.steps+case.postconditions}
        if 'desktop' in kinds: check_desktop_target(settings,plan)
        if 'android' in kinds and str(plan.android_device_id) not in device_hub.list_devices(): raise HTTPException(409,'Android device is offline')
        try: return await manager.start(plan_id,idempotency_key=payload.idempotency_key)
        except ValueError as exc: raise HTTPException(409,str(exc)) from exc

    # List recent agent executions for the console.
    @router.get('/agent-runs')
    async def recent(request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        return sorted(store.list_agent_executions(),key=lambda item:item.created_at,reverse=True)[:30]

    # Return one execution's current progress and final report reference.
    @router.get('/agent-runs/{execution_id}')
    async def get(execution_id:UUID,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        record=manager.get(execution_id)
        if record is None: raise HTTPException(404,'agent execution not found')
        return record

    # Request cancellation of a background agent execution.
    @router.post('/agent-runs/{execution_id}/cancel')
    async def cancel(execution_id:UUID,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        record=await manager.cancel(execution_id)
        if record is None: raise HTTPException(404,'agent execution not found')
        return record
    return router
