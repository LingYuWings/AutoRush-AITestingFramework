import {useMemo,useRef,useState} from 'react'
import {ExternalLink,Plus,Radio,Server} from '../../components/icons'
import {api,type CredentialType,type LocalModelRuntime,type ModelCapability,type ProviderConfig,type ProviderConfigPayload,type ProviderConnectionTest,type ProviderPreflight,type ProviderPreset,type ProviderVisionTest} from '../../shared/api'
import {applyModelCatalog,catalogKey,finalEndpoint,invalidateModelSelection,type CatalogState} from './model-catalog'
import ModelCatalogPicker from './ModelCatalogPicker'
import './provider-settings.css'

const credentials:Record<CredentialType,string>={api_key:'按量 API Key',token_plan:'Token Plan',coding_plan:'Coding Plan',local:'本地无凭证'}
const abilities:Record<ModelCapability,string>={text_only:'文本',structured_output:'结构化输出',tool_calling:'工具调用',vision:'视觉'}
const implemented=new Set(['openai_chat','openai_responses','anthropic_messages'])
const empty:CatalogState={providerId:'',region:'',credentialType:'api_key',protocol:'',baseUrl:'',secretRef:'',modelId:'',models:[],verified:false,visionVerified:false}

export default function ProviderSettings({presets,configs,onCreate,onPreflight}:{presets:ProviderPreset[];configs:ProviderConfig[];onCreate:(payload:ProviderConfigPayload)=>Promise<boolean>;onPreflight:(id:string)=>Promise<ProviderPreflight|null>}) {
  const [editing,setEditing]=useState(false)
  const [endpoint,setEndpoint]=useState<CatalogState>(empty)
  const [name,setName]=useState('')
  const [capabilities,setCapabilities]=useState<ModelCapability[]>(['structured_output'])
  const [saving,setSaving]=useState(false)
  const [catalogBusy,setCatalogBusy]=useState(false)
  const [catalogError,setCatalogError]=useState('')
  const [discoveryBusy,setDiscoveryBusy]=useState(false)
  const [runtimes,setRuntimes]=useState<LocalModelRuntime[]>([])
  const [discoveryMessage,setDiscoveryMessage]=useState('')
  const [checks,setChecks]=useState<Record<string,ProviderPreflight>>({})
  const [connections,setConnections]=useState<Record<string,ProviderConnectionTest|string>>({})
  const [visions,setVisions]=useState<Record<string,ProviderVisionTest|string>>({})
  const [probeBusy,setProbeBusy]=useState('')
  const preset=useMemo(()=>presets.find(p=>p.id===endpoint.providerId),[presets,endpoint.providerId])
  const currentCatalogKey=useRef('');currentCatalogKey.current=catalogKey(endpoint)
  const change=(fields:Partial<CatalogState>)=>{setEndpoint(old=>invalidateModelSelection(old,fields));setCatalogError('')}
  const choosePreset=(id:string)=>{
    const next=presets.find(p=>p.id===id);if(!next)return
    setEndpoint({...empty,providerId:id,region:next.regions[0]??'',credentialType:next.credential_types[0]??'api_key',
      protocol:next.protocols[0]??'',baseUrl:next.suggested_base_url??'',secretRef:next.credential_types[0]==='local'?'':`env:${id.toUpperCase()}_API_KEY`})
    setCapabilities(['structured_output',...(next.capabilities.includes('vision')?['vision' as const]:[])])
    setCatalogError('')
  }
  const ensureOperator=async()=>{api.setOperatorToken((await api.operatorSession()).operator_token)}
  const fetchCatalog=async()=>{
    const key=catalogKey(endpoint);setCatalogBusy(true);setCatalogError('')
    try {
      await ensureOperator()
      const result=await api.modelCatalog({provider_id:endpoint.providerId,region:endpoint.region,credential_type:endpoint.credentialType,
        protocol:endpoint.protocol,base_url:endpoint.baseUrl.trim(),secret_ref:endpoint.credentialType==='local'?null:endpoint.secretRef.trim()})
      setEndpoint(previous=>applyModelCatalog(previous,{key,models:result.models}))
      if(!result.models.length&&currentCatalogKey.current===key)setCatalogError('服务没有返回可选模型。')
    }catch(error){if(currentCatalogKey.current===key)setCatalogError(error instanceof Error?error.message:'获取模型列表失败')}
    finally{setCatalogBusy(false)}
  }
  const discover=async()=>{
    setDiscoveryBusy(true);setDiscoveryMessage('')
    try {await ensureOperator();const result=await api.discoverLocalModels();setRuntimes(result.runtimes)
      setDiscoveryMessage(result.runtimes.length?`发现 ${result.runtimes.length} 个服务，扫描 ${result.scanned} 个固定本机端点。`:'未发现已加载模型的本地服务。请先启动 llama.cpp、Ollama 或其他本地推理服务。')
    }catch(error){setDiscoveryMessage(error instanceof Error?error.message:'本地发现失败')}
    finally{setDiscoveryBusy(false)}
  }
  const useRuntime=(runtime:LocalModelRuntime)=>{
    const id=runtime.id==='ollama'?'ollama':'local_openai';choosePreset(id)
    setEndpoint(previous=>({...previous,baseUrl:runtime.base_url,models:runtime.models,modelId:runtime.models[0]??''}))
    setName(runtime.name+' · '+(runtime.models[0]??''));setEditing(true)
  }
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!preset||!endpoint.models.includes(endpoint.modelId))return
    setSaving(true)
    try {if(await onCreate({name:name.trim(),provider_id:preset.id,region:endpoint.region,credential_type:endpoint.credentialType,
      protocol:endpoint.protocol,base_url:endpoint.baseUrl.trim(),secret_ref:endpoint.credentialType==='local'?null:endpoint.secretRef.trim(),
      model_id:endpoint.modelId,capabilities})){setEditing(false);setName('')}}finally{setSaving(false)}
  }
  const probe=async(config:ProviderConfig,vision=false)=>{
    setProbeBusy(config.id)
    try {
      if(vision){await ensureOperator();const result=await api.testProviderVision(config.id);setVisions(old=>({...old,[config.id]:result}))}
      else {const result=await api.testProviderConnection(config.id);setConnections(old=>({...old,[config.id]:result}))}
    }catch(error){const message=error instanceof Error?error.message:'模型测试失败'
      if(vision)setVisions(old=>({...old,[config.id]:message}));else setConnections(old=>({...old,[config.id]:message}))
    }finally{setProbeBusy('')}
  }
  return <>
    <div className="settings-intro"><div><h2>模型服务</h2><p>选择服务与协议，获取模型列表后保存。凭证引用后端环境变量，保留在浏览器内存中的操作授权不落盘。</p></div>
      <button className="primary-button" onClick={()=>{choosePreset(presets[0]?.id??'');setName('');setEditing(true)}}><Plus size={16}/>添加模型配置</button></div>
    <section className="surface local-model-discovery"><div><h3>本地模型</h3><p>发现本机已运行的 llama.cpp、Ollama、LM Studio 等服务。</p></div>
      <button className="secondary-button" disabled={discoveryBusy} onClick={()=>void discover()}><Server size={15}/>{discoveryBusy?'发现中…':'发现本地模型'}</button>
      {discoveryMessage&&<p role="status">{discoveryMessage}</p>}
      {runtimes.map(runtime=><div className="local-runtime" key={runtime.id}><span><strong>{runtime.name}</strong> · {runtime.base_url}<br/>{runtime.models.join('、')}</span>
        <button className="secondary-button" onClick={()=>useRuntime(runtime)}>使用 {runtime.name}</button></div>)}
    </section>
    {editing&&preset&&<form className="surface provider-form" onSubmit={submit}>
      <div className="surface-header"><div><h3>新增模型配置</h3><p>模型列表、文本连接与实际图片识别分别验证。</p></div></div>
      <div className="field-grid">
        <label className="field"><span>服务商预设</span><select value={preset.id} onChange={e=>choosePreset(e.target.value)}>
          {['本地','在线服务'].map(group=><optgroup key={group} label={group}>{presets.filter(p=>(p.regions.includes('local')?'本地':'在线服务')===group).map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</optgroup>)}
        </select></label>
        <label className="field"><span>配置名称</span><input required value={name} onChange={e=>setName(e.target.value)} maxLength={100}/></label>
        <label className="field"><span>区域</span><select value={endpoint.region} onChange={e=>change({region:e.target.value})}>{preset.regions.map(r=><option key={r}>{r}</option>)}</select></label>
        <label className="field"><span>协议</span><select value={endpoint.protocol} onChange={e=>change({protocol:e.target.value})}>{preset.protocols.map(p=><option key={p} value={p}>{p}{implemented.has(p)?'':'（尚未实现）'}</option>)}</select></label>
        <label className="field"><span>接入方式</span><select value={endpoint.credentialType} onChange={e=>change({credentialType:e.target.value as CredentialType,secretRef:e.target.value==='local'?'':endpoint.secretRef})}>{preset.credential_types.map(c=><option key={c} value={c}>{credentials[c]}</option>)}</select></label>
        <label className="field"><span>Base URL</span><input required value={endpoint.baseUrl} onChange={e=>change({baseUrl:e.target.value})} placeholder="http://127.0.0.1:8080/v1"/></label>
        <label className="field"><span>密钥引用</span><input required={endpoint.credentialType!=='local'} disabled={endpoint.credentialType==='local'} value={endpoint.secretRef} onChange={e=>change({secretRef:e.target.value})} placeholder="env:PROVIDER_API_KEY"/></label>
      </div>
      <p className="quiet-note">最终请求地址：<code>{finalEndpoint(endpoint.baseUrl,endpoint.protocol)||'填写有效地址后显示'}</code></p>
      <ModelCatalogPicker state={endpoint} busy={catalogBusy} error={catalogError} onFetch={()=>void fetchCatalog()} onSelect={modelId=>setEndpoint(old=>({...old,modelId}))}/>
      <div className="capability-picker"><strong>请求能力</strong><div>{preset.capabilities.map(c=><label key={c}><input type="checkbox" checked={capabilities.includes(c)} onChange={e=>setCapabilities(e.target.checked?[...capabilities,c]:capabilities.filter(v=>v!==c))}/>{abilities[c]}</label>)}</div></div>
      <div className="compliance-note"><div><p>{preset.compliance_note}</p>{preset.documentation_url&&<a href={preset.documentation_url} target="_blank" rel="noreferrer">服务说明 <ExternalLink size={12}/></a>}</div></div>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setEditing(false)}>取消</button>
        <button className="primary-button" disabled={saving||!endpoint.models.includes(endpoint.modelId)||!implemented.has(endpoint.protocol)||!capabilities.length||endpoint.credentialType==='coding_plan'}>{saving?'保存中…':'保存配置'}</button></div>
    </form>}
    <div className="provider-list">{configs.length?configs.map(config=>{
      const connection=connections[config.id],vision=visions[config.id],check=checks[config.id]
      const connected=typeof connection==='object'?connection.connected:config.status==='verified'
      const visual=typeof vision==='object'?vision.verified:config.vision_verified
      return <section className="surface provider-card" key={config.id}><div className="provider-main"><div className="provider-heading"><h3>{config.name}</h3>
        <span className={`badge badge-${connected?'verified':'unverified'}`}>{connected?'文本已验证':'待连接验证'}</span>{visual&&<span className="badge badge-verified">视觉已验证</span>}</div>
        <p>{config.model_id} · {config.base_url}</p><div className="provider-meta"><span>{config.region}</span><span>{config.protocol}</span><span>{config.secret_ref??'本地无凭证'}</span></div>
        {check&&<p className="quiet-note">{check.messages.join(' ')}</p>}
        {connection&&<p className="quiet-note">{typeof connection==='string'?connection:`${connection.message} ${connection.latency_ms} ms`}</p>}
        {vision&&<p className="quiet-note">{typeof vision==='string'?vision:`${vision.message} ${vision.latency_ms} ms`}</p>}
      </div><div className="provider-actions"><button className="secondary-button" onClick={()=>void onPreflight(config.id).then(result=>{if(result)setChecks(old=>({...old,[config.id]:result}))})}><Server size={15}/>本地预检查</button>
        <button className="secondary-button" disabled={Boolean(probeBusy)||!implemented.has(config.protocol)} onClick={()=>void probe(config)}><Radio size={15}/>{probeBusy===config.id?'测试中…':'测试连接'}</button>
        <button className="secondary-button" disabled={Boolean(probeBusy)||!connected||!config.capabilities.includes('vision')} onClick={()=>void probe(config,true)}>验证图片识别</button>
      </div></section>
    }):<div className="surface provider-empty"><h3>尚未配置模型</h3><p>可发现本地服务，或添加在线端点并获取模型列表。</p></div>}</div>
  </>
}
