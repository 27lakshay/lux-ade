// Steps the remote specs share: register, pair and start a remote host through
// the local profile daemon, and name the SDK transport target for it.
import { expect, pairingTokenEnv, type RemoteHost, type RemoteLab, type RemoteTarget } from '../fixtures/remote-hosts'
import type { ScratchProfile } from '../fixtures'

let operations = 0
export function operationId(label: string): string {
  return `e2e-remote-${label}-${process.pid}-${++operations}`
}

/** Register `host` under `hostId` by pinning its current key's fingerprint, then pair it. */
export async function addAndPair(profile: ScratchProfile, host: RemoteHost, hostId: string,
  options: { remoteProfileId?: string; label?: string } = {}) {
  const added = await profile.call('remote.host.add', { host_id: hostId, ssh_target: host.name,
    expected_fingerprint: host.hostKey.fingerprint, ...(options.label ? { label: options.label } : {}),
    ...(options.remoteProfileId ? { remote_profile_id: options.remoteProfileId } : {}) })
  // The lab profile holds the token in this variable; a start grants it on the host.
  const paired = await profile.call('remote.host.pair', { host_id: hostId,
    token_reference: { env: pairingTokenEnv } })
  expect(paired.pairing.state).toBe('active')
  return { host: added.host, pairing: paired.pairing }
}

/** Start or attach the remote profile daemon through the local daemon; expects `running`. */
export async function startRunning(profile: ScratchProfile, hostId: string, id = operationId('start')) {
  const started = await profile.call('remote.host.start', { host_id: hostId, operation_id: id }, { timeoutMs: 120_000 })
  expect(started, started.detail ?? '').toMatchObject({ outcome: 'running', host_id: hostId })
  return started
}

/** A remote host with a created remote profile, registered, paired and started. */
export async function startedHost(remote: RemoteLab, profile: ScratchProfile, name: string, hostId = name) {
  const host = await remote.host(name)
  const remoteProfileId = await host.createProfile()
  const { host: registered, pairing } = await addAndPair(profile, host, hostId, { remoteProfileId })
  const started = await startRunning(profile, hostId)
  return { host, hostId, remoteProfileId, registered, pairing, started, daemon: started.daemon! }
}

/** The SDK transport target for a started host: the registry's SSH target and pinned key, the started socket. */
export function targetOf(started: Awaited<ReturnType<typeof startedHost>>): RemoteTarget {
  return { hostId: started.hostId, profileId: started.remoteProfileId, destination: started.registered.ssh_target,
    remoteSocket: started.daemon.socket, hostPublicKey: started.registered.host_public_key }
}
