// Organize the console tours and their spotlight targets for the guide directory.
import { tutorialSteps, type TutorialStep } from './tutorialSteps'

// Describe a tour that can be started from the tutorial directory.
export type TutorialTour = { title: string; steps: readonly TutorialStep[] }

const [writeCase, approveCase, runPlan, reviewReport] = tutorialSteps

export const tutorialGuideGroups: readonly { title: string; tours: readonly TutorialTour[] }[] = [
  { title: '入门', tours: [
    { title: '完整测试流程', steps: tutorialSteps },
    { title: '工作台', steps: [
      { title: '查看工作台概况', route: { view: 'overview' }, target: 'overview-metrics',
        description: '这里汇总用例、计划、执行批次和批次通过率。先确认已批准用例和就绪计划的数量。' },
      { title: '跟进最近执行', route: { view: 'overview' }, target: 'overview-recent',
        description: '最近执行会显示每批次的结果。选中一条记录即可打开报告，也可以通过「全部报告」查看历史。' },
    ] },
    { title: '教程', steps: [
      { title: '阅读基本流程', route: { view: 'tutorial' }, target: 'tutorial-workflow',
        description: '按顺序阅读测试流程，或用各步骤的链接直接打开对应页面。' },
      { title: '检查执行条件', route: { view: 'tutorial' }, target: 'tutorial-preparation',
        description: '从这里查阅 Web、API、Android、Windows 和模型执行各自的准备条件。' },
    ] },
  ] },
  { title: '测试流程', tours: [
    { title: '用例管理', steps: [writeCase, {
      title: '选择执行端与编写方式', route: { view: 'cases', id: 'new' }, target: 'case-editor-options',
      description: '先选择 Web、Android、Desktop 或 API，再填写步骤和预期结果。需要精确指定动作和断言时，使用结构化动作。',
    }, approveCase, {
      title: '导入已有用例', route: { view: 'cases' }, target: 'case-import',
      description: '选择 Markdown 或 XMind 文件并核对解析预览，再把选中的条目保存为草稿。',
    }] },
    { title: '测试计划', steps: [runPlan, {
      title: '查看执行状态', route: { view: 'plans', id: 'executions' }, target: 'plan-executions',
      description: '在此查看自然语言计划的进度、停止运行或打开生成的报告。历史状态未显示时，可以点击「恢复执行状态」。',
    }] },
    { title: '运行报告', steps: [reviewReport, {
      title: '查找运行记录', route: { view: 'reports' }, target: 'report-search',
      description: '按批次、计划、用例或结果搜索。列表右侧可下载报告，打开记录后可逐步查看证据。',
    }] },
  ] },
  { title: 'API 测试', tours: [
    { title: '请求工作台', steps: [
      { title: '管理请求标签', route: { view: 'api-testing' }, target: 'api-request-tabs',
        description: '用加号新建请求标签。选择请求后，可以编辑方法、地址、参数、凭据和断言，再查看响应。' },
      { title: '选择请求环境', route: { view: 'api-testing' }, target: 'api-active-environment',
        description: '为当前标签选择变量环境，便可在请求中引用已保存的变量。' },
    ] },
    { title: '集合 Runner', steps: [
      { title: '配置集合运行', route: { view: 'api-testing', id: 'runner' }, target: 'api-runner-options',
        description: '选择集合、范围和环境，确认请求执行顺序。运行进度和结果会保存到执行历史。' },
      { title: '使用迭代数据', route: { view: 'api-testing', id: 'runner' }, target: 'api-runner-dataset',
        description: '可上传 CSV 或 JSON，在运行前核对列名和预览。集合会按每行数据单独执行。' },
    ] },
    { title: '环境管理', steps: [
      { title: '新建和维护环境', route: { view: 'api-testing', id: 'environments' }, target: 'api-new-environment',
        description: '将基础地址和其他变量保存在环境中。在请求标签或集合 Runner 中选用该环境。' },
    ] },
    { title: '执行历史', steps: [
      { title: '切换历史类型', route: { view: 'api-testing', id: 'history' }, target: 'api-history-modes',
        description: '在集合运行和单请求记录之间切换。展开集合运行可检查每项请求的结果。' },
      { title: '搜索和复查请求', route: { view: 'api-testing', id: 'history' }, target: 'api-history-search',
        description: '用名称、ID 或结果查找记录。打开单请求记录可查看脱敏响应，或把原请求恢复到新标签。' },
    ] },
  ] },
  { title: '设备与配置', tours: [
    { title: 'Android 设备', steps: [
      { title: '连接本地配对服务', route: { view: 'devices' }, target: 'device-connect',
        description: '先连接本地配对服务。USB 方式还需在手机上允许 USB 调试，才能选择设备。' },
      { title: '选择配对方式', route: { view: 'devices' }, target: 'device-pairing-mode',
        description: '选择 USB 或 WSS，填写允许测试的应用包名，再生成二维码。使用 Portal 扫码确认并启用无障碍服务。' },
      { title: '检查已配对设备', route: { view: 'devices' }, target: 'device-paired',
        description: '确认设备在线后，复制设备 ID 到测试计划。也可以从这里打开实时画面或检查设备信息。' },
    ] },
    { title: '系统设置', steps: [
      { title: '调整界面偏好', route: { view: 'settings' }, target: 'settings-general',
        description: '在常规设置中切换语言和主题。语言切换后会重新加载当前页面。' },
      { title: '配置网络范围', route: { view: 'settings', id: 'network' }, target: 'settings-network',
        description: '在网络页分别配置 Web、API 和模型的主机名单，以及本机服务端口。启动设置保存后在重启时生效。' },
      { title: '选择数据存放位置', route: { view: 'settings', id: 'storage' }, target: 'settings-storage',
        description: '这里可以设置 SQLite、报告和日志的位置。更换路径前，先安排已有数据的备份或迁移。' },
      { title: '检查执行环境', route: { view: 'settings', id: 'execution' }, target: 'settings-execution',
        description: '检查 Playwright 浏览器目录和 Windows 桌面自动化设置。桌面能力取决于系统和启动方式。' },
      { title: '配置执行模型', route: { view: 'settings', id: 'models' }, target: 'settings-models',
        description: '选择或发现模型服务，保存配置并验证所需能力。自然语言用例随后可在计划中选用该模型。' },
      { title: '查看集成设置', route: { view: 'settings', id: 'integrations' }, target: 'settings-integrations',
        description: '在集成页查看 MCP 连接参数和凭据配置状态。修改 MCP 设置后需重启 MCP 服务。' },
    ] },
  ] },
]
