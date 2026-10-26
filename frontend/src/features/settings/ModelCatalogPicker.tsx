import type {CatalogState} from './model-catalog'

export default function ModelCatalogPicker({state,busy,error,onSelect,onFetch}:{
  state:CatalogState;busy:boolean;error:string;onSelect:(value:string)=>void;onFetch:()=>void
}) {
  return <div className="model-catalog-picker">
    <label className="field"><span>模型</span><select required aria-label="模型 ID" value={state.modelId} onChange={e=>onSelect(e.target.value)} disabled={!state.models.length||busy}>
      <option value="">{state.models.length?'请选择模型':'请先获取模型列表'}</option>{state.models.map(model=><option key={model} value={model}>{model}</option>)}
    </select></label>
    <button type="button" className="secondary-button" onClick={onFetch} disabled={busy||!state.baseUrl.trim()}>{busy?'获取中…':'获取模型列表'}</button>
    {error&&<p role="alert" className="quiet-note">{error}</p>}
  </div>
}
