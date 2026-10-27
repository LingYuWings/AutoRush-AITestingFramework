export type DriverKind = 'api' | 'web' | 'android' | 'desktop'
export type ResultStatus = 'passed' | 'failed' | 'error' | 'blocked' | 'skipped'
export type AssertionKind =
  | 'status_code' | 'json_field_equals' | 'body_contains'
  | 'url_equals' | 'url_contains' | 'text_contains' | 'element_visible' | 'pixel_rgb_equals' | 'package_equals'

export interface AssertionSpec {
  kind: AssertionKind
  expected: unknown
  path?: string | null
}

export interface StepSpec {
  order: number
  intent: string
  expected_result?: string | null
  driver: DriverKind
  operation: string
  parameters: Record<string, unknown>
  assertions: AssertionSpec[]
  always_run: boolean
}

export interface CaseRecord {
  id: string
  version: number
  status: 'draft' | 'approved'
  title: string
  description: string
  execution_mode?: 'structured' | 'agent'
  platform?: DriverKind | null
  source_case_id?: string | null
  archived_at?: string | null
  steps: StepSpec[]
  postconditions: StepSpec[]
  created_at: string
}

export interface DesktopTarget {
  hwnd:number; pid:number; process_started_at:string; title:string; screen_width:number; screen_height:number
}
export interface AutomationCapabilities {
  web:{available:boolean;browser:string};desktop:{enabled:boolean;available:boolean;reason:string|null;primary_monitor_only:boolean}
}
export interface PlanRecord {
  agent_options?: AgentOptions | null
  id: string
  version: number
  status: 'draft' | 'ready'
  name: string
  environment: string
  case_ids: string[]
  api_base_url: string | null
  web_base_url: string | null
  web_headless: boolean
  web_viewport: {width:number;height:number}
  desktop_target: DesktopTarget | null
  desktop_start_delay_seconds: number
  android_device_id: string | null
  android_package: string | null
  capture_screenshots: boolean
  created_at: string
}

export type PlanPayload = Pick<PlanRecord, 'name' | 'environment' | 'case_ids'> & Partial<Pick<PlanRecord,
  'api_base_url' | 'web_base_url' | 'android_device_id' | 'android_package' | 'capture_screenshots' | 'web_headless' | 'web_viewport' | 'desktop_target' | 'desktop_start_delay_seconds' | 'agent_options'>>

export interface AgentOptions {provider_config_id:string;max_rounds_per_step:number;max_rounds_per_case:number;model_timeout_seconds:number;case_timeout_seconds:number}
export interface AgentTraceRecord {round?:number;operation?:string|null;brief_reason?:string;error?:string;verification_kind?:string;model?:{latency_ms:number;attempts:number};result?:{status:ResultStatus;detail?:string;assertions?:string[];evidence?:Record<string,unknown>};observation?:{screenshot?:ScreenshotEvidence}}
export interface AgentExecution {id:string;plan_id:string;state:'running'|'stopping'|'finished'|'interrupted';progress:{completed_cases?:{status:ResultStatus;steps:StepResult[]}[];active?:{active_step?:{intent:string;expected_result:string;traces:AgentTraceRecord[]};rounds_used?:number;pending_action?:AgentTraceRecord}};termination_reason:string|null;final_run_id:string|null;created_at:string}

export interface ScreenshotEvidence {
  file: string
  url: string
  sha256: string
  bytes: number
  mime_type: string
  captured_at: number
  package?: string
  driver?: DriverKind
  target?: Record<string, unknown>
  width: number
  height: number
}

export interface StepResult {
  order: number
  intent: string
  status: ResultStatus
  detail: string
  assertions: string[]
  evidence: Record<string, unknown>
}

export interface RunRecord {
  termination_reason?: string | null
  id: string
  plan_id: string
  status: ResultStatus
  cases: { case_id: string; title: string; status: ResultStatus; steps: StepResult[] }[]
  created_at: string
  report_path: string | null
  report_paths: Record<string, string>
}

export type CredentialType = 'api_key' | 'token_plan' | 'coding_plan' | 'local'
export type ModelCapability = 'text_only' | 'structured_output' | 'tool_calling' | 'vision'

