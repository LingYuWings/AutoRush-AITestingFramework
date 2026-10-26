const { app, BrowserWindow, protocol, session, shell } = require('electron')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

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
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src http://127.0.0.1:8000 ws://127.0.0.1:8000; object-src 'none'; base-uri 'none'; frame-src 'none'",
        },
      })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

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
  if (app.isPackaged) window.loadURL('app://autorush/index.html')
  else window.loadURL('http://127.0.0.1:5173')
}

app.whenReady().then(() => {
  if (app.isPackaged) registerLocalProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
