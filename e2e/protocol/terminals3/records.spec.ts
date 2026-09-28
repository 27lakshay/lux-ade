// Daemon-authority ticket 04: terminals as records. The catalog lists each
// terminal with its kind, title, status (with an exit code), busy flag and
// foreground command. The runtime reads busy from the PTY's foreground process
// group; `terminal.close` is one daemon rule that refuses a busy terminal
// until the caller forces it.
import { expect, test, type ScratchProfile } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'

type Catalog = Awaited<ReturnType<ScratchProfile['call']>> & {
  catalog: {
    workspaces: Array<{ id: string; terminal_id: string; extra_terminals?: string[] }>
    terminals: Array<Record<string, unknown> & { id: string; workspace_id: string }>
  }
}

async function catalog(profile: ScratchProfile): Promise<Catalog['catalog']> {
  return ((await profile.call('catalog.get', {})) as Catalog).catalog
}

async function record(profile: ScratchProfile, terminalId: string) {
  return (await catalog(profile)).terminals.find((terminal) => terminal.id === terminalId)
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; details: Record<string, unknown> },
  )
}

/** Open a workspace and add a shell to it, attached and ready for input. */
async function shell(profile: ScratchProfile, title?: string) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { terminal_id: terminalId } = await profile.call('terminal.create', {
    workspace_id: workspace.id,
    ...(title ? { title } : {}),
  })
  const stream = TerminalStream.open(profile, workspace.id, terminalId)
  const runId = (await stream.snapshot()).run_id as string
  stream.send({ op: 'input', run_id: runId, data: 'echo "rea""dy"\n' })
  await stream.waitForText(/ready/)
  return { workspace, terminalId, stream, runId }
}

test('a shell is idle, sleep makes it busy and names it, and close is refused until forced', async ({ profile }) => {
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const { workspace, terminalId, stream, runId } = await shell(profile, 'Build')

  await expect
    .poll(async () => record(profile, terminalId))
    .toMatchObject({
      workspace_id: workspace.id,
      kind: 'shell',
      title: 'Build',
      status: 'running',
      busy: false,
      foreground: null,
      primary: false,
    })

  stream.send({ op: 'input', run_id: runId, data: 'sleep 30\n' })
  await expect.poll(async () => record(profile, terminalId)).toMatchObject({ busy: true, foreground: 'sleep' })
  const changed = await feed.waitFor(
    (frame) =>
      frame.type === 'terminal_changed' &&
      (frame.terminal as { id: string }).id === terminalId &&
      (frame.terminal as { busy: boolean }).busy,
  )
  expect(changed).toMatchObject({ terminal: { foreground: 'sleep', status: 'running' } })
  // The SDK's projection applies the frame to its catalog.
  expect(feed.client.getState().catalog?.terminals?.find((terminal) => terminal.id === terminalId)).toMatchObject({
    busy: true,
  })
  const listed = await profile.cli('terminal', 'list', workspace.id)
  expect(listed.code, listed.stderr).toBe(0)
  expect(listed.json!.terminals).toContainEqual(
    expect.objectContaining({ id: terminalId, terminal_id: terminalId, busy: true, foreground: 'sleep' }),
  )

  // Closing is refused while sleep runs, through the SDK and the CLI alike.
  const refused = await refusal(profile.call('terminal.close', { terminal_id: terminalId }))
  expect(refused.code).toBe('terminal_busy')
  expect(refused.details).toMatchObject({ terminal_id: terminalId, foreground: 'sleep' })
  const cli = await profile.cli('terminal', 'close', terminalId)
  expect(cli.code).toBe(22)
  expect(cli.json).toMatchObject({ code: 'terminal_busy', foreground: 'sleep' })
  expect(await record(profile, terminalId)).toMatchObject({ status: 'running', busy: true })

  // Forced, the shell and its command stop and the record goes.
  const forced = await profile.cli('terminal', 'close', terminalId, '--force')
  expect(forced.code, forced.stderr).toBe(0)
  const after = await catalog(profile)
  expect(after.terminals.map((terminal) => terminal.id)).not.toContain(terminalId)
  expect(after.workspaces.find((entry) => entry.id === workspace.id)?.extra_terminals).not.toContain(terminalId)
  expect(await terminalMetrics(profile, workspace.id, terminalId)).toBeUndefined()
  stream.close()
  feed.stop()
})

