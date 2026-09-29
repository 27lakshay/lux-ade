// F083: public terminal commands are authenticated. The daemon socket and the
// runtime socket are owner-only files, and each accepted connection must come
// from the profile's user (peer credentials), or it is refused before any
// request is read. Behind the daemon, the runtime fences terminal commands and
// streams with the owning daemon's token.
//
// No second account exists on a test machine, so a debug build reads the user
// its sockets admit from a file named by ADE_E2E_{DAEMON,RUNTIME}_PEER_UID_FILE.
// Writing another UID there makes this test process a foreign peer.
import { rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, primaryShell, type ScratchProfile, test } from '../fixtures'
import { socketAccess, socketReply } from '../fixtures/sockets'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'

const me = process.getuid!()
const foreign = me + 1

async function authProfile(ade: {
  root: string
  profile: (options: { env: Record<string, string> }) => Promise<ScratchProfile>
}) {
  const daemonUid = join(ade.root, 'daemon-peer-uid')
  const runtimeUid = join(ade.root, 'runtime-peer-uid')
  const profile = await ade.profile({
    env: { ADE_E2E_DAEMON_PEER_UID_FILE: daemonUid, ADE_E2E_RUNTIME_PEER_UID_FILE: runtimeUid },
  })
  return {
    profile,
    /** Make this process a foreign peer of the daemon (`true`) or its owner again. */
    daemonForeign: (on: boolean) => (on ? writeFile(daemonUid, `${foreign}\n`) : rm(daemonUid, { force: true })),
    runtimeForeign: (on: boolean) => (on ? writeFile(runtimeUid, `${foreign}\n`) : rm(runtimeUid, { force: true })),
  }
}

/** The peer gets one refusal line and a closed socket; its request is never interpreted. */
function expectUnauthenticated(outcome: { frame: Record<string, unknown> | null; closed: boolean }) {
  expect(outcome.frame).toMatchObject({ type: 'error' })
  expect(String(outcome.frame!.message)).toMatch(/unauthenticated/)
}

test('both profile sockets are owner-only files of the profile user', async ({ ade }) => {
  const { profile } = await authProfile(ade)
  for (const path of [profile.socket, profile.runtimeSocket]) {
    expect(await socketAccess(path), path).toEqual({ mode: 0o600, uid: me, socket: true })
  }
})

