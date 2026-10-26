import type { PairingPayload } from '../../shared/api'

export function pairingPayload(connection: 'usb' | 'wss' | 'lan', serial: string, server: string, packages: string): PairingPayload {
  const allowedPackages = [...new Set(packages.split(/[\s,，]+/).filter(Boolean))]
  if (!allowedPackages.length || allowedPackages.length > 10) throw new Error('请填写 1–10 个允许测试的 App 包名。')
  if (allowedPackages.includes('com.autorush.portal')) throw new Error('允许列表不能包含 Portal 自身（com.autorush.portal）。')
  if (allowedPackages.some(value => value.length > 200 || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value))) {
    throw new Error('App 包名格式无效，请使用完整包名，例如 com.autorush.fixture。')
  }
  if (connection === 'lan') return { connection, allowed_packages: allowedPackages, expires_in: 180 }
  if (connection === 'usb') {
    if (!serial) throw new Error('请先选择已授权的 USB 设备。')
    return { connection, adb_serial: serial, allowed_packages: allowedPackages, expires_in: 180 }
  }
  const address = server.trim()
  if (address.length > 512 || /[\s\u0000-\u001f]/.test(address)) throw new Error('WSS 地址不能包含空白字符，长度最多 512 个字符。')
  let url: URL
  try { url = new URL(address) }
  catch { throw new Error('请填写有效的 WSS 服务器地址。') }
  if (url.protocol !== 'wss:' || url.pathname !== '/api/v1/devices/ws' || url.username || url.password || address.includes('@') || address.includes('?') || address.includes('#') || url.search || url.hash || url.port === '0') {
    throw new Error('WSS 地址必须以 wss:// 开头，路径为 /api/v1/devices/ws，且不包含凭据、查询参数或片段。')
  }
  return { connection, server_url: url.href, allowed_packages: allowedPackages, expires_in: 180 }
}