export interface ProviderPreset {
  id: string
  display_name: string
  regions: string[]
  protocols: string[]
  credential_types: CredentialType[]
  capabilities: ModelCapability[]
  suggested_base_url: string | null
  documentation_url: string | null
  compliance_note: string
}

export interface ProviderConfigPayload {
  name: string
  provider_id: string
  region: string
  credential_type: CredentialType
  protocol: string
  base_url: string
  secret_ref: string | null
  model_id: string
  capabilities: ModelCapability[]
}

export interface ProviderConfig extends ProviderConfigPayload {
  id: string
  status: 'unverified' | 'verified'
  created_at: string
  vision_verified?: boolean
}

export interface LocalModelRuntime {id:string;name:string;base_url:string;models:string[];latency_ms:number}
export interface LocalModelDiscovery {runtimes:LocalModelRuntime[];scanned:number;duration_ms:number}
export interface ProviderVisionTest {config_id:string;verified:boolean;request_id:string|null;latency_ms:number;message:string}
export type ModelCatalogPayload=Pick<ProviderConfigPayload,'provider_id'|'region'|'credential_type'|'protocol'|'base_url'|'secret_ref'>

export interface ProviderPreflight {
  config_id: string
  configuration_valid: boolean
  secret_available: boolean
  connection_tested: boolean
  messages: string[]
}

export interface ProviderConnectionTest {
  config_id: string
  connected: boolean
  request_id: string | null
  latency_ms: number
  usage: Record<string, unknown>
  message: string
}

export interface CaseCompilePayload {
  provider_config_id: string
  title: string
  description: string
  steps: { intent: string; driver: 'api' | 'web'; always_run: boolean }[]
  postconditions: { intent: string; driver: 'api' | 'web'; always_run: boolean }[]
}

export interface CaseCompileResult {
  draft: Pick<CaseRecord, 'title' | 'description' | 'steps' | 'postconditions'>
  provider_id: string
  model_id: string
  request_id: string | null
  usage: Record<string, unknown>
  warnings: string[]
}

export interface AdbDevice {
  serial: string
  model: string
  state: string
}

export interface OperatorSession {
  operator_token: string
  usb_server_url: string
  adb_devices: AdbDevice[]
  adb_error?: string
}

export interface PairingPayload {
  connection: 'usb' | 'wss' | 'lan'
  adb_serial?: string
  server_url?: string
  allowed_packages: string[]
  expires_in?: number
}

export interface PairingRecord {
  id: string
  expires_at: string
  server_url: string
  allowed_packages: string[]
  status: 'pending' | 'claimed' | 'expired' | 'cancelled'
  device_id: string | null
}

export interface CreatedPairing extends PairingRecord {
  qr_payload: string
}

export interface LocalDeviceServer {
  running: boolean
  addresses: string[]
  port: number
  host?: string
  server_url?: string
  tls_sha256?: string
}

export interface PairedDevice {
  device_id: string
  manufacturer: string
  model: string
  sdk_int: number
  paired_at: string
  revoked: boolean
  online: boolean
}

interface EventEnvelope {
  id: string
  created_at: string
}

export type PlatformEvent = EventEnvelope & (
  | { type: 'stream.ready'; payload: Record<string, never> }
  | { type: 'run.started'; payload: { run_id: string; plan_id: string; case_count: number } }
  | { type: 'case.completed'; payload: { run_id: string; plan_id: string; case_id: string; status: ResultStatus; completed: number; total: number } }
  | { type: 'report.ready'; payload: { run_id: string; plan_id: string; status: ResultStatus; report_url: string } }
  | { type: 'agent.run.failed'; payload: {run_id:string;reason?:string} }
  | { type: 'agent.action.completed'; payload: {case_id:string;step:number;round:number;operation:string;status:ResultStatus} }
)

const API_BASE = window.location.protocol === 'app:' ? 'http://127.0.0.1:8000' : ''
let operatorToken = ''
const operatorListeners = new Set<() => void>()

