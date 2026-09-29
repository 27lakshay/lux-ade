// F083: programmatic terminal creation through the CLI and the SDK. A
// terminal.create with an operation ID is an effect command: a duplicate or a
// retry after a lost reply returns the same terminal, the receipt survives a
// daemon crash, and a reused ID for another workspace is a conflict.
import { expect, primaryShell, test } from '../fixtures'
import { TerminalStream } from '../fixtures/terminals'

test('terminal create returns a receipt that a duplicate, a lookup and a daemon crash all resolve to one terminal', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const shellId = await primaryShell(profile, workspace.id)

  const created = await profile.cli('terminal', 'create', workspace.id, '--request-id', 'create-once')
  expect(created.code, created.stderr).toBe(0)
  expect(created.json).toMatchObject({ type: 'ack', request_id: 'create-once' })
  const terminalId = created.json!.terminal_id as string
  expect(terminalId).toMatch(/^terminal/)
  expect(terminalId).not.toBe(shellId)

  // A retry after a lost reply reuses the ID and gets the same terminal, not a second one.
  const duplicate = await profile.cli('terminal', 'create', workspace.id, '--request-id', 'create-once')
  expect(duplicate.code, duplicate.stderr).toBe(0)
  expect(duplicate.json!.terminal_id).toBe(terminalId)
  const viaSdk = await profile.call('terminal.create', { workspace_id: workspace.id, operation_id: 'create-once' })
  expect(viaSdk.terminal_id).toBe(terminalId)

  const receipt = await profile.cli('terminal', 'operation', workspace.id, 'create-once')
  expect(receipt.code, receipt.stderr).toBe(0)
  expect(receipt.json).toMatchObject({
    type: 'terminal_operation',
    workspace_id: workspace.id,
    request_id: 'create-once',
    terminal_id: terminalId,
  })

  const listed = await profile.cli('terminal', 'list')
  expect(listed.code, listed.stderr).toBe(0)
  const ours = (listed.json!.terminals as Array<{ workspace_id: string; id: string }>).filter(
    (entry) => entry.workspace_id === workspace.id,
  )
  expect(ours.map((entry) => entry.id).sort()).toEqual([shellId, terminalId].sort())

  // The same ID for another workspace is a conflict and creates nothing there.
  const other = (await profile.call('workspace.open', { path: repo.path })).workspace
  const conflict = await profile.cli('terminal', 'create', other.id, '--request-id', 'create-once')
  expect(conflict.code).not.toBe(0)
  expect(conflict.stderr).toMatch(/conflicts with another workspace/)
  const otherReceipt = await profile.cli('terminal', 'operation', other.id, 'create-once')
  expect(otherReceipt.code).not.toBe(0)
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.terminals.filter((entry) => entry.workspace_id === other.id && !entry.primary)).toEqual([])

  // The receipt is durable: after a daemon crash the lookup and a replay still name the same terminal.
  await profile.restartDaemon('kill')
  const afterCrash = await profile.cli('terminal', 'operation', workspace.id, 'create-once')
  expect(afterCrash.json).toMatchObject({ terminal_id: terminalId })
  const replay = await profile.call('terminal.create', { workspace_id: workspace.id, operation_id: 'create-once' })
  expect(replay.terminal_id).toBe(terminalId)
  const restored = await profile.call('catalog.get', {})
  expect(
    restored.catalog.terminals
      .filter((entry) => entry.workspace_id === workspace.id && !entry.primary)
      .map((entry) => entry.id),
  ).toEqual([terminalId])

  // The created terminal runs a real shell that takes input.
  const stream = TerminalStream.open(profile, workspace.id, terminalId)
  const snapshot = await stream.snapshot()
  expect(snapshot.terminal_snapshot_format).toBe('xterm-replay-v1')
  stream.send({ op: 'input', data: 'echo "cre""ated-$((40+2))"\n' })
  await stream.waitForText(/created-42/)
  stream.close()
})

test('terminal create without an operation ID makes a new terminal each time, and an unknown receipt is refused', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const first = await profile.call('terminal.create', { workspace_id: workspace.id })
  const second = await profile.call('terminal.create', { workspace_id: workspace.id })
  expect(first.terminal_id).not.toBe(second.terminal_id)

  const unknown = await profile.cli('terminal', 'operation', workspace.id, 'never-issued')
  expect(unknown.code).not.toBe(0)
  expect(unknown.stderr).toMatch(/unavailable/i)

  const usage = await profile.cli('terminal', 'create', workspace.id)
  expect(usage.code).not.toBe(0)
  expect(usage.stderr).toMatch(/--request-id/)

  // A null operation ID is refused rather than treated as absent.
  const refused = await profile.rpc({ op: 'terminal.create', workspace_id: workspace.id, operation_id: null }).then(
    () => null,
    (error: Error) => error.message,
  )
  expect(refused).toMatch(/request ID/i)
  const catalog = await profile.call('catalog.get', {})
  expect(
    catalog.catalog.terminals
      .filter((entry) => entry.workspace_id === workspace.id && !entry.primary)
      .map((entry) => entry.id),
  ).toEqual([first.terminal_id, second.terminal_id])
})
