const { app, BrowserWindow, dialog, protocol, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { closeSync, existsSync, openSync } = require('node:fs')
const { mkdir, readFile } = require('node:fs/promises')
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
let backend
let shuttingDown = false
const bundledExecutable = path.join(process.resourcesPath, 'backend', 'autorush-backend.exe')
const bundled = app.isPackaged && existsSync(bundledExecutable)
const backendPort = bundled ? 18000 : 8000

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
  const logDir = path.join(userData, 'logs')
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, 'backend.log')
  const instance = randomUUID()
  const env = { ...process.env,
    AUTORUSH_DB_PATH: path.join(userData, 'data', 'autorush.sqlite3'),
    AUTORUSH_REPORT_DIR: path.join(userData, 'reports'),
    AUTORUSH_BACKEND_PORT: String(backendPort),
    AUTORUSH_RELEASE_INSTANCE: instance,
    AUTORUSH_DESKTOP_ENABLED: process.platform === 'win32' ? '1' : '0',
    AUTORUSH_ALLOWED_WEB_HOSTS: process.env.AUTORUSH_ALLOWED_WEB_HOSTS ?? '127.0.0.1,localhost',
    PLAYWRIGHT_BROWSERS_PATH: path.join(process.resourcesPath, 'playwright-browsers'),
  }
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
  const window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 940, minHeight: 650,
    backgroundColor: '#f5f7fb', title: 'AutoRush AITester',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
  const allowedOrigin = app.isPackaged ? 'app://autorush' : 'http://127.0.0.1:5173'
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
  else window.loadURL('http://127.0.0.1:5173')
}

// Install the packaged protocol and deny renderer permissions before opening a window.
if (app.isPackaged && !app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  if (app.isPackaged) registerLocalProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  try { await startBundledBackend() }
  catch (error) {
    dialog.showErrorBox('AutoRush AITester', error.message)
    app.quit()
    return
  }
  createWindow()
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', stopBundledBackend)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
