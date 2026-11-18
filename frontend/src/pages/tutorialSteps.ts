// Share workflow copy and live page targets between the tutorial and guided tour.
import type { Route } from '../app/router'

// Describe an instruction, its console page, and the control to highlight.
export type TutorialStep = {
  title: string
  description: string
  route: Route
  target: string
  action?: string
}

export const tutorialSteps: readonly TutorialStep[] = [
  {
    title: '编写用例',
    description: '在用例管理中新建用例，选择执行端，写清每一步的操作和预期结果。需要精确指定动作和断言时，可以选择结构化动作。',
    action: '打开用例管理',
    route: { view: 'cases' },
    target: 'new-case',
  },
  {
    title: '批准用例',
    description: '保存草稿，核对步骤和预期结果后点击「批准」。已批准的版本可以加入计划，后续修改会生成新的草稿版本。',
    route: { view: 'cases' },
    target: 'case-filters',
  },
  {
    title: '配置并运行计划',
    description: '新建计划，选择已批准的用例，填写所需的目标地址、设备或窗口。点击「预检查并就绪」，通过后再点击「运行计划」。',
    action: '打开测试计划',
    route: { view: 'plans' },
    target: 'new-plan',
  },
  {
    title: '查看报告',
    description: '打开对应批次的报告，先看用例结果，再展开步骤查看断言和已有证据。需要带走结果时，可以下载 JSON、HTML 或 JUnit 报告。',
    action: '打开运行报告',
    route: { view: 'reports' },
    target: 'report-filters',
  },
]
