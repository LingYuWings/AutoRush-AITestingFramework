// Present the console preferences and categorized startup settings.
import { useEffect, useId, useState } from 'react'
import { switchUiLanguage, uiLanguage, uiText, type UiLanguage } from '../shared/i18n.ts'
import { LOCAL_BACKEND_ADDRESS, type ProviderConfig, type ProviderConfigPayload, type ProviderPreflight, type ProviderPreset } from '../shared/api'
import { PageHeader } from '../components/ui'
import ProviderSettings from '../features/settings/ProviderSettings'
import RuntimePanel from '../features/settings/RuntimePanel'
import { runtimeSettings, sections, type Overrides, type RuntimeSnapshot, type Section } from '../features/settings/runtime'
import '../features/settings/runtime-settings.css'

const boundaries = [
  { title: uiText("本地后端"), text: uiText("仅适合可信本机开发，尚无用户鉴权、项目隔离及生产密钥管理。") },
  { title: 'Android Portal', value: uiText("协议 v1"), text: uiText("设备端需手动启用无障碍服务与包名允许列表，使用配对令牌连接。") },
  { title: uiText("数据与报告"), value: 'SQLite', text: uiText("结果保存在本地数据库，并生成 JSON、HTML 与 JUnit XML 报告。") },
]

// Show local runtime information and provider configuration.
export default function Settings({ presets, configs, onCreate, onPreflight, section, onSection, theme, onTheme }: {
  presets: ProviderPreset[]
  configs: ProviderConfig[]
  onCreate: (payload: ProviderConfigPayload) => Promise<boolean>
  onPreflight: (id: string) => Promise<ProviderPreflight | null>
  section?: string
  onSection: (key: Section) => void
  theme: 'light' | 'dark'
  onTheme: (theme: 'light' | 'dark') => void
}) {
  const [languageError, setLanguageError] = useState(false)
  const languageLabel = useId()
  const active = sections.find(([key]) => key === section)?.[0] ?? 'general'
  const [data, setData] = useState<RuntimeSnapshot | null>(null)
  const [draft, setDraft] = useState<Overrides>({})
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = Object.keys(draft).length > 0
  const backendPort = data?.effective.AUTORUSH_BACKEND_PORT
  const backendAddress = backendPort ? `127.0.0.1:${backendPort}` : LOCAL_BACKEND_ADDRESS

  useEffect(() => {
    let current = true
    void runtimeSettings().then(value => { if (current) setData(value) })
      .catch(cause => { if (current) setError(String(cause)) })
    return () => { current = false }
  }, [attempt])

  useEffect(() => {
    if (!dirty) return
    // Warn before a browser reload would discard unsaved startup settings.
    function warnBeforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty])

  // Keep changes across tabs until the operator saves or discards them.
  function update(key: string, value: string | null) {
    setNotice('')
    setDraft(current => ({ ...current, [key]: value }))
  }

  // Save only changed overrides so other settings are preserved.
  async function save() {
    setBusy(true); setError(''); setNotice('')
    try {
      setData(await runtimeSettings(draft)); setDraft({})
      setNotice(uiText('设置已保存。请重启应用或开发服务以应用启动设置。'))
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  // Save the new console language, or leave the current preference selected if storage is unavailable.
  const changeLanguage = (language: UiLanguage) => {
    setLanguageError(false)
    try { switchUiLanguage(language) }
    catch { setLanguageError(true) }
  }

  return <>
    <PageHeader title={uiText("系统设置")} />
    <nav className="section-nav" aria-label={uiText('系统设置分类')}>
      {sections.map(([key, title]) => <a key={key} href={`#/settings/${key}`} aria-current={active === key ? 'page' : undefined}
        onClick={event => { event.preventDefault(); onSection(key) }}>{uiText(title)}</a>)}
    </nav>
    {active === 'general' && <><section className="surface settings-preferences">
      <div className="surface-header"><div>
        <h3>{uiText('界面偏好')}</h3>
        <p>{uiText('语言偏好保存在此浏览器中，切换时会重新加载当前页面。')}</p>
      </div></div>
      <label className="field">
        <span id={languageLabel}>{uiText('语言')}</span>
        <select aria-labelledby={languageLabel} value={uiLanguage} onChange={event => changeLanguage(event.target.value as UiLanguage)}>
          <option value="zh-CN" lang="zh-CN">简体中文</option>
          <option value="en" lang="en">English</option>
        </select>
      </label>
      <label className="field">
        <span>{uiText('界面主题')}</span>
        <select value={theme} onChange={event => onTheme(event.target.value === 'dark' ? 'dark' : 'light')}>
          <option value="light">{uiText('浅色模式')}</option>
          <option value="dark">{uiText('深色模式')}</option>
        </select>
      </label>
      {languageError && <p className="inline-alert error" role="alert">{uiText('无法保存语言偏好，请检查浏览器存储权限。')}</p>}
    </section>
    <section className="surface boundary-list">
      <div className="surface-header"><div><h3>{uiText("运行环境")}</h3><p>{uiText("当前为本地开发版本，以下边界尚未覆盖生产需求。")}</p></div></div>
      <dl>
        {boundaries.map(item => <div key={item.title}>
          <dt>{item.title}</dt>
          <dd className="mono">{item.value ?? backendAddress}</dd>
          <dd>{item.text}</dd>
        </div>)}
      </dl>
    </section></>}
    {active !== 'general' && <>
      <p className="quiet-note runtime-settings-note">{uiText('启动参数优先于环境变量，环境变量优先于保存的设置。保存后在下次启动时生效。')}</p>
      {data?.mode === 'external' && <p className="quiet-note runtime-settings-note">{uiText('当前后端由外部命令启动。请使用项目启动脚本读取已保存的设置。')}</p>}
      {data ? <RuntimePanel section={active} data={data} draft={draft} update={update} busy={busy} showError={setError} />
        : !error && <div className="page-loading" aria-busy="true"/>}
    </>}
    {error && <p className="inline-alert error" role="alert">{error}{!data && <button type="button" className="text-button"
      onClick={() => { setError(''); setAttempt(value => value + 1) }}>{uiText('重新连接')}</button>}</p>}
    {notice && <p className="inline-alert" role="status">{notice}</p>}
    {dirty && <div className="runtime-savebar"><span>{uiText('未保存的启动设置')}</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft({}); setError('') }}>{uiText('放弃修改')}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{uiText('保存启动设置')}</button>
    </div>}
    {active === 'models' && <ProviderSettings presets={presets} configs={configs} onCreate={onCreate} onPreflight={onPreflight} />}
  </>
}
