const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { closeSync, existsSync, openSync, readFileSync, writeFileSync } = require('node:fs')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

// Register the scheme before Electron initializes so packaged pages can use fetch and streams.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const distRoot = path.resolve(__dirname, '..', 'dist')
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}
const documentationHosts = new Set(['developers.openai.com', 'help.aliyun.com', 'docs.ollama.com'])
const frontendPort = Number(process.argv?.find(arg => arg.startsWith('--autorush-frontend-port='))?.split('=')[1])
const devOrigin = `http://127.0.0.1:${Number.isInteger(frontendPort) && frontendPort >= 1024 && frontendPort <= 65535 ? frontendPort : 5173}`
let backend
let shuttingDown = false
let mainWindow
let splashWindow

// Window chrome colours mirror the console tokens (--bg, --surface, --ink-2, --accent) for each theme.
const palette = {
  light: { background: '#f7f7f6', surface: '#ffffff', symbol: '#4a4a50', ink: '#1b1b1d', muted: '#7c7c84', line: '#e6e6e3', accent: '#2f5bd3', onAccent: '#ffffff' },
  dark: { background: '#121214', surface: '#19191c', symbol: '#b8b8bf', ink: '#ececee', muted: '#85858e', line: '#2a2a2f', accent: '#7c9cf0', onAccent: '#0f1530' },
}
// Native caption buttons overlay the console top bar (48px including its 1px bottom border).
const titleBarHeight = 47
const overlayCaptions = process.platform === 'win32' || process.platform === 'linux'
const menuLabels = {
  'zh-CN': { undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选', starting: '正在启动本地服务…' },
  en: { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', starting: 'Starting the local service…' },
}

// Read a small JSON file from user data, falling back when it is missing or malformed.
function readUserJson(name, fallback) {
  try { return { ...fallback, ...JSON.parse(readFileSync(path.join(app.getPath('userData'), name), 'utf8')) } }
  catch { return fallback }
}

// Remember the last appearance the console reported so startup chrome matches before the page loads.
let preferences = { theme: null, language: 'zh-CN' }
function currentTheme() {
  if (preferences.theme === 'dark' || preferences.theme === 'light') return preferences.theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

// Restore the previous window bounds only when they are still visible on a connected display.
function restoredBounds() {
  const saved = readUserJson('window-state.json', {})
  const size = {
    width: Number.isFinite(saved.width) ? Math.max(940, saved.width) : 1380,
    height: Number.isFinite(saved.height) ? Math.max(650, saved.height) : 900,
  }
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { bounds: size, maximized: saved.maximized === true }
  const bounds = { ...size, x: saved.x, y: saved.y }
  const area = screen.getDisplayMatching(bounds).workArea
  const visible = bounds.x < area.x + area.width - 100 && bounds.x + bounds.width > area.x + 100
    && bounds.y >= area.y - 8 && bounds.y < area.y + area.height - 60
  return { bounds: visible ? bounds : size, maximized: saved.maximized === true }
}

// Persist the restorable (non-maximized) bounds and the maximized flag when the window closes.
function saveWindowState(window) {
  if (window.isMinimized() || window.isFullScreen()) return
  try {
    writeFileSync(path.join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }))
  } catch { /* Window placement is a convenience; failing to save it must not block quitting. */ }
}

// Keep keyboard accelerators (editing, zoom, full screen) without showing a classic menu bar.
function installApplicationMenu() {
  const developer = app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...developer] },
  ]))
}

