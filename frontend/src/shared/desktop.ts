// Detect the Electron desktop shell and share appearance with it; in a normal browser this is inert.
import { uiLanguage } from './i18n.ts'

type DesktopBridge = {
  platform: string
  version: string
  backendPort: string
  chooseSettingsPath(kind: 'directory' | 'file' | 'database'): Promise<string | null>
  setPreferences(preferences: { theme: 'light' | 'dark'; language: 'zh-CN' | 'en' }): void
}

export const desktop: DesktopBridge | null = (globalThis as { autorushDesktop?: DesktopBridge }).autorushDesktop ?? null

// Mark the document so styles can follow desktop conventions (caption-button space, arrow cursor, drag regions).
if (desktop && typeof document !== 'undefined') document.documentElement.dataset.desktop = desktop.platform

// Tell the shell which theme is showing so the native caption buttons and window background match it.
export function syncDesktopTheme(theme: 'light' | 'dark'): void {
  desktop?.setPreferences({ theme, language: uiLanguage })
}
