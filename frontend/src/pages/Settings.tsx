import type { ProviderConfig, ProviderConfigPayload, ProviderPreflight, ProviderPreset } from '../shared/api'
import { PageHeader } from '../components/ui'
import ProviderSettings from '../features/settings/ProviderSettings'

const boundaries = [
  { title: '本地后端', value: '127.0.0.1:8000', text: '仅适合可信本机开发，尚无用户鉴权、项目隔离及生产密钥管理。' },
  { title: 'Android Portal', value: '协议 v1', text: '设备端需手动启用无障碍服务与包名允许列表，使用配对令牌连接。' },
  { title: '数据与报告', value: 'SQLite', text: '结果保存在本地数据库，并生成 JSON、HTML 与 JUnit XML 报告。' },
]

export default function Settings({ presets, configs, onCreate, onPreflight }: {
  presets: ProviderPreset[]
  configs: ProviderConfig[]
  onCreate: (payload: ProviderConfigPayload) => Promise<boolean>
  onPreflight: (id: string) => Promise<ProviderPreflight | null>
}) {
  return <>
    <PageHeader title="系统设置" />
    <section className="surface boundary-list">
      <div className="surface-header"><div><h3>运行环境</h3><p>当前为本地开发版本，以下边界尚未覆盖生产需求。</p></div></div>
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