// Offer the standard text editing menu on right-click in fields and over selected text.
function showContextMenu(window, params) {
  const text = menuLabels[preferences.language] ?? menuLabels['zh-CN']
  const flags = params.editFlags
  const items = params.isEditable ? [
    { role: 'undo', label: text.undo, enabled: flags.canUndo },
    { role: 'redo', label: text.redo, enabled: flags.canRedo },
    { type: 'separator' },
    { role: 'cut', label: text.cut, enabled: flags.canCut },
    { role: 'copy', label: text.copy, enabled: flags.canCopy },
    { role: 'paste', label: text.paste, enabled: flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', label: text.selectAll, enabled: flags.canSelectAll },
  ] : params.selectionText.trim() ? [{ role: 'copy', label: text.copy }] : []
  if (items.length) Menu.buildFromTemplate(items).popup({ window })
}

// Apply a theme to the window background and the native caption buttons.
function applyWindowTheme(window, theme) {
  const colors = palette[theme]
  window.setBackgroundColor(colors.background)
  if (overlayCaptions) window.setTitleBarOverlay({ color: colors.surface, symbolColor: colors.symbol, height: titleBarHeight })
}

// Build the splash page: brand mark, product name, status line and an indeterminate bar.
function splashHtml(colors, status) {
  const mark = `<svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="${colors.accent}"/>`
    + `<g fill="none" stroke="${colors.onAccent}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 10.5 15.5 16 9.5 21.5" opacity=".55"/><path d="M17.5 21.5h6"/></g>`
    + `<circle cx="22.5" cy="10.5" r="1.9" fill="${colors.onAccent}"/></svg>`
  const style = [
    `html,body{margin:0;height:100%;background:${colors.background};color:${colors.ink};font:13px "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-user-select:none;cursor:default}`,
    `body{box-sizing:border-box;display:grid;place-content:center;justify-items:center;gap:12px;border:1px solid ${colors.line}}`,
    'strong{font-size:16px;font-weight:600;letter-spacing:-.01em}',
    `p{margin:0;color:${colors.muted}}`,
    `.bar{width:168px;height:3px;margin-top:6px;border-radius:2px;background:${colors.line};overflow:hidden}`,
    `.bar::after{content:"";display:block;width:40%;height:100%;border-radius:2px;background:${colors.accent};animation:slide 1.2s cubic-bezier(.2,.7,.2,1) infinite}`,
    '@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(260%)}}',
    '@media (prefers-reduced-motion:reduce){.bar::after{animation:none;width:100%;opacity:.45}}',
  ].join('\n')
  return `<!doctype html><meta charset="utf-8"><title>AutoRush AITester</title><style>${style}</style>${mark}<strong>AutoRush AITester</strong><p>${status}</p><div class="bar"></div>`
}

// Show a small branded splash while the bundled backend starts, so launching never looks stalled.
function showSplash() {
  const colors = palette[currentTheme()]
  const text = menuLabels[preferences.language] ?? menuLabels['zh-CN']
  splashWindow = new BrowserWindow({
    width: 360, height: 220, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false, center: true,
    backgroundColor: colors.background, title: 'AutoRush AITester',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  })
  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => { splashWindow = undefined })
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(colors, text.starting))}`)
}

// Close the splash once the console has painted (or startup has failed).
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
  splashWindow = undefined
}
const bundledExecutable = path.join(process.resourcesPath, 'backend', 'autorush-backend.exe')
const bundled = app.isPackaged && existsSync(bundledExecutable)
let backendPort = bundled ? 18000 : 8000

const runtimeKeys = [
  'AUTORUSH_DB_PATH', 'AUTORUSH_REPORT_DIR', 'AUTORUSH_LOG_DIR', 'AUTORUSH_BACKEND_PORT', 'AUTORUSH_LOCAL_DEVICE_PORT',
  'AUTORUSH_DESKTOP_ENABLED', 'AUTORUSH_ALLOWED_API_HOSTS', 'AUTORUSH_ALLOWED_WEB_HOSTS', 'AUTORUSH_ALLOWED_LLM_HOSTS',
  'AUTORUSH_LOCAL_VISION_LAUNCHER', 'PLAYWRIGHT_BROWSERS_PATH',
  'AUTORUSH_MCP_API_URL', 'AUTORUSH_MCP_CONSOLE_ORIGIN', 'AUTORUSH_MCP_ALLOWED_PACKAGES',
]

// Apply saved non-secret values below explicit environment overrides when starting the bundled service.
function bundledEnvironment(userData) {
  const configPath = path.resolve(process.env.AUTORUSH_CONFIG_PATH || path.join(userData, 'autorush.settings.json'))
  const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const env = { ...process.env }
  for (const key of runtimeKeys) {
    if (env[key] === undefined && typeof saved[key] === 'string') env[key] = saved[key]
  }
  env.AUTORUSH_CONFIG_PATH = configPath
  env.AUTORUSH_LAUNCH_MODE = 'packaged'
  env.AUTORUSH_DB_PATH ||= path.join(userData, 'data', 'autorush.sqlite3')
  env.AUTORUSH_REPORT_DIR ||= path.join(userData, 'reports')
  env.AUTORUSH_LOG_DIR ||= path.join(userData, 'logs')
  env.AUTORUSH_BACKEND_PORT ||= '18000'
  env.AUTORUSH_DESKTOP_ENABLED ??= process.platform === 'win32' ? '1' : '0'
  env.AUTORUSH_ALLOWED_WEB_HOSTS ??= '127.0.0.1,localhost'
  env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(process.resourcesPath, 'playwright-browsers')
  const port = Number(env.AUTORUSH_BACKEND_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid AutoRush backend port.')
  backendPort = port
  return env
}

// Accept settings IPC only from the top-level console document on the configured origin.
function settingsWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window !== mainWindow || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return null
  const url = URL.parse(event.senderFrame.url)
  if (!url) return null
  const consolePage = app.isPackaged ? url.protocol === 'app:' && url.host === 'autorush' : url.origin === devOrigin
  return consolePage ? window : null
}

// Check the bundled loopback service, bounding the response and wait time.
async function backendHealthy(instance) {
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/health`, { signal: AbortSignal.timeout(700) })
    if (!response.ok) return false
    const reader = response.body.getReader()
    let body = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return JSON.parse(body).status === 'ok' && response.headers.get('x-autorush-instance') === instance
        if (body.length + value.length > 1024) return false
        body += Buffer.from(value).toString('utf8')
      }
    } finally { await reader.cancel().catch(() => {}) }
  } catch { return false }
}

