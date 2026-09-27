// Pure-core tests for client placement admission and remote preview capability
// (AGENTS.md test policy). Run after `pnpm build:sdk`:
// node --test packages/client/src/placement.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admitPlacement, deviceCapability, previewCapability, sshPreviewForwardArgs } from '../dist/placement.js'
import { initialRemoteState, reduceRemote } from '../dist/remote-state.js'

const target = {
  hostId: 'devbox',
  profileId: 'p-1',
  destination: 'me@devbox.lan',
  remoteSocket: '/home/me/.ade/profiles/p-1/daemon.sock',
  hostPublicKey: null,
}
const remoteHost = { kind: 'remote', host_id: 'devbox' }
const local = { kind: 'local' }

function connected(forTarget = target) {
  let state = initialRemoteState(forTarget)
  for (const event of [
    { type: 'start' },
    { type: 'forward_ready' },
    {
      type: 'hello',
      hello: {
        type: 'hello',
        application_protocol: 'ade-application-v1',
        session_protocol: 'ade-sessions-v1',
        runtime_socket: '/home/me/.ade/profiles/p-1/runtime.sock',
        boot_id: 'b1',
        build_id: null,
      },
    },
  ]) {
    state = reduceRemote(state, event).state
  }
  assert.equal(state.phase, 'connected')
  return state
}

function lost() {
  return reduceRemote(connected(), { type: 'link_lost', detail: 'Socket closed.' }).state
}

function decision(host, admitted, reason = null) {
  return {
    type: 'placement_decision',
    host,
    resource: 'workspace',
    admitted,
    reason,
    requires_remote_transport: host.kind === 'remote',
  }
}

function entry(host, readiness = 'started') {
  return {
    host,
    label: 'x',
    readiness,
    reason: readiness === 'started' ? null : 'The pairing was revoked',
    capabilities: {
      resources: ['workspace'],
      previews: host.kind === 'local' ? 'direct' : 'ssh_forward',
      devices: host.kind === 'local' ? 'local_host' : 'unsupported',
    },
    remote_socket: null,
    remote_profile_id: null,
  }
}

test('a refused daemon decision stays refused for the host the caller named', () => {
  const result = admitPlacement(decision(remoteHost, false, 'devbox is not paired.'), connected(), target)
  assert.equal(result.admitted, false)
  assert.deepEqual(result.host, remoteHost)
  assert.match(result.reason, /not paired.*Nothing was sent to another host/)
})

test('a remote placement needs a connected transport to that same host', () => {
  assert.deepEqual(admitPlacement(decision(remoteHost, true), connected(), target), {
    admitted: true,
    host: remoteHost,
    via: 'remote_transport',
  })
  for (const [connection, forTarget, pattern] of [
    [null, null, /No remote transport/],
    [lost(), target, /state is unknown/],
    [initialRemoteState(target), target, /not connected \(idle\)/],
    [connected({ ...target, hostId: 'other' }), { ...target, hostId: 'other' }, /reaches other, not devbox/],
    [connected({ ...target, profileId: 'p-2' }), target, /different host or profile/],
  ]) {
    const result = admitPlacement(decision(remoteHost, true), connection, forTarget)
    assert.equal(result.admitted, false)
    assert.deepEqual(result.host, remoteHost)
    assert.match(result.reason, pattern)
  }
})

test('a local placement never runs through a remote transport', () => {
  assert.deepEqual(admitPlacement(decision(local, true), null, null), {
    admitted: true,
    host: local,
    via: 'local_daemon',
  })
  assert.equal(admitPlacement(decision(local, true), connected(), target).admitted, false)
})

test('a remote loopback preview is forwarded only while connected', () => {
  const ready = previewCapability(entry(remoteHost), 'http://localhost:5173/app', connected(), target)
  assert.equal(ready.available, true)
  assert.equal(ready.transport, 'ssh_forward')
  assert.equal(ready.remoteHost, '127.0.0.1')
  assert.equal(ready.remotePort, 5173)
  const https = previewCapability(entry(remoteHost), 'https://127.0.0.1', connected(), target)
  assert.equal(https.remotePort, 443)
  const v6 = previewCapability(entry(remoteHost), 'http://[::1]:8080', connected(), target)
  assert.equal(v6.remoteHost, '::1')
  const wildcard = previewCapability(entry(remoteHost), 'http://0.0.0.0:3000', connected(), target)
  assert.equal(wildcard.remoteHost, '127.0.0.1')

  const disconnected = previewCapability(entry(remoteHost), 'http://localhost:5173', lost(), target)
  assert.equal(disconnected.supported, true)
  assert.equal(disconnected.available, false)
  assert.match(disconnected.reason, /unknown/)
  const notStarted = previewCapability(entry(remoteHost, 'unavailable'), 'http://localhost:5173', connected(), target)
  assert.equal(notStarted.available, false)
  assert.match(notStarted.reason, /revoked/)
})

