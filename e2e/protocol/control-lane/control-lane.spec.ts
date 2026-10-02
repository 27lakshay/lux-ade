// R004: the control lane (architecture section 4: "Reserve capacity for
// cancellation, health, settlement and shutdown"). Each profile daemon listens
// on a second owner-only socket beside its profile socket. It serves only
// hello, health, agent.cancel, terminal.stop, service.stop and
// runtime.prepare_restart, and authenticates peers as the profile socket does.
// @ade/client sends those operations there, and falls back to the profile
// socket only when the control lane is absent, as with an older daemon. A
// connection flood past the profile socket's listen backlog (128 on macOS)
// therefore cannot refuse a stop of existing work.
import { rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  cancellationIntent,
  expect,
  isRunning,
  primaryShell,
  prompts,
  type ScratchProfile,
  send,
  startConversation,
  test,
} from '../fixtures'
import { socketAccess, socketReply } from '../fixtures/sockets'
import {
  configureService,
  nodeService,
  serviceState,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'
import { settledExit, terminalMetrics } from '../fixtures/terminals'
import { connectOutcome, expectNoneLost, fillBacklog, REFUSED_AT_SOCKET } from './backlog'

const me = process.getuid!()

function controlSocket(profile: ScratchProfile): string {
  return profile.socket.replace(/\.sock$/, '.control.sock')
}

async function runningTurn(profile: ScratchProfile, conversationId: string): Promise<string> {
  await send(profile, conversationId, prompts.hold)
  let turn: string | null = null
  await expect
    .poll(
      async () => {
        const current = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
        turn = current.status === 'running' ? (current.active_turn_id ?? null) : null
        return turn
      },
      { timeout: 20_000 },
    )
    .not.toBeNull()
  return turn!
}

/** A call's reply or error, held without an unhandled rejection while the spec acts. */
function outcome<T>(call: Promise<T>): Promise<{ reply?: T; error?: unknown }> {
  return call.then(
    (reply) => ({ reply }),
    (error: unknown) => ({ error }),
  )
}

async function interrupts(profile: ScratchProfile): Promise<Array<string | undefined>> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/interrupt')
    .map((call) => (call.params as { turnId?: string }).turnId)
}

test('the control lane is an owner-only socket beside the profile socket that answers hello and health', async ({
  profile,
}) => {
  expect(await socketAccess(controlSocket(profile))).toEqual({ mode: 0o600, uid: me, socket: true })
  const hello = await socketReply(controlSocket(profile), { op: 'hello' })
  expect(hello.frame).toMatchObject({ type: 'hello', pid: profile.hello.pid, boot_id: profile.hello.boot_id })
  const status = await socketReply(controlSocket(profile), { op: 'runtime.status' })
  expect(status.frame).toMatchObject({ type: 'runtime_status' })
  const diagnostics = await socketReply(controlSocket(profile), { op: 'diagnostics.status' })
  expect(diagnostics.frame?.type).not.toBe('error')
})

test('the control lane refuses ordinary commands before admission and nothing runs', async ({ profile }) => {
  const { conversationId, workspaceId } = await startConversation(profile, 'codex')
  const before = (await profile.call('catalog.get', {})).catalog.conversations.length
  for (const request of [
    { op: 'conversation.create', workspace_id: workspaceId, provider: 'codex', title: 'over the control lane' },
    { op: 'agent.send', conversation_id: conversationId, request_id: 'control-send', text: prompts.turn },
    { op: 'terminal.create', workspace_id: workspaceId, operation_id: 'control-create' },
    { op: 'session.subscribe' },
    // A raw terminal protocol line, which the profile socket forwards to the runtime.
    { op: 'subscribe', snapshot_format: 'xterm-replay-v1' },
  ]) {
    const refused = await socketReply(controlSocket(profile), request)
    expect(refused.frame, request.op).toMatchObject({
      type: 'error',
      code: 'invalid_request',
      pre_admission_rejected: true,
    })
    expect(String(refused.frame!.message)).toContain(`${request.op} is not served on the control lane`)
  }
  expect((await profile.call('catalog.get', {})).catalog.conversations).toHaveLength(before)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toEqual([])
})

test('the control lane refuses a peer that is not the profile user, through the raw protocol, the SDK and the CLI', async ({
  ade,
}) => {
  const peerUid = join(ade.root, 'daemon-peer-uid')
  const profile = await ade.profile({ env: { ADE_E2E_DAEMON_PEER_UID_FILE: peerUid } })
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, conversationId)
  const cancellation = await cancellationIntent(profile, conversationId, turn)
  await writeFile(peerUid, String(me + 1) + '\n')
  try {
    const hello = await socketReply(controlSocket(profile), { op: 'hello' })
    expect(hello.frame).toMatchObject({ type: 'error', code: 'unauthenticated' })
    // The refusal is a reply, so the SDK does not fall back to the profile socket.
    await expect(profile.call('agent.cancel', cancellation)).rejects.toMatchObject({
      code: 'unauthenticated',
      delivery: 'not_sent',
      replied: true,
    })
    const cli = await profile.cli('conversation', 'cancel', conversationId, '--turn', turn)
    expect(cli.code).not.toBe(0)
    expect(cli.stderr).toMatch(/unauthenticated/)
    expect(await interrupts(profile)).toEqual([])
  } finally {
    await rm(peerUid, { force: true })
  }
  await profile.call('agent.cancel', cancellation)
  await expect.poll(() => interrupts(profile)).toEqual([turn])
})