test('the daemon refuses a peer that is not the profile user before any terminal command runs, and the terminal is untouched', async ({
  ade,
}) => {
  const { profile, daemonForeign } = await authProfile(ade)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const target = [workspace.id, shellId] as const
  const before = (await terminalMetrics(profile, ...target))!
  // Which terminals exist; their titles, status and busy state are live and may
  // still change while the primary shell starts under load.
  const terminalSet = async () =>
    (
      (await profile.cli('terminal', 'list')).json!.terminals as { id: string; kind: string; workspace_id: string }[]
    ).map(({ id, kind, workspace_id }) => ({ id, kind, workspace_id }))
  const listed = await terminalSet()

  await daemonForeign(true)
  try {
    // Raw protocol: the refusal is typed and nothing else is answered.
    const hello = await socketReply(profile.socket, { op: 'hello' })
    expect(hello.frame).toMatchObject({ type: 'error', code: 'unauthenticated' })
    // Every public terminal command fails through the CLI.
    for (const args of [
      ['terminal', 'create', workspace.id, '--request-id', 'foreign-create'],
      ['terminal', 'list'],
      ['terminal', 'send', ...target, 'echo "fo""reign-input"'],
      ['terminal', 'resize', ...target, '50', '12'],
      ['terminal', 'stop', ...target],
    ]) {
      const refused = await profile.cli(...args)
      expect(refused.code, `${args.join(' ')}: ${refused.stdout}`).not.toBe(0)
      expect(refused.stderr, args.join(' ')).toMatch(/unauthenticated/)
    }
    // Through the SDK.
    await expect(
      profile.call('terminal.create', { workspace_id: workspace.id, operation_id: 'foreign-sdk' }),
    ).rejects.toThrow(/unauthenticated/)
    await expect(profile.call('terminal.stop', { workspace_id: workspace.id, terminal_id: shellId })).rejects.toThrow(
      /unauthenticated/,
    )
    // A terminal stream gets no snapshot.
    const stream = TerminalStream.open(profile, ...target)
    await stream.waitForClose()
    expect(stream.frames.filter((frame) => frame.type === 'snapshot')).toEqual([])
    expect(stream.frames.map((frame) => frame.code)).toEqual(['unauthenticated'])
  } finally {
    await daemonForeign(false)
  }

  // The owner sees that nothing happened: no receipts, no new terminal, the
  // same running shell, no foreign input and the old size.
  for (const id of ['foreign-create', 'foreign-sdk']) {
    const receipt = await profile.cli('terminal', 'operation', workspace.id, id)
    expect(receipt.code, id).not.toBe(0)
  }
  expect(await terminalSet()).toEqual(listed)
  const after = (await terminalMetrics(profile, ...target))!
  expect(after).toMatchObject({ shell_running: true, shell_pid: before.shell_pid, run_id: before.run_id })
  const owner = TerminalStream.open(profile, ...target)
  const snapshot = await owner.snapshot()
  owner.send({ op: 'input', data: 'echo "own""er-$(stty size)"\n', run_id: snapshot.run_id })
  await owner.waitForText(/owner-30 100/)
  expect(owner.text()).not.toMatch(/foreign-input/)
  owner.close()

  // A restarted daemon authenticates its peers the same way.
  await profile.restartDaemon('kill')
  await daemonForeign(true)
  try {
    expect((await socketReply(profile.socket, { op: 'hello' })).frame).toMatchObject({ code: 'unauthenticated' })
  } finally {
    await daemonForeign(false)
  }
  expect((await socketReply(profile.socket, { op: 'hello' })).frame).toMatchObject({ type: 'hello' })
})

test('the runtime refuses a foreign peer outright, and fences a same-user peer that does not hold the owner token', async ({
  ade,
}) => {
  const { profile, runtimeForeign } = await authProfile(ade)
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const target = [workspace.id, shellId] as const
  const before = (await terminalMetrics(profile, ...target))!
  const runtime = await socketReply(profile.runtimeSocket, { op: 'hello' })
  const instance = runtime.frame!.instance_id as string
  const protocol = { runtime_protocol: 'x' }
  const claim = { op: 'owner.claim', token: randomUUID(), ticket: null, instance_id: instance, ...protocol }
  const connect = { op: 'terminal.connect', token: randomUUID(), workspace_id: workspace.id }
  const stop = { op: 'runtime.stop', instance_id: instance, stop_active: true }

  await runtimeForeign(true)
  try {
    for (const request of [{ op: 'hello' }, claim, connect, stop]) {
      expectUnauthenticated(await socketReply(profile.runtimeSocket, request))
    }
  } finally {
    await runtimeForeign(false)
  }

  // A same-user process that is not the owning daemon is fenced by the owner token.
  const sameUser = async (request: Record<string, unknown>) =>
    String((await socketReply(profile.runtimeSocket, request)).frame?.message)
  expect(await sameUser({ ...claim, runtime_protocol: runtime.frame!.runtime_protocol })).toMatch(
    /Another application daemon owns this runtime/,
  )
  expect(await sameUser(connect)).toMatch(/stale or draining owner/)
  expect(await sameUser(stop)).toMatch(/Disconnect the application daemon/)

  // The runtime and its shell are untouched, and the daemon still drives the terminal.
  expect((await socketReply(profile.runtimeSocket, { op: 'hello' })).frame).toMatchObject({ instance_id: instance })
  expect((await terminalMetrics(profile, ...target))!).toMatchObject({
    shell_running: true,
    shell_pid: before.shell_pid,
    run_id: before.run_id,
  })
  const sent = await profile.cli('terminal', 'send', ...target, 'echo "still-""owned"')
  expect(sent.code, sent.stderr).toBe(0)
  const stream = TerminalStream.open(profile, ...target)
  await stream.snapshot()
  await stream.waitForText(/still-owned/)
  stream.close()
})
