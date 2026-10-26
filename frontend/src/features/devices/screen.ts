export type ScreenMode = 'preview' | 'smooth'
export interface FrameMetadata {
  stream_id: string
  sequence: number
  width: number
  height: number
  package: string
  captured_at: number
}
export interface ScreenUpdate {
  state: string
  detail: string
  active: boolean
  frame: { url: string; metadata: FrameMetadata } | null
}

/** Validate the bounded wire envelope before allocating an image URL. */
export function parseScreenFrame(data: ArrayBuffer): { metadata: FrameMetadata; jpeg: Uint8Array<ArrayBuffer> } {
  const bytes = new Uint8Array(data)
  if (bytes.length < 12 || bytes.length > 8 + 2048 + 600000 || bytes[0] !== 65 || bytes[1] !== 82 || bytes[2] !== 70 || bytes[3] !== 49) throw new Error('画面数据格式无效')
  const length = new DataView(data).getUint32(4, false)
  const jpegLength = bytes.length - 8 - length
  if (length < 1 || length > 2048 || jpegLength < 4 || jpegLength > 600000) throw new Error('画面数据大小无效')
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length)))
  const keys = ['stream_id', 'sequence', 'width', 'height', 'package', 'captured_at']
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== keys.length || keys.some(key => !(key in metadata))
    || typeof metadata.stream_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata.stream_id)
    || typeof metadata.package !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(metadata.package) || metadata.package.length > 200
    || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1
    || !Number.isSafeInteger(metadata.width) || metadata.width < 1 || metadata.width > 1280
    || !Number.isSafeInteger(metadata.height) || metadata.height < 1 || metadata.height > 1280
    || !Number.isSafeInteger(metadata.captured_at) || metadata.captured_at < 1) throw new Error('画面元数据无效')
  const jpeg = bytes.slice(8 + length)
  if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[jpeg.length - 2] !== 255 || jpeg[jpeg.length - 1] !== 217) throw new Error('画面不是 JPEG')
  return { metadata, jpeg }
}

/** One explicit viewing session; callers stop it on unmount, auth or mode changes. */
export function openScreen({ url, token, mode, onChange }: {
  url: string; token: string; mode: ScreenMode; onChange: (update: ScreenUpdate) => void
}) {
  if (!token) throw new Error('请先连接本地配对服务或启用操作授权')
  if (document.hidden) throw new Error('请在可见页面开始查看')
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  let closed = false
  let streamId = ''
  let sequence = -1
  let awaitingLoad = false
  let frame: ScreenUpdate['frame'] = null
  const clearFrame = () => {
    if (frame) URL.revokeObjectURL(frame.url)
    frame = null
    awaitingLoad = false
  }
  const emit = (state: string, detail: string) => onChange({ state, detail, active: !closed, frame })
  const stop = (detail = '已停止查看', state = 'stopped') => {
    if (closed) return
    closed = true
    clearTimeout(handshake)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('offline', offline)
    clearFrame()
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    socket.close()
    emit(state, detail)
  }
  const visibility = () => { if (document.hidden) stop('页面已隐藏，已停止共享') }
  const offline = () => stop('网络已断开，请重新开始查看', 'offline')
  const handshake = setTimeout(() => stop('连接画面超时，请检查设备和授权', 'error'), 8000)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('offline', offline)
  socket.onopen = () => {
    if (!closed) socket.send(JSON.stringify({ type: 'screen.auth', operator_token: token, mode }))
  }
  socket.onmessage = event => {
    if (closed) return
    try {
      if (typeof event.data === 'string') {
        if (event.data.length > 4096) throw new Error('画面状态消息过长')
        const message = JSON.parse(event.data)
        if (message.type === 'screen.ready') {
          if (streamId || message.mode !== mode || typeof message.stream_id !== 'string' || !message.stream_id || message.stream_id.length > 100) throw new Error('画面会话无效')
          streamId = message.stream_id
          clearTimeout(handshake)
          emit('ready', '已连接，等待手机画面')
        } else if (message.type === 'screen.status') {
          if (typeof message.state !== 'string') throw new Error('画面状态无效')
          const detail = typeof message.detail === 'string' ? message.detail.replaceAll(token, '[已隐藏]') : message.state
          if (['starting', 'streaming', 'ready'].includes(message.state)) emit(message.state, detail)
          else if (['blocked', 'permission_required'].includes(message.state)) {
            // Server delivers status only after the previous frame ACK.
            if (awaitingLoad) throw new Error('画面状态顺序无效')
            clearFrame()
            emit(message.state, detail)
          }
          else stop(detail, message.state)
        } else throw new Error('不支持的画面消息')
        return
      }
      if (!(event.data instanceof ArrayBuffer)) throw new Error('画面数据无效')
      const parsed = parseScreenFrame(event.data)
      if (!streamId || parsed.metadata.stream_id !== streamId || parsed.metadata.sequence <= sequence || awaitingLoad) throw new Error('画面顺序无效，请重新连接')
      sequence = parsed.metadata.sequence
      clearFrame()
      frame = { url: URL.createObjectURL(new Blob([parsed.jpeg], { type: 'image/jpeg' })), metadata: parsed.metadata }
      awaitingLoad = true
      emit('streaming', '正在接收画面')
    } catch { stop('收到无效画面数据，请重新开始查看', 'error') }
  }
  socket.onerror = () => stop('画面连接失败，请检查设备和操作授权', 'error')
  socket.onclose = () => stop('画面连接已断开，请重新开始查看', 'offline')
  emit('connecting', '正在连接设备画面')
  return {
    stop,
    loaded: (imageUrl: string) => {
      if (closed || !frame || frame.url !== imageUrl || !awaitingLoad || socket.readyState !== 1) return
      awaitingLoad = false
      socket.send(JSON.stringify({ type: 'frame.ack', sequence: frame.metadata.sequence }))
    },
    failed: (imageUrl: string) => { if (frame?.url === imageUrl) stop('画面解码失败，请重新开始查看', 'error') },
  }
}