// Start an owned backend on the release port, separate from development data.
async function startBundledBackend() {
  if (!bundled) return
  const userData = app.getPath('userData')
  const env = bundledEnvironment(userData)
  const logDir = env.AUTORUSH_LOG_DIR
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, 'backend.log')
  const instance = randomUUID()
  env.AUTORUSH_RELEASE_INSTANCE = instance
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  const log = openSync(logPath, 'w')
  try {
    backend = spawn(bundledExecutable, { cwd: userData, env, windowsHide: true, stdio: ['pipe', log, log] })
  } finally { closeSync(log) }
  let failure
  backend.on('error', error => { failure = error })
  backend.stdin.on('error', () => { /* A child that already stopped has no input pipe. */ })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (failure || backend.exitCode !== null || backend.signalCode !== null) break
    if (await backendHealthy(instance)) return
    await delay(250)
  }
  throw new Error(`The bundled backend could not start on 127.0.0.1:${backendPort}.\nStartup log: ${logPath}`)
}

// Let the owned backend finish cleanup before Electron quits, with a bounded fallback.
function stopBundledBackend(event) {
  const child = backend
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  child.once('close', () => { clearTimeout(deadline); backend = undefined; app.quit() })
  const deadline = setTimeout(() => {
    child.kill()
    backend = undefined
    app.quit()
  }, 8000)
  child.stdin.end()
}

