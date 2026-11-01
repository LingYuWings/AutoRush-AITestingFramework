export type Pair = {key:string; value:string; enabled:boolean}
export type Variable = {key:string; value:unknown; enabled:boolean; secret:boolean}
export type BodyField = {key:string; value:string; type:'text'|'file'; filename:string; content_type:string; data_base64:string; enabled:boolean}
export type ApiAssertion = {kind:'status_code'|'body_contains'|'json_field_equals'|'json_field_exists'|'header_equals'|'response_time_less_than'; path:string|null; expected:unknown}
export type Extraction = {key:string; source:'json'|'header'|'cookie'; path:string; required:boolean; secret:boolean}
export type ApiRequest = {
  name:string; collection_id:string|null; folder_id?:string|null; position?:number; method:string; url:string; query:Pair[]; headers:Pair[];
  auth:{type:'none'|'basic'|'bearer'|'api_key'; username:string; password:string; token:string; key:string; value:string; location:'header'|'query'};
  body:{mode:'none'|'json'|'raw'|'urlencoded'|'formdata'|'binary'; text:string; content_type:string; fields:BodyField[]; filename:string; data_base64:string};
  variables:Variable[]; assertions:ApiAssertion[]; extractions:Extraction[]; timeout_ms:number;
  follow_redirects:boolean; proxy:'direct'|'system'; compatibility_warnings:string[]
}
export type Collection = {name:string; description:string; variables:Variable[]}
export type RecordOf<T> = T & {id:string; version:number; created_at:string; updated_at:string}
export type ApiRequestRecord = RecordOf<ApiRequest>
export type CollectionRecord = RecordOf<Collection>
export type Folder = {name:string;collection_id:string;parent_id:string|null;description:string;position:number}
export type FolderRecord = RecordOf<Folder>
export type ApiExecution = {
  id?:string; created_at?:string; request_id?:string|null; name:string; method:string; url:string;
  status:'passed'|'failed'|'error'|'blocked'|'skipped'; detail:string; elapsed_ms:number;
  request?:Record<string,unknown>; response:{status_code:number; body:unknown; text:string; headers:Record<string,string>; elapsed_ms:number; bytes:number; url:string; history_truncated?:boolean}|null;
  assertions:{passed:boolean;detail:string}[]; extracted:Record<string,unknown>
}
export type CollectionResult = {status:ApiExecution['status']; results:ApiExecution[]; detail?:string}
export type ImportResult = {collections:CollectionRecord[]; requests:ApiRequestRecord[]; environments:CollectionRecord[];folders?:FolderRecord[]; warnings:string[]}
export const newRequest=():ApiRequest=>({name:'未命名请求',collection_id:null,method:'GET',url:'',query:[],headers:[],
  auth:{type:'none',username:'',password:'',token:'',key:'X-API-Key',value:'',location:'header'},
  body:{mode:'none',text:'',content_type:'text/plain',fields:[],filename:'upload.bin',data_base64:''},
  variables:[],assertions:[],extractions:[],timeout_ms:10000,follow_redirects:false,proxy:'direct',compatibility_warnings:[]})
export const newPair=():Pair=>({key:'',value:'',enabled:true})
export const newBodyField=():BodyField=>({key:'',value:'',type:'text',filename:'upload.bin',content_type:'application/octet-stream',data_base64:'',enabled:true})
export function configuration<T extends object>(record:T):T {const copy={...record} as T&Partial<{id:string;version:number;created_at:string;updated_at:string}>; delete copy.id;delete copy.version;delete copy.created_at;delete copy.updated_at;return copy}

export function folderPath(folder:FolderRecord,folders:FolderRecord[],seen=new Set<string>()):string {if(seen.has(folder.id))return folder.name;seen.add(folder.id);const parent=folders.find(item=>item.id===folder.parent_id);return (parent?folderPath(parent,folders,seen)+' / ':'')+folder.name}
