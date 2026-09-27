// F083 and 07-S10: terminal.stop is proven only by an empty process tree. A
// shell's exit says nothing about a child that ignores SIGTERM and SIGHUP, so
// the stop must escalate and report the tree's verdict, not the shell's status.
import { expect, isRunning, test } from '../fixtures'
import { settledExit, terminalMetrics, TerminalStream } from '../fixtures/terminals'

test('a stop settles as exited only after a child that ignores TERM and HUP is gone', async ({ ade, profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const stream = TerminalStream.open(profile, ...target)
  const runId = (await stream.snapshot()).run_id as string
  // A background child that ignores the signals a shell hang-up and a polite stop send.
  stream.send({ op: 'input', run_id: runId, data: `(trap '' TERM HUP INT; exec sleep 600) & echo "stub""born:"$!\n` })
  const stubborn = Number((await stream.waitForText(/stubborn:(\d+)/))[1])
  await ade.ledger.own(stubborn, 'TERM-ignoring terminal child')
  expect(await isRunning(stubborn)).toBe(true)
  const shellPid = (await terminalMetrics(profile, ...target))!.shell_pid as number

  const stopped = await profile.cli('terminal', 'stop', ...target)
  expect(stopped.code, stopped.stderr).toBe(0)

  // While the tree is unproven the terminal must not report a plain exit.
  const settled = await settledExit(profile, ...target)
  expect(await isRunning(shellPid)).toBe(false)
  expect(await isRunning(stubborn)).toBe(false)
  expect(settled.exit_status).toMatchObject({ descendants: { verdict: 'exited' } })
  expect(['signaled', 'success', 'failure']).toContain(settled.exit_status!.kind)
  expect(settled.run_id).toBe(runId)

  // The duplicate stop converges without error and changes nothing.
  const duplicate = await profile.cli('terminal', 'stop', ...target)
  expect(duplicate.code, duplicate.stderr).toBe(0)
  expect((await terminalMetrics(profile, ...target))!.exit_status).toEqual(settled.exit_status)
  stream.close()
})

test('a stopped extra terminal can be retired, and a running one cannot', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { terminal_id: terminalId } = await profile.call('terminal.create', {
    workspace_id: workspace.id,
    operation_id: 'retire-me',
  })
  const target = [workspace.id, terminalId] as const
  const stream = TerminalStream.open(profile, ...target)
  const runId = (await stream.snapshot()).run_id as string
  stream.send({ op: 'input', run_id: runId, data: 'echo "rea""dy"\n' })
  await stream.waitForText(/ready/)

  const early = await profile.cli('terminal', 'retire', ...target)
  expect(early.code).not.toBe(0)
  expect(early.stderr).toMatch(/Stop the shell/)

  await profile.call('terminal.stop', { workspace_id: workspace.id, terminal_id: terminalId })
  await settledExit(profile, ...target)
  const retired = await profile.cli('terminal', 'retire', ...target)
  expect(retired.code, retired.stderr).toBe(0)
  expect(await terminalMetrics(profile, ...target)).toBeUndefined()
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.workspaces.find((entry) => entry.id === workspace.id)?.extra_terminals).toEqual([])
  // The receipt still names the terminal it created.
  const receipt = await profile.cli('terminal', 'operation', workspace.id, 'retire-me')
  expect(receipt.json).toMatchObject({ terminal_id: terminalId })
  stream.close()
})