// Serve packaged UI assets through the app origin with a restricted content policy.
function registerLocalProtocol() {
  protocol.handle('app', async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'autorush') return new Response('Not found', { status: 404 })
    let relativePath
    try { relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname) }
    catch { return new Response('Bad request', { status: 400 }) }
    const filePath = path.resolve(distRoot, `.${relativePath}`)
    if (!filePath.startsWith(distRoot + path.sep)) return new Response('Forbidden', { status: 403 })
    const mime = mimeTypes[path.extname(filePath)]
    if (!mime) return new Response('Not found', { status: 404 })
    try {
      const contents = await readFile(filePath)
      return new Response(contents, {
        headers: {
          'Content-Type': mime,
          'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src http://127.0.0.1:${backendPort} ws://127.0.0.1:${backendPort}; object-src 'none'; base-uri 'none'; frame-src 'none'`,
        },
      })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

// Open the desktop console and allow only approved documentation links to leave it.
function createWindow() {
  const colors = palette[currentTheme()]
  const { bounds, maximized } = restoredBounds()
  // Content extends into the title bar: Windows/Linux keep native caption buttons as an overlay, macOS keeps inset traffic lights.
  const chrome = overlayCaptions
    ? { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.surface, symbolColor: colors.symbol, height: titleBarHeight } }
    : process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}
  const window = new BrowserWindow({
    ...bounds, minWidth: 940, minHeight: 650, show: false,
    backgroundColor: colors.background, title: 'AutoRush AITester', ...chrome,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--autorush-version=${app.getVersion()}`, `--autorush-backend-port=${bundled ? backendPort : process.env.AUTORUSH_BACKEND_PORT || 8000}`],
    },
  })
  mainWindow = window
  window.setMenuBarVisibility(false)
  // Reveal the window only after the first paint, restoring the maximized state, to avoid a blank flash.
  window.once('ready-to-show', () => {
    if (maximized) window.maximize()
    window.show()
    if (!app.isPackaged && process.argv.includes('--autorush-open-devtools')) window.webContents.openDevTools({ mode: 'detach' })
    closeSplash()
  })
  window.on('close', () => saveWindowState(window))
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  window.webContents.on('context-menu', (_event, params) => showContextMenu(window, params))
  window.webContents.on('did-finish-load', () => { void window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}) })
  const allowedOrigin = app.isPackaged ? 'app://autorush' : devOrigin
  window.webContents.on('will-navigate', (event, destination) => {
    if (new URL(destination).origin !== allowedOrigin) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const destination = new URL(url)
      if (destination.protocol === 'https:' && documentationHosts.has(destination.hostname)) {
        void shell.openExternal(destination.toString())
      }
    } catch { /* Invalid links remain closed. */ }
    return { action: 'deny' }
  })
  if (app.isPackaged) window.loadURL(`app://autorush/index.html?backendPort=${backendPort}`)
  else window.loadURL(devOrigin)
}

// Install the packaged protocol and deny renderer permissions before opening a window.
if (app.isPackaged && !app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  if (app.isPackaged) registerLocalProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  preferences = readUserJson('desktop-preferences.json', preferences)
  installApplicationMenu()
  ipcMain.handle('desktop:choose-settings-path', async (event, kind) => {
    const window = settingsWindow(event)
    if (!window) return null
    if (!['directory', 'file', 'database'].includes(kind)) return null
    const result = kind === 'database'
      ? await dialog.showSaveDialog(window, { filters: [{ name: 'SQLite', extensions: ['sqlite3', 'db', 'sqlite'] }] })
      : await dialog.showOpenDialog(window, { properties: kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'] })
    return result.canceled ? null : result.filePath ?? result.filePaths?.[0] ?? null
  })
  // Accept appearance updates only from the console page itself, then persist them for the next launch.
  ipcMain.on('desktop:preferences', (event, value) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== mainWindow || event.senderFrame !== window.webContents.mainFrame) return
    const theme = value?.theme === 'dark' ? 'dark' : 'light'
    const language = value?.language === 'en' ? 'en' : 'zh-CN'
    applyWindowTheme(window, theme)
    if (theme === preferences.theme && language === preferences.language) return
    preferences = { theme, language }
    void writeFile(path.join(app.getPath('userData'), 'desktop-preferences.json'), JSON.stringify(preferences)).catch(() => {})
  })
  if (bundled) showSplash()
  try { await startBundledBackend() }
  catch (error) {
    closeSplash()
    dialog.showErrorBox('AutoRush AITester', error.message)
    app.quit()
    return
  }
  createWindow()
  app.on('second-instance', () => {
    const window = mainWindow
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', stopBundledBackend)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
