import { call, type CallRequest, type DailyUseOperation, type DailyUseResponse } from '@ade/client'
import { getClient, getSocket, isSwitching } from './profile-connection'

/**
 * One operation on the active profile's daemon, its request and reply checked against the contract
 * by the SDK. An effect command without an operation ID gets a fresh one.
 */
export function daemonCall<O extends DailyUseOperation>(op: O, request: CallRequest<O>): Promise<DailyUseResponse<O>> {
  const endpoint = getSocket()
  if (!endpoint || isSwitching() || getClient().getState().status !== 'connected')
    return Promise.reject(new Error('Profile daemon is unavailable'))
  return call(endpoint, op, request)
}
