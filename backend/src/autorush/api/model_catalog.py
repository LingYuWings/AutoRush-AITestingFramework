"""Operator-authorized catalog/discovery and real visual capability testing."""
import io
import secrets
from uuid import UUID
from fastapi import APIRouter,Header,HTTPException,Request
from autorush.llm.client import ModelClient,ModelClientError
from autorush.llm.discovery import discover_local_models,fetch_model_catalog
from autorush.llm.models import ModelCatalogRequest,ProviderConfigCreate,ProviderConfigRecord,ProviderVisionTest
from autorush.llm.service import validate_provider_config


def create_model_catalog_router(settings,store,require_operator,trusted_local_request):
    router=APIRouter(prefix='/api/v1/providers')
    def authorize(request,token):
        require_operator(token)
        if not trusted_local_request(request): raise HTTPException(403,'model discovery requires a trusted local browser')

    @router.get('/local-models')
    async def discover(request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        return await discover_local_models()

    @router.post('/model-catalog')
    async def catalog(payload:ModelCatalogRequest,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        try:
            config=ProviderConfigCreate(name='catalog',model_id='__catalog__',capabilities={'structured_output'},**payload.model_dump())
            validate_provider_config(config)
            return {'models':await fetch_model_catalog(ProviderConfigRecord(**config.model_dump()),set(settings.allowed_llm_hosts))}
        except (ValueError,ModelClientError) as exc: raise HTTPException(422,str(exc)) from exc

    @router.post('/configs/{config_id}/vision-test',response_model=ProviderVisionTest)
    async def vision(config_id:UUID,request:Request,x_autorush_operator_token:str|None=Header(default=None)):
        authorize(request,x_autorush_operator_token)
        config=store.get_provider_config(config_id)
        if config is None: raise HTTPException(404,'model configuration not found')
        if config.status!='verified': raise HTTPException(409,'verify text connection first')
        if 'vision' not in config.capabilities: raise HTTPException(409,'model configuration does not declare vision')
        from PIL import Image,ImageDraw
        colors={'red':(240,20,20),'blue':(20,40,240),'green':(20,180,40)}
        color=secrets.choice(list(colors));side=secrets.choice(['left','right'])
        image=Image.new('RGB',(512,384),'white');draw=ImageDraw.Draw(image)
        x=128 if side=='left' else 384
        draw.rectangle((x-60,132,x+60,252),fill=colors[color]);out=io.BytesIO();image.save(out,format='JPEG')
        client=ModelClient(config,set(settings.allowed_llm_hosts))
        try:
            result=await client.generate_json('Describe only what is visible. Return JSON only.',
                'What color is the square (red, blue, green), and is it on the left or right? Return {"color":"...","side":"..."}.',images=[out.getvalue()])
            passed=result.value=={'color':color,'side':side}
            store.set_provider_vision(config.id,passed)
            return ProviderVisionTest(config_id=config.id,verified=passed,request_id=result.request_id,latency_ms=result.latency_ms,
                message='实际图片识别通过。' if passed else '实际图片回答不匹配，视觉能力未验证。')
        except ModelClientError as exc:
            store.set_provider_vision(config.id,False)
            raise HTTPException(422,str(exc)) from exc
        finally: await client.close()
    return router
