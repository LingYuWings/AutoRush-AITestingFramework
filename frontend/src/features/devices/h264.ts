/** Independently implemented Annex B framing for Android screenrecord.
 * WebCodecs Annex B key chunks include the IDR picture and its SPS/PPS:
 * https://www.w3.org/TR/webcodecs-avc-codec-registration/
 */
const MAX_BUFFER = 2 * 1024 * 1024
const MAX_UNIT = 4 * 1024 * 1024

export interface AccessUnit { data: Uint8Array<ArrayBuffer>; key: boolean; codec: string }

class Bits {
  private bytes: Uint8Array
  private offset = 0
  constructor(nal: Uint8Array) {
    const bytes: number[] = []
    for (let i = 1; i < nal.length; i++) {
      if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
      bytes.push(nal[i])
    }
    this.bytes = new Uint8Array(bytes)
  }
  read(count: number): number {
    if (count < 0 || count > 32 || this.offset + count > this.bytes.length * 8) throw new Error('H.264 header 截断')
    let value = 0
    for (let i = 0; i < count; i++, this.offset++) value = value * 2 + ((this.bytes[this.offset >> 3] >> (7 - this.offset % 8)) & 1)
    return value
  }
  ue(): number {
    let zeros = 0
    while (this.read(1) === 0) { if (++zeros > 24) throw new Error('H.264 header 无效') }
    return 2 ** zeros - 1 + this.read(zeros)
  }
  se(): number { const value = this.ue(); return value % 2 ? (value + 1) / 2 : -value / 2 }
}

interface Sps {
  raw: Uint8Array; codec: string; frameBits: number; pocType: number; pocBits: number
  deltaAlwaysZero: boolean; frameOnly: boolean; separateColor: boolean
}
interface Pps { raw: Uint8Array; spsId: number; bottomPoc: boolean }

function readSps(nal: Uint8Array): { id: number; sps: Sps } {
  if (nal.length > 65536) throw new Error('SPS 过大')
  const bits = new Bits(nal)
  const profile = bits.read(8); bits.read(8); bits.read(8)
  const id = bits.ue()
  if (id > 31) throw new Error('SPS ID 无效')
  let separateColor = false
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = bits.ue()
    if (chroma > 3) throw new Error('SPS 色彩格式无效')
    if (chroma === 3) separateColor = Boolean(bits.read(1))
    bits.ue(); bits.ue(); bits.read(1)
    if (bits.read(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits.read(1)) continue
        let last = 8; let next = 8
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + bits.se() + 256) % 256
          if (next !== 0) last = next
        }
      }
    }
  }
  const frameBits = bits.ue() + 4
  if (frameBits > 16) throw new Error('SPS 帧号无效')
  const pocType = bits.ue()
  let pocBits = 0; let deltaAlwaysZero = false
  if (pocType === 0) { pocBits = bits.ue() + 4; if (pocBits > 16) throw new Error('SPS POC 无效') }
  else if (pocType === 1) {
    deltaAlwaysZero = Boolean(bits.read(1)); bits.se(); bits.se()
    const count = bits.ue()
    if (count > 255) throw new Error('SPS POC 过大')
    for (let i = 0; i < count; i++) bits.se()
  } else if (pocType !== 2) throw new Error('SPS POC 无效')
  bits.ue(); bits.read(1); bits.ue(); bits.ue()
  const frameOnly = Boolean(bits.read(1))
  const codec = `avc1.${[...nal.slice(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('')}`
  return { id, sps: { raw: nal, codec, frameBits, pocType, pocBits, deltaAlwaysZero, frameOnly, separateColor } }
}

function readPps(nal: Uint8Array): { id: number; pps: Pps } {
  if (nal.length > 65536) throw new Error('PPS 过大')
  const bits = new Bits(nal)
  const id = bits.ue(); const spsId = bits.ue(); bits.read(1)
  const bottomPoc = Boolean(bits.read(1))
  if (id > 255 || spsId > 31 || bits.ue() !== 0) throw new Error('不支持的 PPS / slice groups')
  return { id, pps: { raw: nal, spsId, bottomPoc } }
}

function concatenate(nals: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = nals.reduce((sum, nal) => sum + 4 + nal.length, 0)
  if (size > MAX_UNIT) throw new Error('H.264 帧缓冲过大')
  const output = new Uint8Array(size)
  let offset = 0
  for (const nal of nals) { output.set([0, 0, 0, 1], offset); output.set(nal, offset + 4); offset += 4 + nal.length }
  return output
}

export class H264Parser {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array()
  private sps = new Map<number, Sps>()
  private pps = new Map<number, Pps>()
  private nals: Uint8Array[] = []
  private unitBytes = 0
  private picture = ''
  private parameters: { sps: Sps; pps: Pps } | null = null
  private key = false
  private waitingForKey = true

