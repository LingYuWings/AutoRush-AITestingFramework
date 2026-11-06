import { useEffect, useRef,useState } from 'react'
import { api } from '../shared/api'
import type { ScreenshotEvidence } from '../shared/api'

// Load protected step screenshots on demand and offer an enlarged preview.
export default function StepScreenshot({ evidence }: { evidence: Record<string, unknown> }) {
  const screenshot = evidence.screenshot as ScreenshotEvidence | undefined
  const path = typeof screenshot?.url === 'string' ? screenshot.url : ''
  const captureError = typeof evidence.screenshot_error === 'string' ? evidence.screenshot_error : ''
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const frame=useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDialogElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [visible,setVisible]=useState(false)
  const [authEpoch,setAuthEpoch]=useState(0)
  const shouldLoad = visible || previewOpen
  useEffect(() => {
    preview.current?.close()
    setPreviewOpen(false)
  }, [path, authEpoch])
  useEffect(()=>{
    const node=frame.current;if(!node||!path)return
    if(typeof IntersectionObserver==='undefined')return
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'160px'})
    observer.observe(node);return()=>observer.disconnect()
  },[path])
  useEffect(() => {
    setUrl(''); setError('')
    if (!path||!shouldLoad) return
    const abort = new AbortController()
    let blobUrl = ''
    // Cancel the current image request and revoke any URL it created.
    const release = () => {
      abort.abort()
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = '' }
    }
    const off = api.onOperatorTokenChange(() => { release(); setUrl(''); setError(''); setAuthEpoch(value=>value+1) })
    void api.screenshot(path, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      blobUrl = URL.createObjectURL(blob)
      setUrl(blobUrl)
    }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '截图加载失败')
    })
    return () => { off(); release() }
  }, [path,shouldLoad,authEpoch])
  if (!screenshot && !captureError) return null
  return <div className="step-screenshot">
    {captureError && <p role="alert" className="screenshot-error">截图失败：{captureError}</p>}
    {screenshot && <>
      <div ref={frame} className={'screenshot-image-frame'+(error||!path?' failed':'')} style={error||!path?undefined:{width:Math.min(320,360*screenshot.width/screenshot.height),height:Math.min(360,320*screenshot.height/screenshot.width),maxWidth:'100%'}}>
      {url && !error ? <button type="button" className="screenshot-open" aria-label="放大步骤截图" onClick={() => {
        preview.current?.showModal()
        setPreviewOpen(true)
      }}><img loading="lazy" decoding="async" src={url} alt="此步骤执行后的截图证据" onError={() => {
        preview.current?.close()
        setError('截图无法显示，文件可能已损坏')
      }} /></button>
        : <p role={error || !path ? 'alert' : 'status'} className={error || !path ? 'screenshot-error' : 'quiet-note'}>{error || (!path ? '截图资源地址缺失' : visible?'正在加载步骤截图…':'滚动到此处加载截图')} {!visible&&path&&<button className="download-chip" onClick={()=>setVisible(true)}>加载截图</button>}</p>}
      </div>
      {url && !error && <dialog ref={preview} className="screenshot-dialog" aria-label="步骤截图预览" onClose={() => setPreviewOpen(false)} onKeyDown={event => {
        if (event.key === 'Escape') event.stopPropagation()
      }} onClick={event => {
        if (event.target === event.currentTarget) preview.current?.close()
      }}>
        <div className="screenshot-dialog-content">
          <button type="button" className="secondary-button" onClick={() => preview.current?.close()}>关闭预览</button>
          {previewOpen && <img decoding="async" src={url} alt="放大的步骤截图" />}
        </div>
      </dialog>}
      <p className="quiet-note">{screenshot.package || String(screenshot.target?.title || screenshot.target?.url || screenshot.driver || '')} · {screenshot.width} × {screenshot.height} · {new Date(screenshot.captured_at).toLocaleString()}</p>
      <details><summary>截图校验信息</summary><pre className="evidence-preview">{JSON.stringify(screenshot, null, 2)}</pre></details>
    </>}
  </div>
}
