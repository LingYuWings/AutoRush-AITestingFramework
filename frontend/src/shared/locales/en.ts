// Collect the English UI catalogs into a chunk loaded only for English sessions.
import core from './en-core.ts'
import api from './en-api.ts'
import cases from './en-cases.ts'
import plans from './en-plans.ts'
import preferences from './en-preferences.ts'

export default { ...core, ...api, ...cases, ...plans, ...preferences }