test('a cancel sent while a connection flood fills the profile socket backlog is admitted on its first attempt', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, conversationId)
  const cancellation = await cancellationIntent(profile, conversationId, turn)
  const full = await fillBacklog(profile, conversationId)
  // refuses connections after the cancel has connected to the control lane.
  const cancelled = outcome(profile.call('agent.cancel', cancellation))
  try {
    expect(await connectOutcome(profile.socket)).toBe('ECONNREFUSED')
  } finally {
    full.resume()
  }
  expect(await cancelled).toMatchObject({ reply: { type: 'agent_cancel_outcome' } })
  await expect.poll(() => interrupts(profile)).toEqual([turn])
  const replies = await full.replies
  expectNoneLost(replies)
  expect(replies.filter((reply) => REFUSED_AT_SOCKET.test(reply)).length).toBeGreaterThan(0)
  await expect
    .poll(
      async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status,
      { timeout: 30_000 },
    )
    .toBe('interrupted')
})

test('without the control lane, the same full backlog refuses the cancel before it is sent', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const turn = await runningTurn(profile, conversationId)
  const cancellation = await cancellationIntent(profile, conversationId, turn)
  await rm(controlSocket(profile))
  const full = await fillBacklog(profile, conversationId)
  try {
    // The daemon stays paused until the cancel settles, so its fallback
    // connection meets the full backlog however late it is made.
    const cancelled = await outcome(profile.call('agent.cancel', cancellation, { timeoutMs: 10_000 }))
    // The refusal is truthful: nothing was sent, so a retry is safe.
    expect(cancelled).toMatchObject({ error: { code: 'unavailable', delivery: 'not_sent', replied: false } })
  } finally {
    full.resume()
  }
  expectNoneLost(await full.replies)
  expect(await interrupts(profile)).toEqual([])
  await profile.call('agent.cancel', cancellation)
  await expect.poll(() => interrupts(profile)).toEqual([turn])
})

test('terminal.stop and service.stop sent while a connection flood fills the profile socket backlog are admitted on their first attempt', async ({
  profile,
  repo,
}) => {
  test.setTimeout(90_000)
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  const serviceShell = (started.metrics as { shell_pid: number }).shell_pid
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  const shell = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace
  const shellId = await primaryShell(profile, shell.id)
  let shellPid: number | null = null
  await expect
    .poll(async () => (shellPid = (await terminalMetrics(profile, shell.id, shellId))?.shell_pid ?? null))
    .not.toBeNull()

  const full = await fillBacklog(profile, conversationId)
  const stops = Promise.all([
    profile.call('terminal.stop', { workspace_id: shell.id, terminal_id: shellId }),
    profile.call('service.stop', { workspace_id: workspace.id, name: 'web' }),
  ])
  stops.catch(() => undefined)
  try {
    expect(await connectOutcome(profile.socket)).toBe('ECONNREFUSED')
  } finally {
    full.resume()
  }
  const [terminal, service] = await stops
  expectNoneLost(await full.replies)
  expect(terminal.type).toBe('ack')
  expect(service.service.terminal_owner).toBeNull()
  await settledExit(profile, shell.id, shellId)
  expect(await isRunning(shellPid!)).toBe(false)
  expect(await isRunning(serviceShell)).toBe(false)
  expect(await serviceState(profile, workspace.id, 'web')).toBe('stopped')
})

test('without a control lane, as with an older daemon, the SDK and the CLI stop work over the profile socket', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  // Remove the lane's socket file: the daemon keeps serving its profile socket only.
  await rm(controlSocket(profile))
  const turn = await runningTurn(profile, conversationId)
  const cancellation = await cancellationIntent(profile, conversationId, turn)
  const cli = await profile.cli('conversation', 'cancel', conversationId, '--turn', turn)
  expect(cli.code, cli.stderr).toBe(0)
  await expect.poll(() => interrupts(profile)).toEqual([turn])
  // A daemon refusal over the profile socket arrives as its reply.
  await expect(profile.call('agent.cancel', { ...cancellation, turn_id: 'turn-not-this-one' })).rejects.toMatchObject({
    replied: true,
    message: expect.stringMatching(/no longer active/),
  })
})

test('shutdown over the control lane hands the runtime over and removes both sockets', async ({ profile }) => {
  const daemonPid = profile.hello.pid
  const runtimePid = profile.hello.runtime_pid
  const prepared = await socketReply(controlSocket(profile), {
    op: 'runtime.prepare_restart',
    operation_id: `restart-${randomUUID()}`,
    boot_id: profile.hello.boot_id,
  })
  expect(prepared.frame).toMatchObject({ type: 'ack', boot_id: profile.hello.boot_id })
  await expect.poll(() => isRunning(daemonPid)).toBe(false)
  await expect(socketAccess(controlSocket(profile))).rejects.toThrow(/ENOENT/)
  await expect(socketAccess(profile.socket)).rejects.toThrow(/ENOENT/)
  // The next daemon adopts the same runtime and opens a new control lane.
  const next = await profile.restartDaemon()
  expect(next.runtime_pid).toBe(runtimePid)
  expect((await socketReply(controlSocket(profile), { op: 'hello' })).frame).toMatchObject({
    type: 'hello',
    pid: next.pid,
  })
})
