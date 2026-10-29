import {apiTesting} from './client'

export async function loadApiResources(){
  const [requests,collections,environments,history,capabilities,folders]=await Promise.all([
    apiTesting.requests(),apiTesting.collections(),apiTesting.environments(),apiTesting.history(),apiTesting.capabilities(),apiTesting.folders()
  ])
  return {requests,collections,environments,history,capabilities,folders}
}
export type ApiResources=Awaited<ReturnType<typeof loadApiResources>>