test('an exited shell reports its code, and records survive a daemon restart', async ({ profile }) => {
  const { workspace, terminalId, stream, runId } = await shell(profile, 'Tests')
  stream.send({ op: 'input', run_id: runId, data: 'exit 3\n' })
  await expect
    .poll(async () => record(profile, terminalId))
    .toMatchObject({ status: 'exited', exit_code: 3, busy: false, title: 'Tests' })
  stream.close()

  const before = await catalog(profile)
  await profile.restartDaemon('kill')
  const restored = await catalog(profile)
  expect(restored.terminals).toEqual(before.terminals)
  expect(restored.terminals.find((terminal) => terminal.id === terminalId)).toMatchObject({
    status: 'exited',
    exit_code: 3,
  })
  // The workspace's terminal fields are derived from the records.
  const primary = restored.terminals.filter((terminal) => terminal.workspace_id === workspace.id && terminal.primary)
  expect(primary.map((terminal) => terminal.id)).toEqual([workspace.terminal_id])
  expect(restored.workspaces.find((entry) => entry.id === workspace.id)?.extra_terminals).toEqual(
    restored.terminals
      .filter((terminal) => terminal.workspace_id === workspace.id && !terminal.primary)
      .map((terminal) => terminal.id),
  )

  // An exited shell is not busy, so it closes without force.
  const closed = await profile.cli('terminal', 'close', terminalId)
  expect(closed.code, closed.stderr).toBe(0)
  expect(await record(profile, terminalId)).toBeUndefined()
})

test('closing the primary shell gives the workspace a new one, and a close replays its receipt', async ({
  profile,
  repo,
}) => {
  // Not the daemon's own workspace, whose primary shell starts with the daemon.
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  expect(await record(profile, workspace.terminal_id)).toMatchObject({
    kind: 'shell',
    primary: true,
    status: 'not_started',
    title: 'Shell',
  })

  await profile.call('terminal.close', { operation_id: 'close-primary', terminal_id: workspace.terminal_id })
  // The same operation ID and payload returns the recorded outcome.
  await profile.call('terminal.close', { operation_id: 'close-primary', terminal_id: workspace.terminal_id })
  const after = await catalog(profile)
  const replacement = after.terminals.find((terminal) => terminal.workspace_id === workspace.id && terminal.primary)
  expect(replacement).toMatchObject({ kind: 'shell', status: 'not_started' })
  expect(replacement!.id).not.toBe(workspace.terminal_id)
  expect(after.workspaces.find((entry) => entry.id === workspace.id)?.terminal_id).toBe(replacement!.id)

  const unknown = await profile.cli('terminal', 'close', workspace.terminal_id)
  expect(unknown.code).not.toBe(0)
  expect(unknown.json?.message).toMatch(/does not exist/)
})

test('terminal create takes a title, refuses a bad one, and refuses place as unsupported', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const created = await profile.cli('terminal', 'create', workspace.id, '--request-id', 'titled', '--title', ' Logs ')
  expect(created.code, created.stderr).toBe(0)
  expect(await record(profile, created.json!.terminal_id as string)).toMatchObject({ title: 'Logs' })
  // The title is part of the receipt's payload.
  const conflict = await profile.cli('terminal', 'create', workspace.id, '--request-id', 'titled', '--title', 'Other')
  expect(conflict.code).not.toBe(0)

  const bad = await refusal(profile.call('terminal.create', { workspace_id: workspace.id, title: 'a\u0007b' }))
  expect((bad as unknown as Error).message).toMatch(/Invalid terminal title/)
  const placed = await refusal(
    profile.call('terminal.create', { workspace_id: workspace.id, place: { window_id: 'window_1' } }),
  )
  expect(placed.code).toBe('unsupported')
  const count = (await catalog(profile)).terminals.filter((terminal) => terminal.workspace_id === workspace.id).length
  expect(count).toBe(2)
})

test('an animated title reaches the feed about once a second, and its last value always arrives', async ({
  profile,
}) => {
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const { terminalId, stream, runId } = await shell(profile)
  const titles: Array<{ at: number; title: string; busy: boolean }> = []
  const unsubscribe = feed.client.subscribeFeed((frame) => {
    const terminal =
      frame.type === 'terminal_changed' ? (frame.terminal as { id: string; title: string; busy: boolean }) : null
    if (terminal?.id === terminalId) titles.push({ at: Date.now(), title: terminal.title, busy: terminal.busy })
  })
  const started = Date.now()
  // One foreground program sets about 100 titles a second for two seconds.
  stream.send({
    op: 'input',
    run_id: runId,
    data: `perl -e '$|=1; for (1..200) { print "\\e]2;step-$_\\a"; select(undef,undef,undef,0.01) }'\n`,
  })
  await expect
    .poll(() => feed.client.getState().catalog?.terminals?.find((terminal) => terminal.id === terminalId)?.title, {
      timeout: 30_000,
    })
    .toBe('step-200')
  const seconds = (Date.now() - started) / 1000
  unsubscribe()
  // Busy starting and ending go out at once; the title changes alone at most once a second.
  const busyChanges = titles.filter((entry, index) => index > 0 && entry.busy !== titles[index - 1].busy).length
  expect(titles.length).toBeGreaterThan(1)
  expect(titles.length - busyChanges).toBeLessThanOrEqual(Math.ceil(seconds) + 2)
  expect(await record(profile, terminalId)).toMatchObject({ title: 'step-200' })
  stream.close()
  feed.stop()
})
