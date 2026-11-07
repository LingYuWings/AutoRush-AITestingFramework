import {apiTesting} from './client'

// Fetch the API workspace's reference data concurrently.
export async function loadApiResources(){
  const [requests,collections,environments,history,capabilities,folders]=await Promise.all([
    apiTesting.requests(),apiTesting.collections(),apiTesting.environments(),apiTesting.history(),apiTesting.capabilities(),apiTesting.folders()
  ])
  return {requests,collections,environments,history,capabilities,folders}
}
export type ApiResources=Awaited<ReturnType<typeof loadApiResources>>
