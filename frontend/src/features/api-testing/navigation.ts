// Share API workspace labels with the shell without loading request editors.
import { uiText } from '../../shared/i18n.ts'

export const apiSections = [
  ['workbench', uiText('请求工作台')],
  ['runner', uiText('集合 Runner')],
  ['environments', uiText('环境管理')],
  ['history', uiText('执行历史')],
] as const

export type ApiNavigationGuard = ((proceed: () => void) => void) | null
