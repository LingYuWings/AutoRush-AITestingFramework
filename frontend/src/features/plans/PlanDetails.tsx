import { uiText } from '../../shared/i18n.ts'
import { DriverChip } from '../../components/ui'
import type { CaseRecord, PlanRecord } from '../../shared/api'
import { date, driversOf, shortId } from '../../shared/format'

// Show saved target settings and the exact order in which cases will run.
export default function PlanDetails({ plan, cases, modelName, environmentName }: {
  plan: PlanRecord
  cases: Map<string, CaseRecord>
  modelName?: string
  environmentName?: string
}) {
  const agent = plan.agent_options
  const target = plan.desktop_target
  const drivers = new Set(plan.case_ids.flatMap(id => {
    const item = cases.get(id)
    return item ? driversOf([...item.steps, ...item.postconditions]) : []
  }))
  return <div className="plan-details" id={`plan-details-${plan.id}`}>
    <h4>{uiText("执行配置")}</h4>
    <dl className="plan-detail-fields">
      <div><dt>{uiText("环境名称")}</dt><dd>{plan.environment}</dd></div>
      <div><dt>{uiText("创建时间")}</dt><dd><time dateTime={plan.created_at}>{date(plan.created_at)}</time></dd></div>
      {plan.source_plan_id && <div><dt>{uiText("来源计划")}</dt><dd className="mono" title={plan.source_plan_id}>#{shortId(plan.source_plan_id)}</dd></div>}
      <div><dt>{uiText("每步截图")}</dt><dd>{plan.capture_screenshots ? uiText("已启用") : uiText("未启用")}</dd></div>
      {(plan.api_base_url || drivers.has('api')) && <div><dt>{uiText("API 基础地址")}</dt><dd>{plan.api_base_url ?? uiText("未配置")}</dd></div>}
      {plan.api_environment_id && <div><dt>{uiText("API 变量环境")}</dt><dd>{environmentName ?? plan.api_environment_id}
        {plan.api_environment_snapshot_id && <small>{uiText("已固定快照")}</small>}</dd></div>}
      {(plan.web_base_url || drivers.has('web')) && <>
        <div><dt>{uiText("Web 基础地址")}</dt><dd>{plan.web_base_url ?? uiText("未配置")}</dd></div>
        <div><dt>{uiText("浏览器")}</dt><dd>Chromium {plan.web_headless ? uiText("无头") : uiText("有头")} · {plan.web_viewport.width} × {plan.web_viewport.height}</dd></div>
      </>}
      {(plan.android_device_id || drivers.has('android')) && <div><dt>{uiText("Android 目标设备")}</dt><dd>{plan.android_device_id ?? uiText("未配置")}</dd></div>}
      {(plan.android_package || drivers.has('android')) && <div><dt>{uiText("Android App 包名")}</dt><dd>{plan.android_package ?? uiText("未配置")}</dd></div>}
      {target && <div><dt>{uiText("桌面目标窗口")}</dt><dd>{target.title} · PID {target.pid} · {target.screen_width} × {target.screen_height}{uiText(" · 准备 ")}{plan.desktop_start_delay_seconds}{uiText(" 秒")}</dd></div>}
      {agent && <div><dt>{uiText("执行模型")}</dt><dd>{modelName ?? agent.provider_config_id}
        <small>{uiText("每步 ")}{agent.max_rounds_per_step}{uiText(" 轮 · 每用例 ")}{agent.max_rounds_per_case}{uiText(" 轮 · 模型超时 ")}{agent.model_timeout_seconds}{uiText(" 秒 · 用例超时 ")}{agent.case_timeout_seconds}{uiText(" 秒")}</small>
      </dd></div>}
    </dl>
    <h4>{uiText("用例执行顺序")}</h4>
    <ol className="plan-case-order">
      {plan.case_ids.map(id => {
        const item = cases.get(id)
        return <li key={id}><div className="plan-case-order-row">
          {item ? <a href={`#/cases/${id}`}>{item.title}</a> : <span className="mono">{uiText("用例不可用 · #")}{shortId(id)}</span>}
          {item?.archived_at && <small>{uiText("已归档")}</small>}
          {item && <span className="chip-row">{driversOf([...item.steps, ...item.postconditions]).map(driver => <DriverChip key={driver} driver={driver} />)}</span>}
          {item && <small>{item.steps.length}{uiText(" 步")}{item.postconditions.length > 0 && uiText(" · {0} 个后置步骤", item.postconditions.length)}</small>}
        </div></li>
      })}
    </ol>
  </div>
}
