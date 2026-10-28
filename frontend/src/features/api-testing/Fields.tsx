import type {Pair,Variable} from './types'
import {newPair} from './types'

export function PairsEditor({value,onChange,label}:{value:Pair[];onChange:(value:Pair[])=>void;label:string}){
  return <div className="api-fields"><div className="section-title"><strong>{label}</strong><button type="button" className="text-button" onClick={()=>onChange([...value,newPair()])}>添加{label}</button></div>
    {value.map((item,index)=><div className="api-kv" key={index}>
      <input aria-label={`${label} ${index+1} 启用`} type="checkbox" checked={item.enabled} onChange={e=>onChange(value.map((row,i)=>i===index?{...row,enabled:e.target.checked}:row))}/>
      <input aria-label={`${label} ${index+1} 名称`} value={item.key} placeholder="名称" onChange={e=>onChange(value.map((row,i)=>i===index?{...row,key:e.target.value}:row))}/>
      <input aria-label={`${label} ${index+1} 值`} value={item.value} placeholder="值或 {{变量}}" onChange={e=>onChange(value.map((row,i)=>i===index?{...row,value:e.target.value}:row))}/>
      <button type="button" className="icon-button" aria-label={`删除${label} ${index+1}`} onClick={()=>onChange(value.filter((_,i)=>i!==index))}>×</button>
    </div>)}{!value.length&&<p className="muted">尚未配置，可添加重复名称的条目。</p>}</div>
}

export function VariablesEditor({value,onChange}:{value:Variable[];onChange:(value:Variable[])=>void}){
  const update=(index:number,patch:Partial<Variable>)=>onChange(value.map((row,i)=>i===index?{...row,...patch}:row))
  return <div className="api-fields"><div className="section-title"><strong>变量</strong><button type="button" className="text-button" onClick={()=>onChange([...value,{key:'',value:'',enabled:true,secret:false}])}>添加变量</button></div>
    {value.map((item,index)=><div className="api-variable" key={index}>
      <input type="checkbox" aria-label={`变量 ${index+1} 启用`} checked={item.enabled} onChange={e=>update(index,{enabled:e.target.checked})}/>
      <input aria-label={`变量 ${index+1} 名称`} value={item.key} placeholder="变量名称" onChange={e=>update(index,{key:e.target.value})}/>
      <input aria-label={`变量 ${index+1} 值`} type={item.secret?'password':'text'} value={typeof item.value==='string'?item.value:JSON.stringify(item.value)} placeholder="值；env:NAME 引用后端环境变量" onChange={e=>update(index,{value:e.target.value})}/>
      <label className="check-line"><input type="checkbox" checked={item.secret} onChange={e=>update(index,{secret:e.target.checked})}/>敏感</label>
      <button type="button" className="icon-button" aria-label={`删除变量 ${index+1}`} onClick={()=>onChange(value.filter((_,i)=>i!==index))}>×</button>
    </div>)}<p className="quiet-note">使用 {'{{变量名}}'} 引用。优先级：集合 → 环境 → 运行覆盖 → 请求变量；响应提取只影响本次执行。</p></div>
}
