// Shared steps for the device specs: start a profile on a fixture device
// host, read its inventory, and send requests whose error frames the spec
// asserts.
import type { AdeHarness, ScratchProfile } from '../fixtures'
import { DeviceHost, sampleState, type DeviceHostState } from '../fixtures/devices'
import { rawReply, type ReplyFrame } from '../fixtures/raw-reply'

export type Inventory = {
  type: 'device_inventory'
  host: { host_id: string; host_name: string; platform: string }
  families: Array<{
    family: string
    available: boolean
    reasons: Reason[]
    tools: string[]
    permissions: Array<{ permission: string; state: string; subject: string }>
  }>
  devices: Device[]
}
export type Reason = { code: string; detail: string }
export type Device = {
  device_id: string
  family: string
  kind: string
  name: string
  state: string
  runtime: string | null
  serial: string | null
  capabilities: Array<{ capability: string; available: boolean; reason: Reason | null }>
}

/** A fixture device host and one profile that uses it. */
export async function deviceProfile(
  ade: AdeHarness,
  state: DeviceHostState = sampleState(),
  tools: { android?: boolean } = {},
): Promise<{ host: DeviceHost; profile: ScratchProfile }> {
  const host = await DeviceHost.create(ade.root, state, tools)
  const profile = await ade.profile({ env: host.env() })
  return { host, profile }
}

export async function inventory(profile: ScratchProfile, family?: string): Promise<Inventory> {
  return (await profile.rpc({ op: 'device.list', ...(family ? { family } : {}) }, 60_000)) as unknown as Inventory
}

export async function hostId(profile: ScratchProfile): Promise<string> {
  return (await inventory(profile, 'ios_simulator')).host.host_id
}

export function device(list: Inventory, deviceId: string): Device {
  const found = list.devices.find((entry) => entry.device_id === deviceId)
  if (!found)
    throw new Error(`${deviceId} is not in the inventory: ${list.devices.map((entry) => entry.device_id).join(', ')}`)
  return found
}

export function capability(entry: Device, name: string): { available: boolean; reason: Reason | null } {
  const found = entry.capabilities.find((status) => status.capability === name)
  if (!found) throw new Error(`${entry.device_id} has no ${name} capability`)
  return found
}

export function family(list: Inventory, name: string): Inventory['families'][number] {
  const found = list.families.find((entry) => entry.family === name)
  if (!found) throw new Error(`The inventory has no ${name} family`)
  return found
}

/** One request; resolves with the reply frame, error frames included. */
export function send(
  profile: ScratchProfile,
  request: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<ReplyFrame> {
  return rawReply(profile, request, timeoutMs)
}

export const boot = (host: string, deviceId: string, operationId: string, extra: Record<string, unknown> = {}) => ({
  op: 'device.boot',
  operation_id: operationId,
  host_id: host,
  device_id: deviceId,
  ...extra,
})
export const install = (host: string, deviceId: string, operationId: string, appPath: string) => ({
  op: 'device.app.install',
  operation_id: operationId,
  host_id: host,
  device_id: deviceId,
  app_path: appPath,
})
export const launch = (host: string, deviceId: string, operationId: string, appId: string) => ({
  op: 'device.app.launch',
  operation_id: operationId,
  host_id: host,
  device_id: deviceId,
  app_id: appId,
})

/**
 * After an unknown outcome the device claim stays quarantined, refusing even
 * this profile. The caller has inspected the device; release the claim.
 */
export async function resolveQuarantine(profile: ScratchProfile, deviceId: string, operationId: string): Promise<void> {
  const claims = (await profile.call('resources.inspect', { resource: 'device' })).claims.filter(
    (claim) => claim.device_id === deviceId && claim.state === 'quarantined',
  )
  if (claims.length !== 1) throw new Error(`Expected one quarantined claim on ${deviceId}, found ${claims.length}`)
  await profile.call('resources.claim.resolve', {
    operation_id: operationId,
    claim_id: claims[0].id,
    confirm_path: claims[0].path,
  })
}
