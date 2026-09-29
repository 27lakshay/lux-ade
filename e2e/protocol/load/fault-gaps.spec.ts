// F140: faults of architecture section 12 that no other area's test injected.
// Each test names its class; `load/fault-classes.spec.ts` checks that the
// fault suite runs them.
//
// - Class 2: a cancel sent as a snooze wake falls due.
// - Class 5: concurrent credential verifications, and a sign-out or a
//   disable during one. ADE does not refresh provider tokens itself (each
//   provider CLI refreshes its own home); verification is where ADE reads
//   and pins credentials, so it is where a refresh can race.
// - Class 8: a browser owner that disconnects.
// - Class 9: an older client, and a daemon of an older runtime protocol.
import { chmod, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, primaryShell, prompts, type ScratchProfile, send, startConversation, test } from '../fixtures'
import { ownerStorageProfile, fixedBrowserProfile } from '../fixtures/browser-owner'
import { rawReply } from '../fixtures/raw-reply'
import { socketReply } from '../fixtures/sockets'
import { clientSdk, TerminalStream, terminalMetrics } from '../fixtures/terminals'
import { profileWithClis } from '../providers/steps'

async function conversation(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
}

/** A Unix socket server in the test's scratch root that answers each line with `answer` and records it. */
async function lineServer(
  profile: ScratchProfile,
  name: string,
  answer: (request: Record<string, unknown>) => Record<string, unknown>,
) {
  const directory = join(profile.root, name)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 's.sock')
  const received: Array<Record<string, unknown>> = []
  const server: Server = createServer((peer) => {
    let buffered = ''
    peer.on('error', () => undefined)
    peer.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const request = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>
        buffered = buffered.slice(end + 1)
        received.push(request)
        peer.write(`${JSON.stringify(answer(request))}\n`)
      }
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(path, () => resolveListen())
  })
  server.unref()
  await chmod(path, 0o600)
  return { path, received, close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) }
}

test('fault class 2: a cancel sent as a snooze falls due stops only the running turn, and the wake is recorded once with no new work', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect.poll(async () => (await conversation(profile, conversationId)).status).toBe('running')
  const turn = (await conversation(profile, conversationId)).active_turn_id!
  const starts = async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
  const startsBefore = await starts()

  const until = Date.now() + 1_000
  await profile.call('conversation.snooze', { conversation_id: conversationId, until })
  await expect.poll(() => Date.now(), { timeout: 5_000 }).toBeGreaterThanOrEqual(until)
  // The cancel and the wake are processed at the same moment.
  await profile.call('agent.cancel', { conversation_id: conversationId, turn_id: turn })

  await expect
    .poll(async () => (await conversation(profile, conversationId)).status, { timeout: 20_000 })
    .toBe('interrupted')
  const wakes = async () =>
    (await profile.call('activity.list', { limit: 200 })).activities.filter(
      (activity) => activity.kind === 'snooze_ended' && activity.target.conversation_id === conversationId,
    )
  await expect.poll(async () => (await wakes()).length, { timeout: 10_000 }).toBe(1)
  expect((await profile.call('conversation.controls', { conversation_id: conversationId })).snooze).toBeNull()
  // Only the turn the cancel named was interrupted; the wake started nothing and queued nothing.
  const interrupts = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/interrupt')
  expect(interrupts.map((call) => (call.params as { turnId?: string }).turnId)).toEqual([turn])
  expect(await starts()).toBe(startsBefore)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).queued).toEqual([])
  // A restart records no second wake and runs no second cancel.
  await profile.restartDaemon('kill')
  expect(await wakes()).toHaveLength(1)
  expect((await conversation(profile, conversationId)).status).toBe('interrupted')
})