  reset() {
    this.buffer = new Uint8Array(); this.sps.clear(); this.pps.clear()
    this.nals = []; this.unitBytes = 0; this.picture = ''; this.parameters = null
    this.key = false; this.waitingForKey = true
  }

  push(chunk: Uint8Array): AccessUnit[] {
    if (this.buffer.length + chunk.length > MAX_BUFFER) throw new Error('H.264 NAL 缓冲过大')
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer); combined.set(chunk, this.buffer.length)
    const starts: { offset: number; length: number }[] = []
    for (let i = 0; i + 2 < combined.length; i++) {
      if (combined[i] !== 0 || combined[i + 1] !== 0) continue
      const length = combined[i + 2] === 1 ? 3 : combined[i + 2] === 0 && combined[i + 3] === 1 ? 4 : 0
      if (length) { starts.push({ offset: i, length }); i += length - 1 }
    }
    const units: AccessUnit[] = []
    if (!starts.length) { this.buffer = combined; return units }
    if (combined.subarray(0, starts[0].offset).some(value => value !== 0)) throw new Error('H.264 起始码无效')
    for (let i = 0; i < starts.length - 1; i++) this.nal(combined.slice(starts[i].offset + starts[i].length, starts[i + 1].offset), units)
    this.buffer = combined.slice(starts[starts.length - 1].offset)
    return units
  }

  /** End of byte stream only; never flush at WebSocket message boundaries. */
  flush(): AccessUnit[] {
    const units: AccessUnit[] = []
    if (this.buffer.length) {
      const prefix = this.buffer[2] === 1 ? 3 : this.buffer[3] === 1 ? 4 : 0
      if (!prefix) throw new Error('H.264 尾部无效')
      this.nal(this.buffer.slice(prefix), units)
      this.buffer = new Uint8Array()
    }
    this.finish(units)
    return units
  }

  private finish(units: AccessUnit[]) {
    if (this.picture && this.parameters && (this.key || !this.waitingForKey)) {
      const params = this.key ? [this.parameters.sps.raw, this.parameters.pps.raw] : []
      units.push({ data: concatenate([...params, ...this.nals]), key: this.key, codec: this.parameters.sps.codec })
      if (this.key) this.waitingForKey = false
    }
    this.nals = []; this.unitBytes = 0; this.picture = ''; this.parameters = null; this.key = false
  }

  private nal(raw: Uint8Array, units: AccessUnit[]) {
    let end = raw.length
    while (end && raw[end - 1] === 0) end--
    const nal = raw.slice(0, end)
    if (!nal.length || nal[0] & 128) throw new Error('H.264 NAL header 无效')
    const type = nal[0] & 31
    if ([6, 7, 8, 9, 10, 11].includes(type) && this.picture) this.finish(units)
    if (type === 7) { const { id, sps } = readSps(nal); this.sps.set(id, sps); return }
    if (type === 8) { const { id, pps } = readPps(nal); this.pps.set(id, pps); return }
    if ([9, 10, 11, 12].includes(type)) return
    if (type === 1 || type === 5) {
      if (this.waitingForKey && !this.picture && type !== 5) return
      const bits = new Bits(nal)
      bits.ue(); bits.ue()
      const ppsId = bits.ue(); const pps = this.pps.get(ppsId); const sps = pps && this.sps.get(pps.spsId)
      if (!pps || !sps) throw new Error('IDR 缺少 SPS/PPS')
      const color = sps.separateColor ? bits.read(2) : 0
      const frameNum = bits.read(sps.frameBits)
      const field = !sps.frameOnly && Boolean(bits.read(1)); const bottom = field ? bits.read(1) : 0
      const idrId = type === 5 ? bits.ue() : -1
      let poc = 0; let delta0 = 0; let delta1 = 0
      if (sps.pocType === 0) { poc = bits.read(sps.pocBits); if (pps.bottomPoc && !field) delta0 = bits.se() }
      if (sps.pocType === 1 && !sps.deltaAlwaysZero) { delta0 = bits.se(); if (pps.bottomPoc && !field) delta1 = bits.se() }
      // H.264 7.4.1.2.4 picture identity; first_mb alone would split/rejoin
      // multi-slice pictures incorrectly when slice order changes.
      const picture = [ppsId, color, frameNum, field, bottom, (nal[0] & 96) === 0, type === 5, idrId, poc, delta0, delta1].join(':')
      if (this.picture && this.picture !== picture) this.finish(units)
      this.picture = picture; this.parameters = { sps, pps }; this.key = type === 5
    } else if (type !== 6) throw new Error(`不支持的 H.264 NAL ${type}`)
    this.unitBytes += nal.length + 4
    if (this.unitBytes > MAX_UNIT || this.nals.length >= 2048) throw new Error('H.264 帧缓冲过大')
    this.nals.push(nal)
  }
}

