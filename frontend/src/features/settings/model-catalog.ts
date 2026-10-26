import type {CredentialType} from '../../shared/api'

export interface CatalogState {
  providerId:string;region:string;credentialType:CredentialType;protocol:string;baseUrl:string;secretRef:string
  modelId:string;models:string[];verified:boolean;visionVerified:boolean
}

export function catalogKey(state:CatalogState) {
  return JSON.stringify([state.providerId,state.region,state.credentialType,state.protocol,state.baseUrl.trim(),state.secretRef.trim()])
}

export function invalidateModelSelection(state:CatalogState,changes:Partial<CatalogState>):CatalogState {
  const next={...state,...changes}
  return catalogKey(next)===catalogKey(state)?next:{...next,modelId:'',models:[],verified:false,visionVerified:false}
}

export function applyModelCatalog(state:CatalogState,response:{key:string;models:string[]}):CatalogState {
  if(response.key!==catalogKey(state))return state
  const models=[...new Set(response.models.filter(value=>typeof value==='string'&&value.trim().length>0&&value.length<=200).map(value=>value.trim()))].slice(0,200)
  return {...state,models,modelId:models.includes(state.modelId)?state.modelId:''}
}

export function finalEndpoint(base:string,protocol:string) {
  let value=base.trim().replace(/\/+$/,'').replace(/\/(chat\/completions|responses|messages|models)$/,'')
  try {if(!new URL(value).pathname||new URL(value).pathname==='/')value+='/v1'}catch{return ''}
  if(protocol==='anthropic_messages'&&!value.endsWith('/v1'))value+='/v1'
  return value+(protocol==='anthropic_messages'?'/messages':protocol==='openai_responses'?'/responses':'/chat/completions')
}
