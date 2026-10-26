import { useEffect, useRef,useState } from 'react'
import { api } from '../shared/api'
import type { ScreenshotEvidence } from '../shared/api'

export default function StepScreenshot({ evidence }: { evidence: Record<string, unknown> }) {
  const screenshot = evidence.screenshot as ScreenshotEvidence | undefined
  const path = typeof screenshot?.url === 'string' ? screenshot.url : ''
  const captureError = typeof evidence.screenshot_error === 'string' ? evidence.screenshot_error : ''
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const frame=useRef<HTMLDivElement>(null)
  const [visible,setVisible]=useState(false)
  useEffect(()=>{
    const node=frame.current;if(!node||!path)return
    if(typeof IntersectionObserver==='undefined')return
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'160px'})
    observer.observe(node);return()=>observer.disconnect()
  },[path])
  useEffect(() => {
    setUrl(''); setError('')
    if (!path||!visible) return
    const abort = new AbortController()
    let blobUrl = ''
    const release = () => {
      abort.abort()
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = '' }
    }
    const off = api.onOperatorTokenChange(() => { release(); setUrl(''); setError('操作授权已改变，请重新打开报告以加载截图') })
    void api.screenshot(path, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      blobUrl = URL.createObjectURL(blob)
      setUrl(blobUrl)
    }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '截图加载失败')
    })
    return () => { off(); release() }
  }, [path,visible])
  if (!screenshot && !captureError) return null
  return <div className="step-screenshot">
    {captureError && <p role="alert" className="screenshot-error">截图失败：{captureError}</p>}
    {screenshot && <>
      <div ref={frame} className={'screenshot-image-frame'+(error||!path?' failed':'')} style={error||!path?undefined:{width:Math.min(320,360*screenshot.width/screenshot.height),height:Math.min(360,320*screenshot.height/screenshot.width),maxWidth:'100%'}}>
      {url && !error ? <a href={url} target="_blank" rel="noreferrer"><img loading="lazy" decoding="async" src={url} alt="此步骤执行后的截图证据" onError={() => setError('截图无法显示，文件可能已损坏')} /></a>
        : <p role={error || !path ? 'alert' : 'status'} className={error || !path ? 'screenshot-error' : 'quiet-note'}>{error || (!path ? '截图资源地址缺失' : visible?'正在加载步骤截图…':'滚动到此处加载截图')} {!visible&&path&&<button className="download-chip" onClick={()=>setVisible(true)}>加载截图</button>}</p>}
      </div>
      <p className="quiet-note">{screenshot.package || String(screenshot.target?.title || screenshot.target?.url || screenshot.driver || '')} · {screenshot.width} × {screenshot.height} · {new Date(screenshot.captured_at).toLocaleString()}</p>
      <details><summary>截图校验信息</summary><pre className="evidence-preview">{JSON.stringify(screenshot, null, 2)}</pre></details>
    </>}
  </div>
}