export interface H264Update {
  active: boolean; state: string; detail: string; width: number; height: number; fps: number
}
export interface H264Failure { reason: string; detail: string }

export function openAdbH264({ url, token, serial, deviceId, canvas, onChange, onFallback }: {
  url: string; token: string; serial: string; deviceId: string; canvas: HTMLCanvasElement
  onChange: (update: H264Update) => void; onFallback: (failure: H264Failure) => void
}) {
  if (!token) throw new Error('请先启用操作授权')
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) throw new Error('请明确选择已授权的 ADB 设备')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) throw new Error('配对设备 ID 无效')
  if (document.hidden) throw new Error('请在可见页面开始查看')
  const context = canvas.getContext('2d', { alpha: false })
  const parser = new H264Parser()
  let socket: WebSocket | null = null
  let decoder: VideoDecoder | null = null
  let codec = ''
  let closed = false
  let ready = false
  let resetSeen = false
  let posterSeen = false
  let videoDrawn = false
  let generation = 0
  let pumping = false
  let pending: AccessUnit[] = []
  let pendingBytes = 0
  let timestamp = 0
  let frameTimes: number[] = []
  let lastUpdate = 0
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const emit = (state: string, detail: string, fps = 0) => onChange({ state, detail, active: !closed, width: canvas.width, height: canvas.height, fps })
  const clearDecoder = (clearPicture = true) => {
    generation++
    if (decoder && decoder.state !== 'closed') decoder.close()
    decoder = null; codec = ''; pending = []; pendingBytes = 0; pumping = false
    parser.reset(); timestamp = 0; frameTimes = []; lastUpdate = 0
    posterSeen = false; videoDrawn = false
    if (clearPicture) {
      context?.clearRect(0, 0, canvas.width, canvas.height)
      canvas.width = canvas.height = 0
    }
  }
  const stop = (detail = '已停止查看', state = 'stopped') => {
    if (closed) return
    closed = true
    clearTimeout(watchdog)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('offline', offline)
    clearDecoder()
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      socket.close()
    }
    emit(state, detail)
  }
  const fail = (reason: string, detail: string, fallback = true) => {
    if (closed) return
    const safe = detail.replaceAll(token, '[已隐藏]').slice(0, 300)
    stop(safe, 'error')
    if (fallback) onFallback({ reason, detail: safe })
  }
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => fail('timeout', 'ADB 长时间没有可解码画面'), 12000) }
  const visibility = () => { if (document.hidden) stop('页面已隐藏，已停止共享') }
  const offline = () => stop('网络已断开，请重新开始查看', 'offline')
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('offline', offline)
  arm()

  const pump = async () => {
    if (pumping || closed) return
    pumping = true
    const epoch = generation
    try {
      while (pending.length && !closed && epoch === generation) {
        const unit = pending.shift()!
        pendingBytes -= unit.data.length
        if (!decoder || codec !== unit.codec) {
          if (!unit.key) throw new Error('H.264 编码配置变化但缺少 IDR')
          const config: VideoDecoderConfig = { codec: unit.codec, optimizeForLatency: true }
          const support = await VideoDecoder.isConfigSupported(config)
          if (closed || epoch !== generation) return
          if (!support.supported) throw new Error('浏览器不支持设备的 H.264 编码格式')
          if (decoder && decoder.state !== 'closed') decoder.close()
          const currentDecoder = new VideoDecoder({
            output: frame => {
              try {
                if (closed || epoch !== generation || decoder !== currentDecoder) return
                if (frame.displayWidth < 1 || frame.displayHeight < 1 || frame.displayWidth > 8192 || frame.displayHeight > 8192) throw new Error('视频尺寸无效')
                if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
                if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
                context!.drawImage(frame, 0, 0, canvas.width, canvas.height)
                videoDrawn = true
                clearTimeout(watchdog)
                const now = performance.now()
                frameTimes = [...frameTimes.filter(at => now - at < 3000), now].slice(-240)
                if (!lastUpdate || now - lastUpdate > 250) {
                  const fps = frameTimes.length > 1 ? (frameTimes.length - 1) * 1000 / (now - frameTimes[0]) : 0
                  emit('streaming', 'ADB H.264 整屏投屏中', fps); lastUpdate = now
                }
              } catch { fail('decode', 'H.264 画面绘制失败') }
              finally { frame.close() }
            },
            error: () => { if (epoch === generation && decoder === currentDecoder) fail('decode', '浏览器 H.264 解码失败') },
          })
          decoder = currentDecoder; codec = unit.codec
          decoder.configure(config)
        }
        if (decoder.decodeQueueSize >= 8) throw new Error('H.264 解码队列过载')
        timestamp = Math.max(timestamp + 1, Math.round(performance.now() * 1000))
        decoder.decode(new EncodedVideoChunk({ type: unit.key ? 'key' : 'delta', timestamp, data: unit.data }))
      }
    } catch (error) {
      if (epoch === generation) fail('decode', error instanceof Error ? error.message : 'H.264 解码失败')
    } finally { if (epoch === generation) pumping = false }
  }

  emit('connecting', '正在连接选定的 ADB 设备')
  if (!context || typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function' || typeof EncodedVideoChunk === 'undefined') {
    queueMicrotask(() => fail('unsupported', '当前浏览器不支持 WebCodecs H.264 解码'))
    return { stop }
  }
  try {
    socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => { if (!closed) socket?.send(JSON.stringify({ type: 'screen.auth', operator_token: token, serial, device_id: deviceId })) }
    socket.onmessage = event => {
      if (closed) return
      try {
        if (typeof event.data === 'string') {
          if (event.data.length > 4096) throw new Error('H.264 状态消息过大')
          const message = JSON.parse(event.data)
          if (message.type === 'h264.ready') {
            if (ready || message.serial !== serial || message.device_id !== deviceId || message.codec !== 'h264' || message.scope !== 'display') throw new Error('H.264 设备会话不匹配')
            ready = true; emit('ready', 'ADB 已连接，等待视频关键帧')
          } else if (message.type === 'h264.reset') {
            if (!ready) throw new Error('H.264 尚未授权')
            clearDecoder(false); resetSeen = true
            if (canvas.width > 0 && canvas.height > 0) clearTimeout(watchdog)
            else arm()
            emit('ready', '录制周期已更新，等待视频关键帧')
          } else if (message.type === 'screen.status' && message.state === 'error') {
            const reason = typeof message.reason === 'string' ? message.reason : 'encoder'
            const detail = typeof message.detail === 'string' ? message.detail : 'ADB 投屏失败'
            fail(reason, detail, !['busy', 'auth', 'unauthorized', 'forbidden'].includes(reason))
          } else throw new Error('H.264 状态消息无效')
          return
        }
        if (!ready || !resetSeen || !(event.data instanceof ArrayBuffer) || !event.data.byteLength) throw new Error('H.264 数据无效')
        const bytes = new Uint8Array(event.data)
        if (bytes[0] === 65 && bytes[1] === 82 && bytes[2] === 83 && bytes[3] === 80) {
          if (posterSeen || bytes.length < 28 || bytes.length > 8_000_004 || typeof createImageBitmap !== 'function') throw new Error('ADB 首屏数据无效')
          const signature = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]
          if (signature.some((byte, index) => bytes[index + 4] !== byte)) throw new Error('ADB 首屏不是 PNG')
          const header = new DataView(event.data)
          const width = header.getUint32(20); const height = header.getUint32(24)
          if (width < 1 || width > 8192 || height < 1 || height > 8192 || width * height > 24_000_000) throw new Error('ADB 首屏尺寸无效')
          posterSeen = true
          const epoch = generation
          void createImageBitmap(new Blob([event.data.slice(4)], { type: 'image/png' })).then(bitmap => {
            try {
              if (closed || epoch !== generation || videoDrawn) return
              if (bitmap.width !== width || bitmap.height !== height) throw new Error('ADB 首屏尺寸不匹配')
              if (canvas.width !== width) canvas.width = width
              if (canvas.height !== height) canvas.height = height
              context!.drawImage(bitmap, 0, 0, width, height)
              clearTimeout(watchdog)
              emit('streaming', 'ADB H.264 整屏已连接，静止画面按变化更新')
            } finally { bitmap.close() }
          }).catch(() => { if (!closed && epoch === generation && !videoDrawn) fail('decode', 'ADB 首屏解码失败') })
          return
        }
        if (bytes.length > 65536) throw new Error('H.264 数据过大')
        const units = parser.push(bytes)
        pending.push(...units); pendingBytes += units.reduce((sum, unit) => sum + unit.data.length, 0)
        if (pending.length > 8 || pendingBytes > 8 * 1024 * 1024) throw new Error('H.264 待解码缓冲过载')
        void pump()
      } catch (error) { fail('protocol', error instanceof Error ? error.message : 'H.264 数据无效') }
    }
    socket.onerror = () => fail('unavailable', 'ADB 视频连接失败')
    socket.onclose = event => {
      if (event.code === 1008) fail('auth', 'ADB 投屏授权被拒绝，请检查操作授权和设备选择', false)
      else fail('interrupted', 'ADB 视频流已中断')
    }
  } catch { queueMicrotask(() => fail('unavailable', '无法建立 ADB 视频连接')) }
  return { stop }
}