test('fault class 5: concurrent verifications of one account converge, and a sign-out or a disable racing a verification never leaves it verified', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const identity = { email: 'work@example.invalid', account_id: 'org-work' }
  const { account } = await profile.call('account.create', { provider: 'codex', name: 'Work' })
  await clis.signIn('codex', account.native_home, identity)
  type Inspection = { generation: number; inspection: { state: string; reason: string; identity?: unknown } }
  const inspect = async (): Promise<Inspection> => {
    let inspected: Inspection | undefined
    await expect(async () => {
      inspected = await profile.call('account.inspect', { account_id: account.id })
      expect(inspected.inspection.state, inspected.inspection.reason).toBe('ready')
    }).toPass({ timeout: 20_000 })
    return inspected!
  }
  const verify = (inspected: Inspection) =>
    profile.call('account.verify', {
      account_id: account.id,
      expected_generation: inspected.generation,
      expected_identity: inspected.inspection.identity,
    })
  const current = async () =>
    (await profile.call('account.list', {})).accounts.find((entry) => entry.id === account.id)!

  // Five verifications at once, while the CLI rewrites the same credentials as a token refresh would.
  const first = await inspect()
  const [refreshed, ...verified] = await Promise.allSettled([
    clis.signIn('codex', account.native_home, identity),
    ...Array.from({ length: 5 }, () => verify(first)),
  ])
  expect(refreshed.status).toBe('fulfilled')
  // A verification may see the credential file mid-rewrite and refuse; none may pin anything else.
  const accepted = verified.filter((outcome) => outcome.status === 'fulfilled')
  for (const outcome of verified) {
    if (outcome.status === 'rejected')
      expect(String(outcome.reason)).toMatch(/not ready|identity|changed|retry|unavailable/i)
  }
  if (accepted.length === 0) await verify(await inspect())
  expect(await current()).toMatchObject({
    state: 'verified',
    generation: first.generation,
    codex_identity: first.inspection.identity,
  })

  // A sign-out between inspection and verification: the verification is refused, and readiness says so.
  const beforeSignOut = await inspect()
  await clis.invalidateCredentials('codex', account.native_home)
  await expect(verify(beforeSignOut)).rejects.toThrow(/not ready/i)
  await expect
    .poll(async () => (await profile.call('provider.readiness', { provider: 'codex', account_id: account.id })).state, {
      timeout: 20_000,
    })
    .toBe('needs_authentication')

  // A disable racing three verifications: whatever order they commit in, the account ends disabled.
  await clis.signIn('codex', account.native_home, identity)
  const beforeDisable = await inspect()
  const raced = await Promise.allSettled([
    verify(beforeDisable),
    verify(beforeDisable),
    profile.call('account.disable', { account_id: account.id }),
    verify(beforeDisable),
  ])
  expect(raced[2].status).toBe('fulfilled')
  for (const outcome of raced) {
    if (outcome.status === 'rejected')
      expect(String(outcome.reason)).toMatch(/changed during verification|not ready|disabled|retry/i)
  }
  const disabled = await current()
  expect(disabled).toMatchObject({ state: 'disabled', generation: beforeDisable.generation + 1 })
  expect(disabled.codex_identity ?? null).toBeNull()
  // A verification from before the disable is refused afterwards, also after a daemon crash.
  await expect(verify(beforeDisable)).rejects.toThrow(/changed during verification/)
  await profile.restartDaemon('kill')
  await expect(verify(beforeDisable)).rejects.toThrow(/changed during verification/)
  expect(await current()).toMatchObject({ state: 'disabled' })
  expect((await profile.call('provider.readiness', { provider: 'codex', account_id: account.id })).state).toBe(
    'account_disabled',
  )
})

