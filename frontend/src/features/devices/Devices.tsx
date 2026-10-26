import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Copy, QrCode, RefreshCw, ShieldCheck, Smartphone, Unplug, Usb } from '../../components/icons'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../../shared/api'
import type { AdbDevice, LocalDeviceServer, PairedDevice, PairingRecord } from '../../shared/api'
import { EmptyState, PageHeader } from '../../components/ui'
import { pairingPayload } from './pairing'
import ScreenViewer from './ScreenViewer'

type VisiblePairing = PairingRecord & { qr_payload?: string }
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const pairingLabel = { pending: '等待扫码', claimed: '配对成功', expired: '二维码已过期', cancelled: '配对已取消' }

export default function Devices() {
  const [authorized, setAuthorized] = useState(Boolean(api.getOperatorToken()))
  const [manualToken, setManualToken] = useState('')
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([])
  const [adbError, setAdbError] = useState('')
  const [usbServer, setUsbServer] = useState('')
  const [connection, setConnection] = useState<'usb' | 'wss'>('usb')
  const [serial, setSerial] = useState('')
  const [server, setServer] = useState('')
  const [remoteMode, setRemoteMode] = useState<'lan' | 'external'>('lan')
  const [localServer, setLocalServer] = useState<LocalDeviceServer | null>(null)
  const [packages, setPackages] = useState('com.autorush.fixture')
  const [pairing, setPairing] = useState<VisiblePairing | null>(null)
  const [now, setNow] = useState(Date.now())
  const [devices, setDevices] = useState<string[]>([])
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([])
  const [info, setInfo] = useState<Record<string, unknown> | null>(null)
  const [inspected, setInspected] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const sessionEpoch = useRef(0)

  const loadDevices = async (epoch = sessionEpoch.current) => {
    const [online, paired] = await Promise.allSettled([api.devices(), api.pairedDevices()])
    if (epoch !== sessionEpoch.current) return
    if (online.status === 'fulfilled') setDevices(online.value.devices)
    if (paired.status === 'fulfilled') setPairedDevices(paired.value)
    const errors = [online, paired].filter(result => result.status === 'rejected')
    if (errors.length) throw new Error(errors.map(result => errorMessage((result as PromiseRejectedResult).reason, '设备查询失败')).join('；'))
  }

  useEffect(() => {
    if (!authorized) return
    let active = true
    const refresh = () => void loadDevices().catch(error => { if (active) setMessage(errorMessage(error, '设备查询失败')) })
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [authorized])

  useEffect(() => {
    if (pairing?.status !== 'pending') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing?.id, pairing?.status])

  useEffect(() => {
    if (!authorized || pairing?.status !== 'pending') return
    let active = true
    let timer: number | undefined
    const epoch = sessionEpoch.current
    const id = pairing.id
    const poll = async () => {
      try {
        const record = await api.pairing(id)
        if (!active || epoch !== sessionEpoch.current) return
        setPollError('')
        setPairing(previous => previous?.id === id && previous.status === 'pending'
          ? { ...record, qr_payload: record.status === 'pending' ? previous.qr_payload : undefined }
          : previous)
        if (record.status === 'claimed') {
          setMessage('设备配对成功；Portal 连接后会显示在线。')
          await loadDevices(epoch)
        }
        if (record.status !== 'pending') return
      } catch (error) {
        if (!active || epoch !== sessionEpoch.current) return
        setPollError(errorMessage(error, '配对状态查询失败，正在重试。'))
      }
      if (active) timer = window.setTimeout(() => void poll(), 2000)
    }
    timer = window.setTimeout(() => void poll(), 1000)
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [authorized, pairing?.id, pairing?.status])

  const connect = async () => {
    setBusy('connect'); setMessage(''); setPollError('')
    try {
      if (pairing?.status === 'pending') setPairing(await api.cancelPairing(pairing.id))
      const session = await api.operatorSession()
      sessionEpoch.current += 1
      setPairing(null); setInfo(null); setInspected(null)
      api.setOperatorToken(session.operator_token)
      setManualToken(''); setAuthorized(true)
      setAdbDevices(session.adb_devices); setAdbError(session.adb_error ?? '')
      setUsbServer(session.usb_server_url)
      setSerial(previous => session.adb_devices.some(device => device.serial === previous && device.state === 'device')
        ? previous : session.adb_devices.find(device => device.state === 'device')?.serial ?? '')
      await loadDevices()
      setLocalServer(await api.localDeviceServer())
      setMessage('本地配对服务已连接，操作授权只保留在浏览器内存中。')
    } catch (error) { setMessage(errorMessage(error, '本地配对服务连接失败')) }
    finally { setBusy(null) }
  }

  const refresh = async () => {
    setBusy('refresh'); setMessage(''); setInfo(null)
    try { await loadDevices() }
    catch (error) { setMessage(errorMessage(error, '设备查询失败')) }
    finally { setBusy(null) }
  }

  const authorizeManually = async () => {
    setBusy('authorize'); setMessage(''); setPollError('')
    try {
      if (pairing?.status === 'pending') await api.cancelPairing(pairing.id)
      sessionEpoch.current += 1
      setPairing(null); setAdbDevices([]); setAdbError(''); setUsbServer(''); setSerial('')
      api.setOperatorToken(manualToken)
      await loadDevices()
      setAuthorized(true); setManualToken('')
      setMessage('操作授权已启用。USB 配对请连接本地服务；远程配对可填写 WSS 地址。')
    } catch (error) { api.setOperatorToken(''); setAuthorized(false); setMessage(errorMessage(error, '操作授权失败')) }
    finally { setBusy(null) }
  }

  const clearAuthorization = async () => {
    setViewing(null)
    setBusy('clear')
    let cancellationFailed = false
    try { if (pairing?.status === 'pending') await api.cancelPairing(pairing.id) }
    catch { cancellationFailed = true }
    sessionEpoch.current += 1
    api.setOperatorToken(''); setManualToken(''); setAuthorized(false)
    setPairing(null); setDevices([]); setPairedDevices([]); setInfo(null); setInspected(null)
    setAdbDevices([]); setAdbError(''); setUsbServer(''); setSerial(''); setPollError('')
    setMessage(cancellationFailed ? '操作授权已清除。未能取消服务器上的配对请求，它将在有效期结束后失效。' : '操作授权已清除，待扫码的配对已取消。')
    setBusy(null)
  }

  const generate = async () => {
    let payload
    try { payload = pairingPayload(connection === 'wss' && remoteMode === 'lan' ? 'lan' : connection, serial, server, packages) }
    catch (error) { setMessage(errorMessage(error, '配对配置无效')); return }
    setBusy('generate'); setMessage(''); setPollError('')
    try {
      if (payload.connection === 'lan') setLocalServer(await api.startLocalDeviceServer())
      if (pairing?.status === 'pending') setPairing(await api.cancelPairing(pairing.id))
      const created = await api.createPairing(payload)
      setNow(Date.now()); setPairing(created)
    } catch (error) { setMessage(errorMessage(error, '二维码生成失败')) }
    finally { setBusy(null) }
  }

  const startLocal = async () => {
    setBusy('local-server'); setMessage('')
    try {
      setLocalServer(await api.startLocalDeviceServer())
      setMessage('本地 WSS 服务已启动。手机和电脑连接同一 Wi-Fi，然后扫描二维码。')
    } catch (error) { setMessage(errorMessage(error, '本地 WSS 服务启动失败')) }
    finally { setBusy(null) }
  }

  const selectRemote = () => {
    setConnection('wss')
    if (authorized && remoteMode === 'lan') void startLocal()
  }

  const stopLocal = async () => {
    setBusy('local-server'); setMessage('')
    try {
      if (pairing?.status === 'pending' && pairing.server_url === localServer?.server_url) setPairing(await api.cancelPairing(pairing.id))
      setLocalServer(await api.stopLocalDeviceServer())
      await loadDevices()
      setMessage('本地 WSS 服务已停止，Wi-Fi 设备已断开。')
    } catch (error) { setMessage(errorMessage(error, '停止服务失败')) }
    finally { setBusy(null) }
  }

  const cancel = async () => {
    if (!pairing) return
    setBusy('cancel'); setMessage('')
    try { setPairing(await api.cancelPairing(pairing.id)); setPollError('') }
    catch (error) { setMessage(errorMessage(error, '配对取消失败')) }
    finally { setBusy(null) }
  }

  const inspect = async (id: string) => {
    setBusy('inspect'); setMessage(''); setInspected(id); setInfo(null)
    try { setInfo(await api.deviceInfo(id)) }
    catch (error) { setMessage(errorMessage(error, '设备检查失败')) }
    finally { setBusy(null) }
  }

  const revoke = async (id: string) => {
    if (viewing === id) setViewing(null)
    setBusy(`revoke:${id}`); setMessage('')
    try {
      await api.revokeDevice(id)
      if (inspected === id) { setInfo(null); setInspected(null) }
      await loadDevices()
      setMessage('设备授权已撤销，连接已断开。重新使用时需要再次扫码配对。')
    } catch (error) { setMessage(errorMessage(error, '设备授权撤销失败')) }
    finally { setBusy(null) }
  }

  const copy = (id: string) => {
    if (!navigator.clipboard) { setMessage('当前浏览器无法复制，请选择设备 ID 手动复制。'); return }
    void navigator.clipboard.writeText(id).then(() => setMessage('设备 ID 已复制')).catch(() => setMessage('设备 ID 复制失败，请手动复制。'))
  }

  const remaining = pairing ? Math.max(0, Math.ceil((new Date(pairing.expires_at).getTime() - now) / 1000)) : 0
  const visibleStatus = pairing?.status === 'pending' && remaining === 0 ? 'expired' : pairing?.status
  const legacyDevices = devices.filter(id => !pairedDevices.some(device => device.device_id === id))
  const qrVisible = authorized && pairing?.status === 'pending' && remaining > 0 && Boolean(pairing.qr_payload)

  return <>
    <PageHeader title="Android 设备" description="连接本地服务并生成二维码，在手机 Portal 扫码确认后，即可将设备 ID 用于测试计划。" actions={
      <button className="secondary-button" disabled={!authorized || Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} className={busy === 'refresh' ? 'spinning' : ''} />刷新设备</button>
    } />
    <div className="devices-layout">
      <div className="devices-column">
        <section className="surface auth-card">
          <div className="surface-header"><div><h3>本地配对服务</h3><p>操作授权只保留在当前浏览器会话的内存中</p></div>{authorized && <ShieldCheck size={18} className="pairing-connected" aria-label="已授权" />}</div>
          <div className="auth-actions">
            <button className="primary-button" disabled={Boolean(busy)} onClick={() => void connect()}><Usb size={14} />{busy === 'connect' ? '连接中…' : authorized ? '重新连接本地服务' : '连接本地配对服务'}</button>
            {authorized && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void clearAuthorization()}>清除授权</button>}
          </div>
          <p className="quiet-note">通过 USB 连接手机并在手机上允许 USB 调试；本地服务会自动建立连接通道。</p>
          <details className="manual-authorization">
            <summary>高级：手动操作令牌</summary>
            <label className="field"><span>操作令牌</span><input type="password" className="mono-input" value={manualToken} autoComplete="off" spellCheck={false} disabled={Boolean(busy)} onChange={event => setManualToken(event.target.value)} placeholder="AUTORUSH_OPERATOR_TOKEN" /></label>
            <p className="quiet-note">兼容已有环境变量配置，令牌至少 32 个字符。手机手动连接使用单独的设备令牌。</p>
            <button className="secondary-button" disabled={Boolean(busy) || manualToken.trim().length < 32} onClick={() => void authorizeManually()}>{busy === 'authorize' ? '授权中…' : '授权并刷新设备'}</button>
          </details>
        </section>

        <section className="surface pairing-form">
          <div className="surface-header"><div><h3>创建扫码配对</h3><p>一次性二维码，有效期 3 分钟</p></div></div>
          <div className="segmented" role="group" aria-label="连接方式">
            <button className={connection === 'usb' ? 'active' : ''} disabled={Boolean(busy)} onClick={() => setConnection('usb')}><Usb size={14} />USB 本地</button>
            <button className={connection === 'wss' ? 'active' : ''} disabled={Boolean(busy)} onClick={selectRemote}>WSS 远程</button>
          </div>
          {connection === 'usb' ? <>
            <label className="field"><span>USB 设备</span><select value={serial} disabled={!authorized || Boolean(busy)} onChange={event => setSerial(event.target.value)}>
              <option value="">{adbDevices.length ? '选择已授权的设备' : '连接本地服务以查询 USB 设备'}</option>
              {adbDevices.map(device => <option key={device.serial} value={device.serial} disabled={device.state !== 'device'}>{device.model || 'Android'} · {device.serial}{device.state === 'device' ? '' : ` · ${device.state === 'unauthorized' ? '请在手机上允许调试' : device.state}`}</option>)}
            </select></label>
            {usbServer && <p className="quiet-note pairing-endpoint">手机连接地址：<code>{usbServer}</code></p>}
            {adbError && <p className="inline-alert" role="alert">USB 查询失败：{adbError}</p>}
          </> : <>
            <label className="field"><span>远程服务方式</span><select value={remoteMode} disabled={Boolean(busy)} onChange={event => {
              const mode = event.target.value as 'lan' | 'external'; setRemoteMode(mode)
              if (mode === 'lan' && authorized) void startLocal()
            }}><option value="lan">同 Wi-Fi · 电脑启动 WSS 服务</option><option value="external">已有域名与 TLS 服务</option></select></label>
            {remoteMode === 'lan' ? <>
              <p role="status" className="quiet-note">本地 WSS 服务：{busy === 'local-server' ? '正在启动或停止…' : localServer?.running ? '已启动' : '未启动'}</p>
              {localServer?.running && <><p className="quiet-note pairing-endpoint">连接地址：<code>{localServer.server_url}</code></p><details><summary>服务器证书指纹</summary><code>{localServer.tls_sha256}</code></details></>}
              <p className="quiet-note">手机与电脑需连接同一 Wi-Fi。二维码会绑定本机服务器证书。若无法连接，请检查 Wi-Fi 客户端隔离和系统防火墙的入站提示。</p>
              <button className="secondary-button" disabled={!authorized || Boolean(busy)} onClick={() => void (localServer?.running ? stopLocal() : startLocal())}>{localServer?.running ? '停止本地 WSS 服务' : '启动本地 WSS 服务'}</button>
            </> : <label className="field"><span>WSS 服务器地址</span><input className="mono-input" value={server} disabled={Boolean(busy)} onChange={event => setServer(event.target.value)} autoComplete="off" spellCheck={false} placeholder="wss://your-server/api/v1/devices/ws" /></label>}
          </>}
          <label className="field"><span>允许测试的 App 包名</span><textarea value={packages} disabled={Boolean(busy)} onChange={event => setPackages(event.target.value)} spellCheck={false} rows={3} placeholder="com.autorush.fixture" /></label>
          <p className="quiet-note">每行一个包名，最多 10 个，每个不超过 200 字符；只允许操作这些 App。Portal 自身不能加入允许列表。</p>
          <div className="pairing-form-actions"><button className="primary-button" disabled={!authorized || Boolean(busy) || (connection === 'usb' && !serial)} onClick={() => void generate()}><QrCode size={14} />{busy === 'generate' ? '生成中…' : pairing ? '重新生成二维码' : '生成配对二维码'}</button></div>
        </section>
        {message && <p role="status" className="inline-alert device-message">{message}</p>}
      </div>

      <div className="devices-column">
        <section className="surface pairing-qr-card">
          <div className="surface-header"><div><h3>手机扫码</h3><p>USB 使用 Portal 0.3+；同 Wi-Fi 使用 0.4+ 的“扫码配对”</p></div>{visibleStatus && <span className={`pairing-state pairing-state-${visibleStatus}`}>{pairingLabel[visibleStatus]}</span>}</div>
          {pairing ? <>
            <div className="pairing-qr-content">
              {qrVisible ? <div className="pairing-qr"><QRCodeSVG value={pairing.qr_payload!} size={288} level="M" marginSize={4} title="AutoRush 一次性设备配对二维码" /></div>
                : <div className={`pairing-result ${visibleStatus === 'claimed' ? 'claimed' : ''}`}>{visibleStatus === 'claimed' ? <CheckCircle2 size={36} /> : <QrCode size={36} />}<strong>{pairingLabel[visibleStatus ?? 'expired']}</strong></div>}
              <div className="pairing-summary">
                {qrVisible && <><p className="pairing-countdown num">剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p><p className="quiet-note">在手机确认服务器地址和允许包名，再完成配对。请保持此页打开。</p></>}
                <dl><div><dt>服务器</dt><dd><code>{pairing.server_url}</code></dd></div><div><dt>允许 App</dt><dd>{pairing.allowed_packages.map(name => <code key={name}>{name}</code>)}</dd></div>{pairing.device_id && <div><dt>设备 ID</dt><dd><code>{pairing.device_id}</code><button className="icon-button" onClick={() => copy(pairing.device_id!)} aria-label="复制配对设备 ID"><Copy size={14} /></button></dd></div>}</dl>
                {pairing.status === 'pending' && remaining > 0 && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void cancel()}>{busy === 'cancel' ? '取消中…' : '取消本次配对'}</button>}
                {visibleStatus === 'expired' && <p className="quiet-note">请重新生成二维码，然后在手机再次扫码。</p>}
              </div>
            </div>
            {pollError && <p className="inline-alert" role="alert">{pollError} 状态查询会自动重试。</p>}
          </> : <EmptyState icon={QrCode} title="等待生成配对二维码" description="先连接本地配对服务，选择设备和允许测试的 App，然后在手机 Portal 扫码。扫码后仍需开启无障碍服务。" />}
        </section>

        <section className="surface">
          <div className="surface-header"><div><h3>已配对设备</h3><p>{pairedDevices.filter(device => !device.revoked).length} 台已授权 · {devices.length} 台在线</p></div></div>
          {pairedDevices.length ? <div className="device-list">{pairedDevices.map(device => <div className={`paired-device-row ${inspected === device.device_id ? 'active' : ''}`} key={device.device_id}>
            <div className="paired-device-heading"><span className="device-icon"><Smartphone size={16} /></span><strong>{[device.manufacturer, device.model].filter(Boolean).join(' ') || 'Android 设备'}</strong><span className={`pairing-state ${device.revoked ? 'pairing-state-cancelled' : device.online ? 'pairing-state-claimed' : 'pairing-state-expired'}`}>{device.revoked ? '已撤销' : device.online ? '在线' : '离线'}</span></div>
            <div className="paired-device-id"><code>{device.device_id}</code><button className="icon-button" onClick={() => copy(device.device_id)} aria-label="复制设备 ID" title="复制设备 ID"><Copy size={14} /></button></div>
            <div className="paired-device-footer"><span className="quiet-note">Android API {device.sdk_int}</span><div><button className="secondary-button" disabled={!authorized || device.revoked} onClick={() => setViewing(device.device_id)}>实时画面</button><button className="secondary-button" disabled={Boolean(busy) || !device.online || device.revoked} onClick={() => void inspect(device.device_id)}>检查设备信息</button><button className="secondary-button revoke-button" disabled={Boolean(busy) || device.revoked} onClick={() => void revoke(device.device_id)}>{busy === `revoke:${device.device_id}` ? '撤销中…' : '撤销授权'}</button></div></div>
          </div>)}</div> : <EmptyState icon={Smartphone} title="尚无扫码配对的设备" description="完成手机扫码确认后，这里将显示设备 ID、在线状态和授权管理。" />}
          {legacyDevices.length > 0 && <><h4 className="subsection-label">手动连接的在线设备</h4><div className="device-list">{legacyDevices.map(id => <div className={`device-row ${inspected === id ? 'active' : ''}`} key={id}><span className="device-icon"><Unplug size={16} /></span><code>{id}</code><button className="icon-button" onClick={() => copy(id)} aria-label="复制设备 ID"><Copy size={14} /></button><button className="secondary-button" disabled={!authorized} onClick={() => setViewing(id)}>实时画面</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void inspect(id)}>检查设备信息</button></div>)}</div></>}
          {info && <pre className="evidence-preview">{JSON.stringify(info, null, 2)}</pre>}
        </section>
        {authorized && viewing && <ScreenViewer key={viewing} deviceId={viewing} online={devices.includes(viewing)} onClose={() => setViewing(null)} />}
      </div>
    </div>
  </>
}
