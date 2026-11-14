// Render the editable runtime configuration for the selected category.
import { FileText, Undo2 } from '../../components/icons'
import { desktop } from '../../shared/desktop'
import { uiText } from '../../shared/i18n.ts'
import { fields, type Overrides, type RuntimeSnapshot, type Section } from './runtime'

// Display the running value beside any override saved for the next launch.
export default function RuntimePanel({ section, data, draft, update, busy, showError }: {
  section: Section; data: RuntimeSnapshot; draft: Overrides; update: (key: string, value: string | null) => void
  busy: boolean; showError: (text: string) => void
}) {
  return <section className="surface runtime-settings-panel">
    {(fields[section] ?? []).map(([key, label, kind, hint]) => {
      const effective = data.effective[key] ?? ''
      const saved = data.overrides[key]
      const value = draft[key] === null ? effective : draft[key] ?? saved ?? effective
      const locked = data.locked.includes(key)
      const pathKind = kind === 'directory' || kind === 'file' || kind === 'database' ? kind : null
      return <div key={key} className="runtime-setting">
        <label className="field">
          <span>{uiText(label)}</span>
          {kind === 'switch' ? <select value={value} disabled={busy || locked} onChange={event => update(key, event.target.value)}>
            <option value="0">{uiText('已停用')}</option><option value="1">{uiText('已启用')}</option>
          </select> : <input className={pathKind ? 'mono-input' : undefined} value={value} disabled={busy || locked}
            type={kind === 'port' ? 'number' : 'text'} min={kind === 'port' ? 1024 : undefined} max={kind === 'port' ? 65535 : undefined}
            onChange={event => update(key, event.target.value)} />}
          {hint && <small>{uiText(hint)}</small>}
        </label>
        <div className="runtime-setting-actions">
          {pathKind && desktop && <button type="button" className="secondary-button" disabled={busy || locked} onClick={async () => {
            try {
              const selected = await desktop?.chooseSettingsPath(pathKind)
              if (selected) update(key, selected)
            } catch { showError(uiText('无法打开路径选择器。')) }
          }}><FileText size={15}/>{uiText('浏览')}</button>}
          {(saved !== undefined || Object.hasOwn(draft, key)) && <button type="button" className="icon-button" disabled={busy || locked}
            aria-label={uiText('清除 {0} 的覆盖值', uiText(label))} title={uiText('清除保存的覆盖值')} onClick={() => update(key, null)}><Undo2 size={15}/></button>}
        </div>
        <p className="runtime-setting-meta">
          <code>{key}</code>
          {locked ? <span>{uiText('由当前启动模式管理')}</span> : (saved !== undefined || Object.hasOwn(draft, key)) &&
            <span>{uiText('当前生效：{0}', kind === 'switch' ? uiText(effective === '1' ? '已启用' : '已停用') : effective || uiText('空'))}</span>}
          {draft[key] === null && <span>{uiText('保存后清除覆盖值')}</span>}
        </p>
      </div>
    })}
    {section === 'integrations' && <div className="runtime-token-status">
      <p>{uiText('令牌由启动环境管理。模型凭据通过环境变量引用。')}</p>
      <dl>
        <div><dt><code>AUTORUSH_PORTAL_TOKEN</code></dt><dd>{uiText(data.portal_token_configured ? '已配置' : '启动时未配置')}</dd></div>
        <div><dt><code>AUTORUSH_OPERATOR_TOKEN</code></dt><dd>{uiText(data.operator_token_configured ? '已配置' : '启动时未配置')}</dd></div>
        <div><dt><code>AUTORUSH_CONFIG_PATH</code></dt><dd className="mono">{data.path}</dd></div>
      </dl>
      <p className="quiet-note">{uiText('Python 解释器和安装选项仍通过启动命令选择。修改 MCP 设置后请重新启动 MCP 服务。')}</p>
    </div>}
  </section>
}
