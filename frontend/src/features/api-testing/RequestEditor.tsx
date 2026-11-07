import {folderPath} from './types'
import {useEffect,useRef,useState} from 'react'
import type {ApiRequest,ApiAssertion,BodyField,CollectionRecord,Extraction,FolderRecord} from './types'
import {newBodyField} from './types'
import {PairsEditor,VariablesEditor} from './Fields'
import {Plus,X} from '../../components/icons'

const assertionLabels:Record<ApiAssertion['kind'],string>={status_code:'状态码',body_contains:'正文包含',json_field_equals:'JSON 字段相等',json_field_exists:'JSON 字段存在',header_equals:'响应头相等',response_time_less_than:'响应耗时小于（ms）'}
// Edit an API request specification, including body data and checks.
export default function RequestEditor({value,onChange,collections=[],folders}:{value:ApiRequest;onChange:(value:ApiRequest)=>void;collections?:CollectionRecord[];folders?:FolderRecord[]}){
  const [tab,setTab]=useState('params'),[error,setError]=useState('')
  const latest=useRef({value,onChange});latest.current={value,onChange}
  const rowKeys=useRef(new WeakMap<BodyField,number>())
  const nextKey=useRef(0)
  const readers=useRef(new Map<number,FileReader>())
  // Abort all pending file reads before changing the editor context.
  const cancelUploads=()=>{
    const pending=[...readers.current.values()]
    readers.current.clear()
    pending.forEach(reader=>reader.abort())
  }
  useEffect(()=>cancelUploads,[])
  // Give each body field a stable identity for tracking file reads.
  const rowKey=(item:BodyField)=>{
    let key=rowKeys.current.get(item)
    if(key===undefined){key=nextKey.current++;rowKeys.current.set(item,key)}
    return key
  }
  // Merge changes into the latest request and clear the folder when the collection changes.
  const update=(patch:Partial<ApiRequest>)=>{
    const {value:current,onChange:commit}=latest.current
    const next={...current,...('collection_id' in patch&&patch.collection_id!==current.collection_id?{folder_id:null,position:0}:{}),...patch}
    latest.current={value:next,onChange:commit}
    commit(next)
  }
  // Apply body changes and cancel pending uploads if the body mode changes.
  const body=(patch:Partial<ApiRequest['body']>)=>{
    const current=latest.current.value.body
    if(patch.mode&&patch.mode!==current.mode)cancelUploads()
    update({body:{...current,...patch}})
  }
  // Merge edited fields into the current authentication configuration.
  const auth=(patch:Partial<ApiRequest['auth']>)=>update({auth:{...value.auth,...patch}})
  // Update one body field while preserving its upload identity.
  const field=(index:number,patch:Partial<BodyField>)=>body({fields:latest.current.value.body.fields.map((item,i)=>{
    if(i!==index)return item
    const next={...item,...patch}
    rowKeys.current.set(next,rowKey(item))
    return next
  })})
  // Read a size-limited file and apply it only if the matching input is still current.
  function upload(file:File|undefined,index?:number){
    if(!file)return
    if(file.size>1048576){setError('文件不能超过 1 MiB');return}
    const row=index===undefined?-1:rowKey(value.body.fields[index])
    readers.current.get(row)?.abort()
    const reader=new FileReader()
    readers.current.set(row,reader)
    reader.onload=()=>{
      if(readers.current.get(row)!==reader)return
      readers.current.delete(row)
      const current=latest.current.value.body
      const data_base64=String(reader.result).split(',',2)[1]
      if(row===-1&&current.mode==='binary')body({filename:file.name,data_base64})
      if(row!==-1&&current.mode==='formdata'){
        const target=current.fields.findIndex(item=>rowKey(item)===row&&item.type==='file')
        if(target!==-1)field(target,{filename:file.name,data_base64,content_type:file.type||'application/octet-stream'})
      }
      setError('')
    }
    reader.onerror=()=>{
      if(readers.current.get(row)!==reader)return
      readers.current.delete(row);setError('读取文件失败')
    }
    reader.readAsDataURL(file)
  }
  return <div className="api-request-editor">
    {error&&<p role="alert" className="api-error">{error}</p>}
    {!!value.compatibility_warnings.length&&<div className="api-warning"><strong>导入内容需要检查</strong>{value.compatibility_warnings.map((note,i)=><p key={i}>{note}</p>)}<button type="button" className="secondary-button" onClick={()=>update({compatibility_warnings:[]})}>已检查，仅执行当前 HTTP 配置</button></div>}
    <div className="field-grid"><label className="field"><span>请求名称</span><input value={value.name} maxLength={200} onChange={e=>update({name:e.target.value})}/></label><label className="field"><span>所属集合</span><select aria-label="所属集合" value={value.collection_id??''} onChange={e=>update({collection_id:e.target.value||null})}><option value="">未分组</option>{collections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <div className="api-url-row"><label><span className="sr-only">HTTP 方法</span><select aria-label="HTTP 方法" value={value.method} onChange={e=>update({method:e.target.value})}>{['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(method=><option key={method}>{method}</option>)}</select></label><input aria-label="请求 URL" value={value.url} placeholder="https://api.example.com/resource 或 {{api_root}}/resource" onChange={e=>update({url:e.target.value})}/></div>
    {folders&&<label className="field"><span>请求文件夹</span><select aria-label="请求文件夹" value={value.folder_id??''} onChange={e=>update({folder_id:e.target.value||null,position:0})}><option value="">集合根目录</option>{folders.filter(item=>item.collection_id===value.collection_id).map(item=><option key={item.id} value={item.id}>{folderPath(item,folders)} · {item.id.slice(0,6)}</option>)}</select></label>}
    <div className="api-tabs" role="tablist" aria-label="请求配置">{[['params','Params'],['headers','Headers'],['auth','Authorization'],['body','Body'],['assertions','断言'],['extractions','提取'],['variables','变量'],['settings','设置']].map(([id,label])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}{id==='assertions'&&value.assertions.length?` (${value.assertions.length})`:''}</button>)}</div>
    <div className="api-tab-content" key={tab}>
      {tab==='params'&&<PairsEditor value={value.query} onChange={query=>update({query})} label="参数"/>}
      {tab==='headers'&&<PairsEditor value={value.headers} onChange={headers=>update({headers})} label="请求头"/>}
      {tab==='auth'&&<><label className="field"><span>鉴权方式</span><select value={value.auth.type} onChange={e=>auth({type:e.target.value as ApiRequest['auth']['type']})}><option value="none">No Auth</option><option value="basic">Basic Auth</option><option value="bearer">Bearer Token</option><option value="api_key">API Key</option></select></label>
        {value.auth.type==='basic'&&<div className="field-grid"><label className="field"><span>用户名</span><input autoComplete="off" value={value.auth.username} onChange={e=>auth({username:e.target.value})}/></label><label className="field"><span>密码</span><input type="password" autoComplete="off" value={value.auth.password} onChange={e=>auth({password:e.target.value})}/></label></div>}
        {value.auth.type==='bearer'&&<label className="field"><span>Token</span><input type="password" autoComplete="off" value={value.auth.token} placeholder="{{access_token}}" onChange={e=>auth({token:e.target.value})}/></label>}
        {value.auth.type==='api_key'&&<div className="field-grid"><label className="field"><span>Key 名称</span><input value={value.auth.key} onChange={e=>auth({key:e.target.value})}/></label><label className="field"><span>Key 值</span><input type="password" autoComplete="off" value={value.auth.value} onChange={e=>auth({value:e.target.value})}/></label><label className="field"><span>添加位置</span><select value={value.auth.location} onChange={e=>auth({location:e.target.value as 'header'|'query'})}><option value="header">Header</option><option value="query">Query Params</option></select></label></div>}
        <p className="quiet-note">鉴权配置加密保存在本机，历史和报告脱敏。推荐使用环境变量引用。</p></>}
      {tab==='body'&&<><label className="field"><span>请求体类型</span><select value={value.body.mode} onChange={e=>body({mode:e.target.value as ApiRequest['body']['mode']})}>{[['none','none'],['json','JSON'],['raw','Raw / 文本'],['urlencoded','x-www-form-urlencoded'],['formdata','form-data'],['binary','Binary 文件']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        {['json','raw'].includes(value.body.mode)&&<><label className="field"><span>请求正文</span><textarea className="mono api-code" value={value.body.text} placeholder={value.body.mode==='json'?'提示：JSON 字符串中的 {{变量}} 可保留数字、对象等原始类型':'请求正文'} onChange={e=>body({text:e.target.value})}/></label>{value.body.mode==='raw'&&<label className="field"><span>Content-Type</span><input value={value.body.content_type} onChange={e=>body({content_type:e.target.value})}/></label>}</>}
        {['urlencoded','formdata'].includes(value.body.mode)&&<><button type="button" className="text-button" onClick={()=>body({fields:[...value.body.fields,newBodyField()]})}><Plus size={14}/>添加表单字段</button>{value.body.fields.map((item,index)=><div key={rowKey(item)} className="api-form-field"><div className="api-kv"><input aria-label={`表单字段 ${index+1} 启用`} type="checkbox" checked={item.enabled} onChange={e=>field(index,{enabled:e.target.checked})}/><input aria-label={`表单字段 ${index+1} 名称`} placeholder="名称" value={item.key} onChange={e=>field(index,{key:e.target.value})}/>{value.body.mode==='formdata'&&<select aria-label={`表单字段 ${index+1} 类型`} value={item.type} onChange={e=>field(index,{type:e.target.value as 'text'|'file'})}><option value="text">Text</option><option value="file">File</option></select>}{item.type==='file'&&value.body.mode==='formdata'?<label className="api-file"><input type="file" aria-label={`表单文件 ${index+1}`} onChange={e=>void upload(e.target.files?.[0],index)}/><small>{item.filename} · {item.data_base64?'已读取':'未选择'}</small></label>:<input aria-label={`表单字段 ${index+1} 值`} placeholder="值或 {{变量}}" value={item.value} onChange={e=>field(index,{value:e.target.value})}/>}<button type="button" className="icon-button" aria-label={`删除表单字段 ${index+1}`} onClick={()=>body({fields:value.body.fields.filter((_,i)=>i!==index)})}><X size={14}/></button></div></div>)}</>}
        {value.body.mode==='binary'&&<label className="field"><span>上传文件（最多 1 MiB）</span><input type="file" onChange={e=>void upload(e.target.files?.[0])}/><small>{value.body.filename} · {value.body.data_base64?'已读取':'未选择'}</small></label>}</>}
      {tab==='assertions'&&<><div className="section-title"><strong>响应断言</strong><button type="button" className="text-button" onClick={()=>update({assertions:[...value.assertions,{kind:'status_code',expected:200,path:null}]})}><Plus size={14}/>添加断言</button></div>{value.assertions.map((item,index)=><AssertionRow key={index} value={item} onChange={assertion=>update({assertions:value.assertions.map((row,i)=>i===index?assertion:row)})} onRemove={()=>update({assertions:value.assertions.filter((_,i)=>i!==index)})}/>)}{!value.assertions.length&&<p className="quiet-note">当前没有断言，收到 HTTP 响应即完成；可添加状态码、字段和耗时检查。</p>}</>}
      {tab==='extractions'&&<><div className="section-title"><strong>响应提取</strong><button type="button" className="text-button" onClick={()=>update({extractions:[...value.extractions,{key:'',source:'json',path:'$.id',required:true,secret:false}]})}><Plus size={14}/>添加提取</button></div>{value.extractions.map((item,index)=><div key={index} className="api-extraction"><input aria-label={`提取 ${index+1} 变量名`} value={item.key} placeholder="变量名" onChange={e=>update({extractions:value.extractions.map((row,i)=>i===index?{...row,key:e.target.value}:row)})}/><select aria-label={`提取 ${index+1} 来源`} value={item.source} onChange={e=>update({extractions:value.extractions.map((row,i)=>i===index?{...row,source:e.target.value as Extraction['source']}:row)})}><option value="json">JSON</option><option value="header">Header</option><option value="cookie">Cookie</option></select><input aria-label={`提取 ${index+1} 路径`} value={item.path} placeholder="$.data[0].id" onChange={e=>update({extractions:value.extractions.map((row,i)=>i===index?{...row,path:e.target.value}:row)})}/><label className="check-line"><input type="checkbox" checked={item.required} onChange={e=>update({extractions:value.extractions.map((row,i)=>i===index?{...row,required:e.target.checked}:row)})}/>必需</label><label className="check-line"><input type="checkbox" checked={item.secret} onChange={e=>update({extractions:value.extractions.map((row,i)=>i===index?{...row,secret:e.target.checked}:row)})}/>敏感</label><button type="button" className="icon-button" aria-label={`删除提取 ${index+1}`} onClick={()=>update({extractions:value.extractions.filter((_,i)=>i!==index)})}><X size={14}/></button></div>)}<p className="quiet-note">提取值用于同一集合运行或同一用例的后续节点，不改写已保存环境。JSON 路径支持 $.data[0].id。</p></>}
      {tab==='variables'&&<VariablesEditor value={value.variables} onChange={variables=>update({variables})}/>}
      {tab==='settings'&&<><div className="field-grid"><label className="field"><span>超时（ms）</span><input type="number" min={100} max={120000} value={value.timeout_ms} onChange={e=>update({timeout_ms:Number(e.target.value)})}/></label><label className="field"><span>代理</span><select value={value.proxy} onChange={e=>update({proxy:e.target.value as ApiRequest['proxy']})}><option value="direct">直连（默认）</option><option value="system">系统代理</option></select></label></div><label className="check-line"><input type="checkbox" checked={value.follow_redirects} onChange={e=>update({follow_redirects:e.target.checked})}/>跟随重定向（逐跳校验允许的主机）</label><p className="quiet-note">响应与上传最多 1 MiB，TLS 证书保持校验。Cookie 仅在一次集合运行或用例内复用。</p></>}
    </div>
  </div>
}

// Edit a single assertion while keeping partially typed values visible.
function AssertionRow({value,onChange,onRemove}:{value:ApiAssertion;onChange:(value:ApiAssertion)=>void;onRemove:()=>void}){
  // Show string expectations directly and format other values as JSON.
  const stringify=(input:unknown)=>typeof input==='string'?input:JSON.stringify(input)
  const [text,setText]=useState(stringify(value.expected))
  const lastExpected=useRef(value.expected)
  useEffect(()=>{if(!Object.is(lastExpected.current,value.expected)){lastExpected.current=value.expected;setText(stringify(value.expected))}},[value.expected])
  // Update the typed text and use its parsed JSON value when valid.
  function expected(text:string){setText(text);let result:unknown=text;try{result=JSON.parse(text)}catch{/* Keep partially typed values editable. */}lastExpected.current=result;onChange({...value,expected:result})}
  return <div className="api-assertion"><select aria-label="API 断言类型" value={value.kind} onChange={e=>{const kind=e.target.value as ApiAssertion['kind'];const initial=kind==='status_code'?200:kind==='response_time_less_than'?1000:kind==='json_field_exists'?true:'';setText(stringify(initial));onChange({...value,kind,expected:initial})}}>{Object.entries(assertionLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>{['json_field_equals','json_field_exists','header_equals'].includes(value.kind)&&<input aria-label="API 断言路径" value={value.path??''} placeholder={value.kind==='header_equals'?'Content-Type':'$.data[0].id'} onChange={e=>onChange({...value,path:e.target.value})}/>}<input aria-label="API 断言预期值" value={text??''} onChange={e=>expected(e.target.value)} placeholder="预期值（JSON 或文本）"/><button type="button" className="icon-button" aria-label="删除 API 断言" onClick={onRemove}><X size={14}/></button></div>
}
