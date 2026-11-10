// Resolve console-owned copy from the saved UI language and the English catalogs.
export type UiLanguage = 'zh-CN' | 'en'
const storageKey = 'autorush-ui-language'

// Read the browser preference safely, including in restricted storage environments.
function readUiLanguage(): UiLanguage {
  try {
    return globalThis.localStorage?.getItem(storageKey) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export const uiLanguage = readUiLanguage()
const english: Readonly<Record<string, string>> = uiLanguage === 'en' ? (await import('./locales/en.ts')).default : {}

// Translate only the message template, leaving substituted values in their original language.
export function uiText(message: string, ...values: unknown[]): string {
  const template = uiLanguage === 'en' && Object.hasOwn(english, message) ? english[message] : message
  return values.length ? template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    return Number(index) < values.length ? String(values[Number(index)]) : placeholder
  }) : template
}

// Reload the current route so module-level labels also pick up the saved language.
export function switchUiLanguage(language: UiLanguage): void {
  if (language === uiLanguage) return
  localStorage.setItem(storageKey, language)
  window.location.reload()
}