test('fault class 8: a browser owner that disconnects is reported unavailable, and its requests are never replaced by another owner', async ({
  profile,
}) => {
  const profileId = fixedBrowserProfile(profile.socket)
  const storage = ownerStorageProfile(profileId)
  const answer = (ownerId: string) => (command: Record<string, unknown>) => ({
    type: 'browser_tabs',
    profile_id: command.profile_id,
    owner_id: command.owner_id,
    profileId: storage,
    selectedId: `${ownerId}-tab`,
    tabs: [
      {
        id: `${ownerId}-tab`,
        profileId: storage,
        requestedUrl: 'https://example.invalid/',
        observedUrl: 'https://example.invalid/',
        title: ownerId,
        loading: false,
        error: '',
      },
    ],
  })
  const first = await lineServer(profile, 'b1', answer('first'))
  expect(
    await profile.rpc({
      op: 'browser.owner.register',
      profile_id: profileId,
      owner_id: 'first',
      socket_path: first.path,
    }),
  ).toMatchObject({ type: 'browser_owner', owner_id: 'first' })
  const list = (ownerId: string) => rawReply(profile, { op: 'browser.list', profile_id: profileId, owner_id: ownerId })
  expect(await list('first')).toMatchObject({ type: 'browser_tabs', tabs: [{ id: 'first-tab' }] })

  // The owner's process goes away without unregistering, as a crashed Electron main would.
  await first.close()
  const gone = await list('first')
  expect(gone).toMatchObject({ type: 'error' })
  expect(gone.tabs).toBeUndefined()

  // A new owner may register once the old one is gone, but a request naming the old owner is never sent to it.
  const second = await lineServer(profile, 'b2', answer('second'))
  expect(
    await profile.rpc({
      op: 'browser.owner.register',
      profile_id: profileId,
      owner_id: 'second',
      socket_path: second.path,
    }),
  ).toMatchObject({ type: 'browser_owner', owner_id: 'second' })
  const stale = await list('first')
  expect(stale).toMatchObject({ type: 'error' })
  expect(second.received.filter((request) => request.op === 'browser.list')).toEqual([])
  expect(await list('second')).toMatchObject({ type: 'browser_tabs', owner_id: 'second', tabs: [{ id: 'second-tab' }] })

  // While the new owner is live, the old one cannot take the profile back.
  const revived = await lineServer(profile, 'b3', answer('first'))
  expect(
    await rawReply(profile, {
      op: 'browser.owner.register',
      profile_id: profileId,
      owner_id: 'first',
      socket_path: revived.path,
    }),
  ).toMatchObject({ type: 'error', code: 'conflict' })
  expect(revived.received).toEqual([])
  await second.close()
  await revived.close()
})

test('fault class 9: a client refuses a daemon of another application protocol before it sends anything', async ({
  profile,
}) => {
  const current = await profile.rpc({ op: 'hello' })
  // A daemon from an older release answers hello with its own protocols.
  const older = await lineServer(profile, 'old', (request) =>
    request.op === 'hello'
      ? { ...current, application_protocol: 'ade-application-v0', session_protocol: 'ade-sessions-v0' }
      : { type: 'error', message: 'unexpected request' },
  )
  const { call, DaemonRequestError } = await clientSdk()
  const refused = await call(older.path, 'catalog.get', {}).then(
    () => null,
    (error: unknown) => error,
  )
  expect(refused).toBeInstanceOf(DaemonRequestError)
  expect(refused).toMatchObject({ code: 'incompatible', delivery: 'not_sent' })
  // Only the hello reached it; the operation was never sent.
  expect(older.received).toEqual([{ op: 'hello' }])
  // The same client works against the current daemon.
  expect(await call(profile.socket, 'catalog.get', {})).toMatchObject({ type: 'catalog' })
  await older.close()
})

test('fault class 9: a daemon of an older runtime protocol cannot claim the live runtime, which keeps its work for a compatible daemon', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)
  const target = [workspace.id, shellId] as const
  const before = (await terminalMetrics(profile, ...target))!
  const runtime = (await socketReply(profile.runtimeSocket, { op: 'hello' })).frame!
  const instance = runtime.instance_id as string
  const { runtime_pid: runtimePid, runtime_instance: runtimeInstance } = profile.hello

  // The daemon dies; the runtime has no owner.
  await profile.killDaemon()
  const claim = (protocol: string) =>
    socketReply(profile.runtimeSocket, {
      op: 'owner.claim',
      token: randomUUID(),
      ticket: null,
      instance_id: instance,
      runtime_protocol: protocol,
    })
  for (const older of ['ade-runtime-v7', 'ade-runtime-v1']) {
    expect((await claim(older)).frame?.message).toMatch(/Incompatible runtime protocol/)
  }
  expect((await socketReply(profile.runtimeSocket, { op: 'hello' })).frame).toMatchObject({
    instance_id: instance,
    runtime_protocol: runtime.runtime_protocol,
  })

  // A compatible daemon adopts the same runtime, and the shell kept running.
  const hello = await profile.restartDaemon()
  expect(hello).toMatchObject({ runtime_pid: runtimePid, runtime_instance: runtimeInstance })
  expect((await terminalMetrics(profile, ...target))!).toMatchObject({
    shell_running: true,
    shell_pid: before.shell_pid,
    run_id: before.run_id,
  })
  const sent = await profile.cli('terminal', 'send', ...target, 'echo "still-""adopted"')
  expect(sent.code, sent.stderr).toBe(0)
  const stream = TerminalStream.open(profile, ...target)
  await stream.snapshot()
  await stream.waitForText(/still-adopted/)
  stream.close()
})
