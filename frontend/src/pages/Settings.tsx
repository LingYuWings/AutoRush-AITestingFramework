import { useId, useState } from 'react'
import { switchUiLanguage, uiLanguage, uiText, type UiLanguage } from '../shared/i18n.ts'
import { LOCAL_BACKEND_ADDRESS, type ProviderConfig, type ProviderConfigPayload, type ProviderPreflight, type ProviderPreset } from '../shared/api'
import { PageHeader } from '../components/ui'
import ProviderSettings from '../features/settings/ProviderSettings'

const boundaries = [
  { title: uiText("本地后端"), value: LOCAL_BACKEND_ADDRESS, text: uiText("仅适合可信本机开发，尚无用户鉴权、项目隔离及生产密钥管理。") },
  { title: 'Android Portal', value: uiText("协议 v1"), text: uiText("设备端需手动启用无障碍服务与包名允许列表，使用配对令牌连接。") },
  { title: uiText("数据与报告"), value: 'SQLite', text: uiText("结果保存在本地数据库，并生成 JSON、HTML 与 JUnit XML 报告。") },
]

// Show local runtime information and provider configuration.
export default function Settings({ presets, configs, onCreate, onPreflight }: {
  presets: ProviderPreset[]
  configs: ProviderConfig[]
  onCreate: (payload: ProviderConfigPayload) => Promise<boolean>
  onPreflight: (id: string) => Promise<ProviderPreflight | null>
}) {
  const [languageError, setLanguageError] = useState(false)
  const languageLabel = useId()

  // Save the new console language, or leave the current preference selected if storage is unavailable.
  const changeLanguage = (language: UiLanguage) => {
    setLanguageError(false)
    try { switchUiLanguage(language) }
    catch { setLanguageError(true) }
  }

  return <>
    <PageHeader title={uiText("系统设置")} />
    <section className="surface language-settings">
      <div className="surface-header"><div>
        <h3>{uiText('界面语言')}</h3>
        <p>{uiText('语言偏好保存在此浏览器中，切换时会重新加载当前页面。')}</p>
      </div></div>
      <label className="field">
        <span id={languageLabel}>{uiText('语言')}</span>
        <select aria-labelledby={languageLabel} value={uiLanguage} onChange={event => changeLanguage(event.target.value as UiLanguage)}>
          <option value="zh-CN" lang="zh-CN">简体中文</option>
          <option value="en" lang="en">English</option>
        </select>
      </label>
      {languageError && <p className="inline-alert error" role="alert">{uiText('无法保存语言偏好，请检查浏览器存储权限。')}</p>}
    </section>
    <section className="surface boundary-list">
      <div className="surface-header"><div><h3>{uiText("运行环境")}</h3><p>{uiText("当前为本地开发版本，以下边界尚未覆盖生产需求。")}</p></div></div>
      <dl>
        {boundaries.map(item => <div key={item.title}>
          <dt>{item.title}</dt>
          <dd className="mono">{item.value}</dd>
          <dd>{item.text}</dd>
        </div>)}
      </dl>
    </section>
    <ProviderSettings presets={presets} configs={configs} onCreate={onCreate} onPreflight={onPreflight} />
  </>
}
