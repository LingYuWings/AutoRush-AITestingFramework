import type {CaseRecord,DriverKind} from '../../shared/api'
export type CasePlatform=DriverKind|'mixed'
export const platformLabels:Record<CasePlatform,string>={web:'Web',android:'Android',desktop:'Desktop',api:'API 辅助',mixed:'历史混合'}
export function platformOf(item:Pick<CaseRecord,'platform'|'steps'|'postconditions'>):CasePlatform {
  if(item.platform)return item.platform
  const drivers=new Set([...item.steps,...item.postconditions].map(s=>s.driver))
  return drivers.size===1?[...drivers][0]:'mixed'
}
export function filterCases(cases:CaseRecord[],filter:{platform:CasePlatform|'all';status:string;query:string;archived:boolean}):CaseRecord[] {
  const query=filter.query.trim().toLocaleLowerCase()
  return cases.filter(c=>Boolean(c.archived_at)===filter.archived&&(filter.platform==='all'||platformOf(c)===filter.platform)
    &&(filter.status==='all'||c.status===filter.status)&&[c.title,c.description,c.id].join(' ').toLocaleLowerCase().includes(query))
}
