import { uiText } from '../../shared/i18n.ts'
import {RefreshCw} from '../../components/icons'
import type {CatalogState} from './model-catalog'

// Select a discovered model and surface catalog loading and verification state.
export default function ModelCatalogPicker({state,busy,error,onSelect,onFetch}:{
  state:CatalogState;busy:boolean;error:string;onSelect:(value:string)=>void;onFetch:()=>void
}) {
  return <div className="model-catalog-picker">
    <label className="field"><span>{uiText("模型")}</span><select required aria-label={uiText("模型 ID")} value={state.modelId} onChange={e=>onSelect(e.target.value)} disabled={!state.models.length||busy}>
      <option value="">{state.models.length?uiText("请选择模型"):uiText("请先获取模型列表")}</option>{state.models.map(model=><option key={model} value={model}>{model}</option>)}
    </select></label>
    <button type="button" className="secondary-button" onClick={onFetch} disabled={busy||!state.baseUrl.trim()}><RefreshCw size={14} className={busy?'spinning':''}/>{busy?uiText("获取中…"):uiText("获取模型列表")}</button>
    {error&&<p role="alert" className="inline-alert error">{error}</p>}
  </div>
}
