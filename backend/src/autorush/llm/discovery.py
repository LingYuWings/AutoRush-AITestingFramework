"""Explicit model catalogs and a fixed set of local runtime probes."""
import asyncio
import time
import httpx
from autorush.llm.client import ModelClient,ModelClientError
from autorush.llm.models import LocalRuntime,LocalDiscoveryResult
from autorush.llm.protocols import model_endpoint

CANDIDATES=(('ollama','Ollama',11434),('lm_studio','LM Studio',1234),('jan','Jan',1337),
            ('gpt4all','GPT4All',4891),('llama_cpp','llama.cpp',8080),('koboldcpp','KoboldCpp',5001))


def model_ids(body):
    if not isinstance(body,dict): return []
    items=body.get('data',body.get('models',[]))
    if not isinstance(items,list): return []
    values=[]
    for item in items[:1000]:
        value=item if isinstance(item,str) else item.get('id') or item.get('name') or item.get('model') if isinstance(item,dict) else None
        if isinstance(value,str) and 0<len(value.strip())<=200 and value.strip() not in values:
            values.append(value.strip())
            if len(values)>=200: break
    return sorted(values,key=str.casefold)


async def discover_local_models(*,transport=None):
    started=time.monotonic()
    async with httpx.AsyncClient(timeout=1.2,follow_redirects=False,trust_env=False,transport=transport) as client:
        async def probe(identifier,name,port):
            before=time.monotonic();base=f'http://127.0.0.1:{port}/v1'
            url=f'http://127.0.0.1:{port}/api/tags' if identifier=='ollama' else base+'/models'
            try:
                response=await client.get(url)
                response.raise_for_status()
                if len(response.content)>2_000_000: return None
                models=model_ids(response.json())
                if models: return LocalRuntime(id=identifier,name=name,base_url=base,models=models,latency_ms=round((time.monotonic()-before)*1000))
            except (httpx.HTTPError,ValueError): pass
            return None
        found=await asyncio.gather(*(probe(*item) for item in CANDIDATES))
    return LocalDiscoveryResult(runtimes=[x for x in found if x],scanned=6,duration_ms=round((time.monotonic()-started)*1000))


async def fetch_model_catalog(config,allowed_hosts,*,transport=None):
    client=ModelClient(config,allowed_hosts,transport=transport)
    try:
        headers={'anthropic-version':'2023-06-01'} if config.protocol=='anthropic_messages' else {}
        response=await client._client.get(model_endpoint(config.base_url,config.protocol,catalog=True),headers=headers)
        response.raise_for_status()
        if len(response.content)>2_000_000: raise ModelClientError('model catalog exceeds limit')
        return model_ids(response.json())
    except httpx.HTTPStatusError as exc: raise ModelClientError(f'model catalog returned HTTP {exc.response.status_code}') from exc
    except (httpx.HTTPError,ValueError) as exc: raise ModelClientError('model catalog request failed') from exc
    finally: await client.close()
