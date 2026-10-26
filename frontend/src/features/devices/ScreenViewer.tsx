import { useEffect, useRef, useState } from 'react'
import { Play, Square, X } from '../../components/icons'
import { api } from '../../shared/api'
import type { AdbDevice } from '../../shared/api'
import { openDeviceScreen } from './view-session'
import type { DeviceScreenUpdate } from './view-session'
import type { ScreenMode } from './screen'

const initial: DeviceScreenUpdate = { state: 'stopped', detail: '点击开始查看手机画面', active: false, frame: null, source: null, width: 0, height: 0, fps: 0 }

export default function ScreenViewer({ deviceId, online, onClose }: { deviceId: string; online: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<ScreenMode>('smooth')
  const [serial, setSerial] = useState('')
  const [devices, setDevices] = useState<AdbDevice[]>([])
  const [adbNote, setAdbNote] = useState('正在查询电脑连接的 ADB 手机')
  const [view, setView] = useState(initial)
  const [previewFps, setPreviewFps] = useState(0)
  const loadedAt = useRef<number[]>([])
  const canvas = useRef<HTMLCanvasElement>(null)
  const session = useRef<ReturnType<typeof openDeviceScreen> | null>(null)
  const mounted = useRef(true)
  const query = useRef(0)
  const stop = (detail = '已停止查看') => {
    session.current?.stop(detail); session.current = null
    loadedAt.current = []; setPreviewFps(0)
  }
  const refreshAdb = async () => {
    const epoch = ++query.current
    try {
      const result = await api.adbDevices()
      if (!mounted.current || epoch !== query.current) return
      setDevices(result.devices)
      setAdbNote(result.error || (result.devices.some(device => device.state === 'device') ? '请明确选择当前已配对的手机，服务端会核对设备身份。' : '未发现已授权的 ADB 手机；开始后将使用 WSS 截图预览。'))
    } catch (error) {
      if (mounted.current && epoch === query.current) { setDevices([]); setAdbNote(error instanceof Error ? error.message : 'ADB 查询失败') }
    }
  }
  useEffect(() => {
    mounted.current = true
    void refreshAdb()
    const off = api.onOperatorTokenChange(() => { stop('操作授权已改变，请重新开始查看'); void refreshAdb() })
    return () => { mounted.current = false; query.current++; off(); session.current?.stop(); session.current = null }
  }, [])
  useEffect(() => { session.current?.portalChanged(online) }, [online])
  useEffect(() => () => { session.current?.stop(); session.current = null }, [deviceId, mode])
  const start = () => {
    stop()
    if (!canvas.current) return
    try {
      session.current = openDeviceScreen({ deviceId, serial, mode, online, canvas: canvas.current,
        url: api.screenUrl(deviceId), adbUrl: api.adbScreenUrl(), token: api.getOperatorToken(),
        onChange: update => { if (mounted.current) setView(update) },
      })
    } catch (error) { setView({ ...initial, state: 'error', detail: error instanceof Error ? error.message : '画面连接失败' }) }
  }
  const hasVideo = view.source === 'adb' && view.width > 0 && view.height > 0
  return <section className="surface screen-viewer" aria-label="设备实时画面">
    <div className="surface-header"><div><h3>实时画面</h3><p className="mono">{deviceId}</p></div><button className="icon-button" onClick={() => { stop(); onClose() }} aria-label="关闭实时画面"><X size={16} /></button></div>
    <div className="screen-controls">
      <div className="segmented" aria-label="画面模式">
        <button className={mode === 'preview' ? 'active' : ''} aria-pressed={mode === 'preview'} onClick={() => { stop(); setMode('preview') }}>远程预览 · WSS</button>
        <button className={mode === 'smooth' ? 'active' : ''} aria-pressed={mode === 'smooth'} onClick={() => { stop(); setMode('smooth') }}>流畅投屏 · ADB H.264</button>
      </div>
      {view.active ? <button className="secondary-button" onClick={() => stop()}><Square size={14} />停止查看</button>
        : <button className="primary-button" disabled={!api.getOperatorToken() || (!online && (mode === 'preview' || !serial))} onClick={start}><Play size={14} />开始查看</button>}
    </div>
    {mode === 'smooth' && <div className="screen-adb-controls">
      <label>已配对手机的 ADB 设备<select aria-label="投屏 ADB 设备" value={serial} onChange={event => { stop(); setSerial(event.target.value) }}>
        <option value="">不使用 ADB，回退 WSS 截图预览</option>
        {devices.map(device => <option key={device.serial} value={device.serial} disabled={device.state !== 'device'}>{device.model || 'Android'} · {device.serial}{device.state === 'device' ? '' : ` · ${device.state}`}</option>)}
      </select></label>
      <button className="secondary-button" disabled={view.active} onClick={() => void refreshAdb()}>刷新 ADB 设备</button>
      <p className="quiet-note">{adbNote}</p>
    </div>}
    <p className="quiet-note">{mode === 'smooth'
      ? '参考 Smart-AI-Bot 的 ADB H.264 视频链路：显示已配对手机整屏（含系统界面），无需系统录屏授权。请安装 Portal 0.5.1+ 并允许 USB 调试。ADB 不可用时回退 WSS 截图预览（目标2 FPS，仅显示手机截图许可范围内的应用）。'
      : 'WSS 远程截图预览目标 2 FPS，需要 Portal 在线并开启截图许可，仅显示手机允许范围内的应用。'}</p>
    <p className="screen-status" role="status">{view.detail}</p>
    <div className="screen-stage">
      <canvas ref={canvas} width={0} height={0} aria-label="ADB H.264 手机整屏画面" style={{ display: hasVideo ? 'block' : 'none' }} />
      {view.frame ? <img src={view.frame.url} alt="Android WSS 实时画面" onLoad={event => {
        session.current?.loaded(event.currentTarget.src)
        const now = performance.now()
        loadedAt.current = [...loadedAt.current.filter(at => now - at <= 3000), now]
        const times = loadedAt.current
        setPreviewFps(times.length > 1 ? (times.length - 1) * 1000 / (now - times[0]) : 0)
      }} onError={event => session.current?.failed(event.currentTarget.src)} /> : !hasVideo && <p>尚无画面</p>}
    </div>
    {(hasVideo || view.frame) && <p className="quiet-note mono">{view.width} × {view.height} · 最近更新 {hasVideo ? view.fps.toFixed(1) : previewFps.toFixed(1)} FPS · {hasVideo ? `ADB 整屏 · ${serial}` : `WSS · ${view.frame?.metadata.package}`}</p>}
    <p className="quiet-note">停止、切换设备或模式、隐藏页面或离开会结束共享。静止画面按变化更新。</p>
  </section>
}
