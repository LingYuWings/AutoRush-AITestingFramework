import { uiText } from '../../shared/i18n.ts'
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
  // Forward session updates with the active source and display metrics.
  const emit = (update: ScreenUpdate, width = 0, height = 0, fps = 0) => {
    if (!closed) options.onChange({ ...update, source, width, height, fps })
  }
  // Open the Portal screenshot stream if the phone is reachable.
  const startPreview = (reason = '') => {
    if (closed) return
    source = 'wss'
    if (!online) {
      emit({ state: 'offline', active: false, frame: null, detail: uiText("{0}Portal 已离线，请先连接手机后使用 WSS 预览", reason ? reason + ' · ' : '') })
      return
    }
    try {
      preview = openScreen({ url: options.url, token: options.token, mode: 'preview', /* Forward the screenshot state and include the ADB fallback reason if present. */ onChange: update => {
        emit({ ...update, detail: reason ? uiText("{0}；已回退 WSS 截图预览：{1}", reason, update.detail) : update.detail }, update.frame?.metadata.width, update.frame?.metadata.height)
      } })
    } catch (error) {
      emit({ state: 'error', active: false, frame: null, detail: error instanceof Error ? error.message : uiText("WSS 预览连接失败") })
    }
  }
  if (options.mode === 'preview') startPreview()
  else if (!options.serial) startPreview(uiText("未选择可用的 ADB 手机"))
  else {
    source = 'adb'
    try {
      video = openAdbH264({ url: options.adbUrl, token: options.token, serial: options.serial, deviceId: options.deviceId,
        canvas: options.canvas,
        // Forward the ADB decoder's status and canvas metrics.
        onChange: update => emit({ ...update, frame: null }, update.width, update.height, update.fps),
        // Switch from ADB to Portal preview at most once.
        onFallback: failure => {
          if (closed || fallback) return
          fallback = true
          startPreview(failure.detail)
        },
      })
    } catch (error) { startPreview(error instanceof Error ? error.message : uiText("ADB 投屏不可用")) }
  }
  return {
    // Stop any active stream and publish a final idle display state.
    stop: (detail = uiText("已停止查看"), state = 'stopped') => {
      if (closed) return
      closed = true
      video?.stop(); preview?.stop()
      options.onChange({ state, detail, active: false, frame: null, source: null, width: 0, height: 0, fps: 0 })
    },
    // Stop WSS preview if its Portal disconnects.
    portalChanged: (connected: boolean) => {
      online = connected
      if (!online && source === 'wss') preview?.stop(uiText("Portal 已离线"), 'offline')
    },
    // Forward a rendered preview image to its acknowledgment handler.
    loaded: (url: string) => preview?.loaded(url),
    // Forward a failed preview image to its error handler.
    failed: (url: string) => preview?.failed(url),
  }
}