test('previews that cannot be forwarded say so', () => {
  for (const [url, pattern] of [
    ['http://db.internal:5432', /not devbox's own loopback/],
    ['http://10.0.0.5:3000', /not devbox's own loopback/],
    ['file:///etc/passwd', /Only http and https/],
    ['ws://localhost:3000', /Only http and https/],
    ['http://me:secret@localhost:3000', /credentials/],
    ['not a url', /not a valid URL/],
  ]) {
    const result = previewCapability(entry(remoteHost), url, connected(), target)
    assert.equal(result.supported, false, url)
    assert.equal(result.available, false)
    assert.equal(result.transport, 'none')
    assert.match(result.reason, pattern)
  }
  const localPreview = previewCapability(entry(local, 'ready'), 'http://localhost:3000', null, null)
  assert.equal(localPreview.transport, 'direct')
  assert.equal(localPreview.available, true)
})

test('remote device control is unsupported and never redirected locally', () => {
  const remote = deviceCapability(entry(remoteHost))
  assert.equal(remote.access, 'unsupported')
  assert.equal(remote.available, false)
  assert.match(remote.reason, /nothing is redirected to a device on this Mac/)
  const here = deviceCapability(entry(local, 'ready'))
  assert.equal(here.access, 'local_host')
  assert.equal(here.available, null)
  // A remote entry that claims local devices is still unsupported.
  const forged = { ...entry(remoteHost), capabilities: { ...entry(remoteHost).capabilities, devices: 'local_host' } }
  assert.equal(deviceCapability(forged).access, 'unsupported')
})

test('the preview forward binds loopback and reaches only the capability it was given', () => {
  const capability = previewCapability(entry(remoteHost), 'http://localhost:5173', connected(), target)
  const args = sshPreviewForwardArgs(target, capability, 41000, null)
  assert.deepEqual(args.slice(-4), ['-L', '127.0.0.1:41000:127.0.0.1:5173', '--', 'me@devbox.lan'])
  assert.ok(args.includes('StrictHostKeyChecking=yes') && args.includes('ForwardAgent=no'))
  const v6 = previewCapability(entry(remoteHost), 'http://[::1]:8080', connected(), target)
  assert.equal(sshPreviewForwardArgs(target, v6, 41001, null).at(-3), '127.0.0.1:41001:[::1]:8080')
  assert.throws(() => sshPreviewForwardArgs(target, capability, 80, null), /Local port/)
  assert.throws(() => sshPreviewForwardArgs({ ...target, hostId: 'other' }, capability, 41000, null), /different host/)
  const unavailable = previewCapability(entry(remoteHost), 'http://localhost:5173', lost(), target)
  assert.throws(() => sshPreviewForwardArgs(target, unavailable, 41000, null), /unknown/)
  // A host with a pinned key forwards previews under that key only.
  const key = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 1),
  ]).toString('base64')
  const pinned = { ...target, hostPublicKey: `ssh-ed25519 ${key}` }
  const pinnedCapability = previewCapability(entry(remoteHost), 'http://localhost:5173', connected(), pinned)
  const pinnedArgs = sshPreviewForwardArgs(pinned, pinnedCapability, 41000, '/tmp/ade-remote-1/known_hosts')
  assert.ok(pinnedArgs.includes('HostKeyAlias=ade-remote-devbox'))
  assert.ok(pinnedArgs.includes('UserKnownHostsFile=/tmp/ade-remote-1/known_hosts'))
  assert.ok(pinnedArgs.includes('GlobalKnownHostsFile=/dev/null'))
  assert.throws(() => sshPreviewForwardArgs(pinned, pinnedCapability, 41000, null), /known_hosts/)
})
