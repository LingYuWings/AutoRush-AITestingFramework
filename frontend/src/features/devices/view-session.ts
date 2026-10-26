import { openAdbH264 } from './h264.ts'
import { openScreen } from './screen.ts'
import type { ScreenMode, ScreenUpdate } from './screen.ts'

export interface DeviceScreenUpdate extends ScreenUpdate {
  source: 'adb' | 'wss' | null
  width: number
  height: number
  fps: number
}

/** Owns one explicit viewing session and at most one fallback to its Portal. */
export function openDeviceScreen(options: {
  deviceId: string; serial: string; mode: ScreenMode; url: string; adbUrl: string
  token: string; online: boolean; canvas: HTMLCanvasElement
  onChange: (update: DeviceScreenUpdate) => void
}) {
  let closed = false
  let online = options.online
  let fallback = false
  let source: DeviceScreenUpdate['source'] = null
  let preview: ReturnType<typeof openScreen> | null = null
  let video: ReturnType<typeof openAdbH264> | null = null
  const emit = (update: ScreenUpdate, width = 0, height = 0, fps = 0) => {
    if (!closed) options.onChange({ ...update, source, width, height, fps })
  }
  const startPreview = (reason = '') => {
    if (closed) return
    source = 'wss'
    if (!online) {
      emit({ state: 'offline', active: false, frame: null, detail: `${reason ? reason + '；' : ''}Portal 已离线，请先连接手机后使用 WSS 预览` })
      return
    }
    try {
      preview = openScreen({ url: options.url, token: options.token, mode: 'preview', onChange: update => {
        emit({ ...update, detail: reason ? `${reason}；已回退 WSS 截图预览：${update.detail}` : update.detail }, update.frame?.metadata.width, update.frame?.metadata.height)
      } })
    } catch (error) {
      emit({ state: 'error', active: false, frame: null, detail: error instanceof Error ? error.message : 'WSS 预览连接失败' })
    }
  }
  if (options.mode === 'preview') startPreview()
  else if (!options.serial) startPreview('未选择可用的 ADB 手机')
  else {
    source = 'adb'
    try {
      video = openAdbH264({ url: options.adbUrl, token: options.token, serial: options.serial, deviceId: options.deviceId,
        canvas: options.canvas,
        onChange: update => emit({ ...update, frame: null }, update.width, update.height, update.fps),
        onFallback: failure => {
          if (closed || fallback) return
          fallback = true
          startPreview(failure.detail)
        },
      })
    } catch (error) { startPreview(error instanceof Error ? error.message : 'ADB 投屏不可用') }
  }
  return {
    stop: (detail = '已停止查看', state = 'stopped') => {
      if (closed) return
      closed = true
      video?.stop(); preview?.stop()
      options.onChange({ state, detail, active: false, frame: null, source: null, width: 0, height: 0, fps: 0 })
    },
    portalChanged: (connected: boolean) => {
      online = connected
      if (!online && source === 'wss') preview?.stop('Portal 已离线', 'offline')
    },
    loaded: (url: string) => preview?.loaded(url),
    failed: (url: string) => preview?.failed(url),
  }
}
