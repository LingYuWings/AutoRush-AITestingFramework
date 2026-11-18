// Explain how to prepare, run, and review a test from the console.
import { useEffect, useRef } from 'react'
import { ArrowRight, Play, X } from '../components/icons'
import { PageHeader } from '../components/ui'
import { routeHash, type Route } from '../app/router'
import { uiText } from '../shared/i18n.ts'
import { tutorialSteps } from './tutorialSteps'
import { tutorialGuideGroups, type TutorialTour } from './tutorialGuides'
import './tutorial.css'

const preparation = [
  {
    title: 'Web 和 API 测试',
    description: '确认目标地址能从后端访问，并在网络设置中核对主机名单。Web 测试还需要安装 Playwright Chromium。',
  },
  {
    title: 'Android 设备',
    description: '在控制台生成二维码，用手机上的 Portal 扫码配对。开启无障碍服务，确认目标应用在允许列表中，并检查设备是否在线。',
    action: '打开 Android 设备',
    route: { view: 'devices' },
  },
  {
    title: 'Windows 桌面测试',
    description: '启用 Windows 桌面自动化，在计划中选择目标窗口。运行时按准备时间切回目标窗口，并保持窗口可见。',
  },
  {
    title: '自然语言用例',
    description: '在系统设置中配置并验证模型，再为计划选择该模型。需要模型识别画面时，同时验证模型的视觉能力。',
    action: '打开模型设置',
    route: { view: 'settings', id: 'models' },
  },
] satisfies Array<{ title: string; description: string; action?: string; route?: Route }>

// Open the destination through the console router while retaining normal link shortcuts.
function TutorialLink({ route, label, onNavigate }: { route: Route; label: string; onNavigate: (route: Route) => void }) {
  return <a className="tutorial-link" href={routeHash(route)} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return
    event.preventDefault()
    onNavigate(route)
  }}>{uiText(label)}<ArrowRight size={14} /></a>
}

// Present the core workflow and the requirements for each execution mode.
export default function Tutorial({ onNavigate, onStartGuide, focusGuideEntry }: {
  onNavigate: (route: Route) => void
  onStartGuide: (tour: TutorialTour) => void
  focusGuideEntry: boolean
}) {
  const guideEntry = useRef<HTMLButtonElement>(null)
  const directory = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (focusGuideEntry) guideEntry.current?.focus({ preventScroll: true })
  }, [focusGuideEntry])

  return <>
    <PageHeader title={uiText('教程')} description={uiText('了解如何编写用例、运行测试计划并查看结果。')}
      actions={<button ref={guideEntry} type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => directory.current?.showModal()}>
        <Play size={14} />{uiText('引导')}
      </button>} />
    <dialog ref={directory} className="tutorial-directory" aria-labelledby="tutorial-directory-title"
      onKeyDown={event => event.stopPropagation()}>
      <header className="tutorial-directory-header">
        <h2 id="tutorial-directory-title">{uiText('选择引导')}</h2>
        <button type="button" className="icon-button" aria-label={uiText('关闭')} onClick={() => directory.current?.close()}><X size={16} /></button>
      </header>
      <div className="tutorial-directory-groups">
        {tutorialGuideGroups.map(group => <section key={group.title}>
          <h3>{uiText(group.title)}</h3>
          <ul>
            {group.tours.map(tour => <li key={tour.title}>
              <button type="button" onClick={() => {
                directory.current?.close()
                onStartGuide(tour)
              }}>
                {uiText(tour.title)}<ArrowRight size={14} aria-hidden="true" />
              </button>
            </li>)}
          </ul>
        </section>)}
      </div>
    </dialog>
    <div className="tutorial-layout">
      <section className="surface tutorial-panel" aria-labelledby="tutorial-workflow">
        <h2 id="tutorial-workflow" data-tutorial-target="tutorial-workflow">{uiText('基本流程')}</h2>
        <ol className="tutorial-steps">
          {tutorialSteps.map(({ title, description, route, action }) => <li key={title}>
            <h3>{uiText(title)}</h3>
            <p>{uiText(description)}</p>
            {action && <TutorialLink route={route} label={action} onNavigate={onNavigate} />}
          </li>)}
        </ol>
      </section>
      <section className="surface tutorial-panel" aria-labelledby="tutorial-preparation">
        <h2 id="tutorial-preparation" data-tutorial-target="tutorial-preparation">{uiText('执行前准备')}</h2>
        <div className="tutorial-preparation">
          {preparation.map(({ title, description, route, action }) => <div key={title}>
            <h3>{uiText(title)}</h3>
            <p>{uiText(description)}</p>
            {route && action && <TutorialLink route={route} label={action} onNavigate={onNavigate} />}
          </div>)}
        </div>
      </section>
    </div>
  </>
}
