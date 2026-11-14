// Expose the smallest desktop bridge the console needs: platform facts and appearance preferences.
const { contextBridge, ipcRenderer } = require('electron')

// Read a value passed by the main process through webPreferences.additionalArguments.
function argument(name) {
  const prefix = `--autorush-${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? ''
}

contextBridge.exposeInMainWorld('autorushDesktop', Object.freeze({
  platform: process.platform,
  version: argument('version'),
  backendPort: argument('backend-port'),
  // Open a native dialog for a single settings path.
  chooseSettingsPath(kind) { return ipcRenderer.invoke('desktop:choose-settings-path', kind) },
  // Report the console theme and language so native chrome (caption buttons, splash, menus) can match.
  setPreferences(preferences) {
    const theme = preferences?.theme === 'dark' ? 'dark' : 'light'
    const language = preferences?.language === 'en' ? 'en' : 'zh-CN'
    ipcRenderer.send('desktop:preferences', { theme, language })
  },
}))
