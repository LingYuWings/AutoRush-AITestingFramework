import { uiText } from '../../shared/i18n.ts'
import { useState } from 'react'
import {Plus,X} from '../../components/icons'
import type {Pair,Variable} from './types'
import {newPair} from './types'
import {formatPairs, parsePairs} from './workbench-format'

// Edit ordered key-value rows used by API headers and query parameters.
export function PairsEditor({value,onChange,label}:{value:Pair[];onChange:(value:Pair[])=>void;label:string}){
  const [bulk,setBulk]=useState<string|null>(null)
  const [invalidLine,setInvalidLine]=useState<number|null>(null)
  // Apply valid bulk text in one change so an invalid row never overwrites the existing request.
  const applyBulk=()=>{
    if(bulk===null)return
    const result=parsePairs(bulk)
    if('line' in result){setInvalidLine(result.line);return}
    onChange(result.rows)
    setBulk(null)
  }
  return <div className="api-fields"><div className="section-title"><strong>{label}</strong>{bulk===null&&<div className="api-toolbar">
      <button type="button" className="text-button" onClick={()=>setBulk(formatPairs(value))}>{uiText('批量编辑')}</button>
      <button type="button" className="text-button" disabled={value.length>=100} onClick={()=>onChange([...value,newPair()])}><Plus size={14}/>{uiText('添加行')}</button>
    </div>}</div>
    {bulk!==null?<><textarea className="api-code" value={bulk} aria-label={uiText('批量编辑 {0}',label)} onChange={e=>{setBulk(e.target.value);setInvalidLine(null)}}/>
      <p className="quiet-note">{uiText('每行一组 Key: Value。以 # 加空格开头可禁用该行。')}</p>
      {invalidLine!==null&&<p role="alert" className="api-error">{uiText('第 {0} 行格式无效或超出长度限制。',invalidLine)}</p>}
      <div className="api-toolbar"><button type="button" className="secondary-button" onClick={applyBulk}>{uiText('应用')}</button><button type="button" className="text-button" onClick={()=>{setBulk(null);setInvalidLine(null)}}>{uiText('取消')}</button></div>
    </>:<><div className="api-pair-table"><div className="api-pair-grid api-pair-heading" aria-hidden="true"><span/><span>Key</span><span>Value</span><span/></div>
    {value.map((item,index)=><div className="api-pair-grid" key={index}>
      <input aria-label={uiText("{0} {1} 启用", label, index+1)} type="checkbox" checked={item.enabled} onChange={e=>onChange(value.map((row,i)=>i===index?{...row,enabled:e.target.checked}:row))}/>
      <input aria-label={uiText("{0} {1} 名称", label, index+1)} value={item.key} placeholder={uiText("名称")} onChange={e=>onChange(value.map((row,i)=>i===index?{...row,key:e.target.value}:row))}/>
      <input aria-label={uiText("{0} {1} 值", label, index+1)} value={item.value} placeholder={uiText("值或 {{变量}}")} onChange={e=>onChange(value.map((row,i)=>i===index?{...row,value:e.target.value}:row))}/>
      <button type="button" className="icon-button" aria-label={uiText("删除{0} {1}", label, index+1)} onClick={()=>onChange(value.filter((_,i)=>i!==index))}><X size={14}/></button>
    </div>)}</div>{!value.length&&<p className="quiet-note">{uiText("尚未配置，可添加重复名称的条目。")}</p>}</>}</div>
}

// Edit variable rows with type and secret settings.
export function VariablesEditor({value,onChange}:{value:Variable[];onChange:(value:Variable[])=>void}){
  // Apply a patch to one variable row.
  const update=(index:number,patch:Partial<Variable>)=>onChange(value.map((row,i)=>i===index?{...row,...patch}:row))
  return <div className="api-fields"><div className="section-title"><strong>{uiText("变量")}</strong><button type="button" className="text-button" onClick={()=>onChange([...value,{key:'',value:'',enabled:true,secret:false}])}><Plus size={14}/>{uiText("添加变量")}</button></div>
    {value.map((item,index)=><div className="api-variable" key={index}>
      <input type="checkbox" aria-label={uiText("变量 {0} 启用", index+1)} checked={item.enabled} onChange={e=>update(index,{enabled:e.target.checked})}/>
      <input aria-label={uiText("变量 {0} 名称", index+1)} value={item.key} placeholder={uiText("变量名称")} onChange={e=>update(index,{key:e.target.value})}/>
      <input aria-label={uiText("变量 {0} 值", index+1)} type={item.secret?'password':'text'} value={typeof item.value==='string'?item.value:JSON.stringify(item.value)} placeholder={uiText("值；env:NAME 引用后端环境变量")} onChange={e=>update(index,{value:e.target.value})}/>
      <label className="check-line"><input type="checkbox" checked={item.secret} onChange={e=>update(index,{secret:e.target.checked})}/>{uiText("敏感")}</label>
      <button type="button" className="icon-button" aria-label={uiText("删除变量 {0}", index+1)} onClick={()=>onChange(value.filter((_,i)=>i!==index))}><X size={14}/></button>
    </div>)}<p className="quiet-note">{uiText("使用 ")}{uiText("{{变量名}}")}{uiText(" 引用。优先级：集合 → 环境 → 运行覆盖 → 请求变量；响应提取只影响本次执行。")}</p></div>
}
