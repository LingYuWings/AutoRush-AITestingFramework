// Describe editable startup settings and call the trusted local configuration API.
import { api, ApiRequestError, request } from '../../shared/api'

export const sections = [
  ['general', '常规'], ['network', '网络'], ['storage', '存储与日志'],
  ['execution', '执行环境'], ['models', '模型'], ['integrations', '集成'],
] as const
export type Section = typeof sections[number][0]
type PathKind = 'directory' | 'file' | 'database'
type Field = readonly [key: string, label: string, kind?: PathKind | 'port' | 'switch', hint?: string]
export const fields: Partial<Record<Section, readonly Field[]>> = {
  network: [
    ['AUTORUSH_ALLOWED_API_HOSTS', 'API 主机名单', undefined, '用逗号分隔主机名或 IP。留空允许所有 HTTP(S) 主机。'],
    ['AUTORUSH_ALLOWED_WEB_HOSTS', 'Web 主机名单', undefined, '用逗号分隔主机名或 IP。留空不允许 Web 目标。'],
    ['AUTORUSH_ALLOWED_LLM_HOSTS', '模型主机名单', undefined, '用逗号分隔远程模型主机。免密钥的环回模型可直接使用。'],
    ['AUTORUSH_BACKEND_PORT', '后端端口', 'port'], ['AUTORUSH_FRONTEND_PORT', '开发前端端口', 'port'],
    ['AUTORUSH_LOCAL_DEVICE_PORT', 'Android 配对端口', 'port'],
  ],
  storage: [
    ['AUTORUSH_LOG_DIR', '日志目录', 'directory'], ['AUTORUSH_DB_PATH', 'SQLite 数据库文件', 'database', '切换文件后使用目标数据库。已有数据不会自动迁移。'],
    ['AUTORUSH_REPORT_DIR', '报告与截图目录', 'directory', '新报告和截图将写入此处。已有文件不会自动迁移。'],
  ],
  execution: [
    ['AUTORUSH_DESKTOP_ENABLED', 'Windows 桌面自动化', 'switch'],
    ['PLAYWRIGHT_BROWSERS_PATH', 'Playwright 浏览器目录', 'directory'],
    ['AUTORUSH_VITE_CACHE_DIR', 'Vite 缓存目录', 'directory'],
  ],
  models: [['AUTORUSH_LOCAL_VISION_LAUNCHER', '本地视觉模型启动脚本', 'file']],
  integrations: [
    ['AUTORUSH_MCP_API_URL', 'MCP 后端地址'], ['AUTORUSH_MCP_CONSOLE_ORIGIN', 'MCP 控制台来源'],
    ['AUTORUSH_MCP_ALLOWED_PACKAGES', 'MCP Android 包名名单', undefined, '用逗号分隔允许测试的应用包名。'],
  ],
}

export type Overrides = Record<string, string | null>
export type RuntimeSnapshot = {
  effective: Record<string, string>
  overrides: Record<string, string>
  path: string
  mode: string
  locked: string[]
  portal_token_configured: boolean
  operator_token_configured: boolean
}

// Acquire the local operator credential when required and retry an expired credential once.
export async function runtimeSettings(overrides?: Overrides): Promise<RuntimeSnapshot> {
  const send = () => request<RuntimeSnapshot>('/api/v1/runtime-settings', overrides ? {
    method: 'PUT', body: JSON.stringify({ overrides }),
  } : undefined)
  if (!api.getOperatorToken()) api.setOperatorToken((await api.operatorSession()).operator_token)
  try { return await send() }
  catch (error) {
    if (!(error instanceof ApiRequestError) || ![403, 503].includes(error.status)) throw error
    api.setOperatorToken((await api.operatorSession()).operator_token)
    return send()
  }
}