function socketBase() {
  return window.location.protocol === 'app:' ? 'ws://127.0.0.1:8000'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
}

export async function request<T>(path: string, init?: RequestInit, authenticated = true): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(authenticated && operatorToken ? { 'X-Autorush-Operator-Token': operatorToken } : {}), ...init?.headers },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new Error('无法连接本地后端，请先启动 127.0.0.1:8000 上的服务。')
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (typeof body.detail === 'string') detail = body.detail
      else if (Array.isArray(body.detail)) {
        // Validation responses can include the rejected input. Keep only field names and messages.
        detail = body.detail.map((item: { loc?: unknown[]; msg?: unknown }) =>
          `${Array.isArray(item.loc) ? item.loc.filter(part => typeof part === 'string' || typeof part === 'number').join('.') : '请求'}: ${typeof item.msg === 'string' ? item.msg : '参数无效'}`).join('；')
      }
    } catch { /* use HTTP status */ }
    if (operatorToken) detail = detail.replaceAll(operatorToken, '[已隐藏]')
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const post = <T>(path: string, payload?: unknown) => request<T>(path, {
  method: 'POST',
  body: payload === undefined ? undefined : JSON.stringify(payload),
})

export const api = {
  discoverLocalModels:()=>request<LocalModelDiscovery>('/api/v1/providers/local-models'),
  modelCatalog:(payload:ModelCatalogPayload)=>post<{models:string[]}>('/api/v1/providers/model-catalog',payload),
  testProviderVision:(id:string)=>post<ProviderVisionTest>(`/api/v1/providers/configs/${encodeURIComponent(id)}/vision-test`),
  automationCapabilities: () => request<AutomationCapabilities>('/api/v1/automation/capabilities'),
  desktopWindows: () => request<{windows:DesktopTarget[]}>('/api/v1/automation/desktop/windows'),
  setOperatorToken: (token: string) => {
    const next = token.trim()
    if (next === operatorToken) return
    operatorToken = next
    operatorListeners.forEach(listener => listener())
  },
  getOperatorToken: () => operatorToken,
  onOperatorTokenChange: (listener: () => void) => {
    operatorListeners.add(listener)
    return () => { operatorListeners.delete(listener) }
  },
  screenUrl: (id: string) => `${socketBase()}/api/v1/devices/${encodeURIComponent(id)}/screen/ws`,
  adbScreenUrl: () => `${socketBase()}/api/v1/devices/adb/screen/ws`,
  adbDevices: () => request<{ devices: AdbDevice[]; error?: string }>('/api/v1/devices/adb'),
  screenshot: async (path: string, signal?: AbortSignal): Promise<Blob> => {
    if (!/^\/api\/v1\/runs\/[A-Za-z0-9-]+\/(?:screenshots|evidence)\/[A-Za-z0-9_-]+\.jpg$/.test(path)) throw new Error('截图资源地址无效')
    const response = await fetch(`${API_BASE}${path}`, { signal, cache: 'no-store', headers: operatorToken ? { 'X-Autorush-Operator-Token': operatorToken } : {} })
    if (!response.ok) throw new Error(`截图加载失败：${response.status}`)
    if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'image/jpeg') throw new Error('截图格式无效')
    return response.blob()
  },
  operatorSession: () => request<OperatorSession>('/api/v1/devices/operator-session', undefined, false),
  localDeviceServer: () => request<LocalDeviceServer>('/api/v1/devices/local-server'),
  startLocalDeviceServer: () => post<LocalDeviceServer>('/api/v1/devices/local-server/start'),
  stopLocalDeviceServer: () => post<LocalDeviceServer>('/api/v1/devices/local-server/stop'),
  createPairing: (payload: PairingPayload) => post<CreatedPairing>('/api/v1/devices/pairings', payload),
  pairing: (id: string) => request<PairingRecord>(`/api/v1/devices/pairings/${encodeURIComponent(id)}`),
  cancelPairing: (id: string) => post<PairingRecord>(`/api/v1/devices/pairings/${encodeURIComponent(id)}/cancel`),
  pairedDevices: () => request<PairedDevice[]>('/api/v1/devices/paired'),
  revokeDevice: (id: string) => post<{ device_id: string; revoked: true }>(`/api/v1/devices/paired/${encodeURIComponent(id)}/revoke`),
  devices: () => request<{ devices: string[] }>('/api/v1/devices'),
  deviceInfo: (id: string) => post<Record<string, unknown>>(`/api/v1/devices/${encodeURIComponent(id)}/commands`, { method: 'device.info', params: {} }),
  health: () => request<{ status: string }>('/health'),
  cases: (includeArchived=false) => request<CaseRecord[]>('/api/v1/cases'+(includeArchived?'?include_archived=true':'')),
  createCase: (payload: Pick<CaseRecord, 'title' | 'description' | 'execution_mode' | 'platform' | 'steps' | 'postconditions'>) => post<CaseRecord>('/api/v1/cases', payload),
  updateCase:(id:string,version:number,payload:Pick<CaseRecord,'title'|'description'|'execution_mode'|'platform'|'steps'|'postconditions'>)=>request<CaseRecord>(`/api/v1/cases/${id}?expected_version=${version}`,{method:'PUT',body:JSON.stringify(payload)}),
  archiveCase:(id:string)=>request<CaseRecord>(`/api/v1/cases/${id}`,{method:'DELETE'}),
  restoreCase:(id:string)=>post<CaseRecord>(`/api/v1/cases/${id}/restore`),
  compileCase: (payload: CaseCompilePayload) => post<CaseCompileResult>('/api/v1/cases/compile', payload),
  approveCase: (id: string) => post<CaseRecord>(`/api/v1/cases/${id}/approve`),
  plans: () => request<PlanRecord[]>('/api/v1/plans'),
  createPlan: (payload: PlanPayload) => post<PlanRecord>('/api/v1/plans', payload),
  readyPlan: (id: string) => post<PlanRecord>(`/api/v1/plans/${id}/ready`),
  runPlan: (id: string) => post<RunRecord>(`/api/v1/plans/${id}/runs`),
  startAgentRun:(id:string,key:string)=>post<AgentExecution>(`/api/v1/plans/${id}/agent-runs`,{idempotency_key:key}),
  agentRuns:()=>request<AgentExecution[]>('/api/v1/agent-runs'),
  agentRun:(id:string)=>request<AgentExecution>(`/api/v1/agent-runs/${id}`),
  cancelAgentRun:(id:string)=>post<AgentExecution>(`/api/v1/agent-runs/${id}/cancel`),
  runs: () => request<RunRecord[]>('/api/v1/runs'),
  providerPresets: () => request<ProviderPreset[]>('/api/v1/providers/presets'),
  providerConfigs: () => request<ProviderConfig[]>('/api/v1/providers/configs'),
  createProviderConfig: (payload: ProviderConfigPayload) => post<ProviderConfig>('/api/v1/providers/configs', payload),
  preflightProvider: (id: string) => post<ProviderPreflight>(`/api/v1/providers/configs/${id}/preflight`),
  testProviderConnection: (id: string) => post<ProviderConnectionTest>(`/api/v1/providers/configs/${id}/test-connection`),
  watchEvents: (onEvent: (event: PlatformEvent) => void, onClosed: () => void) => {
    const base = window.location.protocol === 'app:'
      ? 'ws://127.0.0.1:8000'
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const socket = new WebSocket(`${base}/api/v1/events/ws`)
    socket.onmessage = message => {
      try { onEvent(JSON.parse(message.data) as PlatformEvent) }
      catch { /* Ignore malformed local events. */ }
    }
    socket.onclose = onClosed
    return () => socket.close()
  },
  downloadReport: async (id: string, format: 'json' | 'html' | 'junit' = 'json') => {
    const response = await fetch(`${API_BASE}/api/v1/runs/${id}/report/${format}`, { cache: 'no-store', headers: operatorToken ? { 'X-Autorush-Operator-Token': operatorToken } : {} })
    if (!response.ok) throw new Error(`报告下载失败：${response.status}`)
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = `${id}.${format === 'junit' ? 'xml' : format}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
