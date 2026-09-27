// F083 and D06: input and resize are fenced by the terminal's incarnation
// (its run_id), and one attachment owns the viewport while others observe.
import { expect, test } from '../fixtures'
import { settledExit, terminalMetrics, TerminalStream } from '../fixtures/terminals'

test('two attachments hand viewport ownership over by claim, by input and by detach', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const first = TerminalStream.open(profile, workspace.id, workspace.terminal_id)
  const firstSnapshot = await first.snapshot()
  const second = TerminalStream.open(profile, workspace.id, workspace.terminal_id)
  const secondSnapshot = await second.snapshot()
  const runId = firstSnapshot.run_id as string
  expect(secondSnapshot.run_id).toBe(runId)
  const a = firstSnapshot.attachment as number
  const b = secondSnapshot.attachment as number
  expect(a).not.toBe(b)
  const shellPid = (await terminalMetrics(profile, workspace.id, workspace.terminal_id))!.shell_pid

  // The first attachment claims the viewport; both see the PTY resize.
  let mark = first.frames.length
  first.send({ op: 'resize', cols: 120, rows: 40, width_px: 0, height_px: 0, claim: true, run_id: runId })
  await first.waitFor('ownership for the first attachment', (frame) => frame.type === 'viewport' && frame.owner === true, { from: mark })
  await second.waitFor('the claimed size', (frame) => frame.type === 'terminal_resize' && frame.cols === 120 && frame.rows === 40)
  expect((await terminalMetrics(profile, workspace.id, workspace.terminal_id))!.resize_owner).toBe(a)

  // An observer's plain resize records its size but does not change the PTY.
  mark = second.frames.length
  second.send({ op: 'resize', cols: 80, rows: 20, width_px: 0, height_px: 0, claim: false, run_id: runId })
  second.send({ op: 'ping', run_id: runId })
  const metrics = await second.waitFor('metrics after the observer resize', (frame) => frame.type === 'metrics', { from: mark })
  expect((metrics.metrics as Record<string, unknown>).resize_owner).toBe(a)
  expect(second.frames.slice(mark).some((frame) => frame.type === 'terminal_resize')).toBe(false)
  first.send({ op: 'input', data: 'echo "size-a:$(stty size)"\n', run_id: runId })
  await first.waitForText(/size-a:40 120/)

  // Typing in the observer moves ownership to it and applies its size.
  const firstMark = first.frames.length
  mark = second.frames.length
  second.send({ op: 'input', data: 'echo "size-b:$(stty size)"\n', run_id: runId })
  await second.waitFor('ownership for the typing attachment', (frame) => frame.type === 'viewport' && frame.owner === true, { from: mark })
  await first.waitFor('the loss of ownership', (frame) => frame.type === 'viewport' && frame.owner === false, { from: firstMark })
  await second.waitForText(/size-b:20 80/)
  expect((await terminalMetrics(profile, workspace.id, workspace.terminal_id))!.resize_owner).toBe(b)

  // The owner detaches: the survivor owns again, its size returns, the shell keeps running.
  const handOff = first.frames.length
  second.send({ op: 'detach', run_id: runId })
  const detached = await second.waitFor('the detach reply', (frame) => frame.type === 'detached')
  expect(detached).toMatchObject({ attachment: b, run_id: runId })
  await second.waitForClose()
  await first.waitFor('ownership handed back', (frame) => frame.type === 'viewport' && frame.owner === true, { from: handOff })
  await first.waitFor('the survivor size', (frame) => frame.type === 'terminal_resize' && frame.cols === 120 && frame.rows === 40, { from: handOff })
  const after = (await terminalMetrics(profile, workspace.id, workspace.terminal_id))!
  expect(after).toMatchObject({ shell_running: true, shell_pid: shellPid, run_id: runId, resize_owner: a })

  // Closing the last attachment without a detach also releases ownership and leaves the shell running.
  first.close()
  await expect.poll(async () => (await terminalMetrics(profile, workspace.id, workspace.terminal_id))!.resize_owner).toBeNull()
  expect((await terminalMetrics(profile, workspace.id, workspace.terminal_id))!).toMatchObject({ shell_running: true, shell_pid: shellPid })
})

test('input and resize naming another incarnation change nothing, and an exited incarnation refuses them', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const stream = TerminalStream.open(profile, ...target)
  const snapshot = await stream.snapshot()
  const runId = snapshot.run_id as string
  expect(runId).toMatch(/^terminal-run/)

  // A stale run_id (or a malformed one) is refused, and its input never reaches the shell.
  let mark = stream.frames.length
  stream.send({ op: 'input', data: 'echo "sta""le-input"\n', run_id: 'terminal-run-earlier' })
  stream.send({ op: 'input', data: 'echo "sta""le-number"\n', run_id: 7 })
  stream.send({ op: 'resize', cols: 50, rows: 12, claim: true, run_id: 'terminal-run-earlier' })
  stream.send({ op: 'input', data: 'echo "fre""sh-$(stty size)"\n', run_id: runId })
  await stream.waitForText(/fresh-30 100/)
  const refusals = stream.frames.slice(mark).filter((frame) => frame.type === 'error')
  expect(refusals.map((frame) => frame.code)).toEqual(['stale_incarnation', 'stale_incarnation', 'stale_incarnation'])
  for (const refusal of refusals) expect(refusal.run_id).toBe(runId)
  expect(stream.text()).not.toMatch(/stale-input|stale-number/)
  expect(stream.frames.slice(mark).some((frame) => frame.type === 'terminal_resize')).toBe(false)

  // A subscribe that expects another incarnation gets no snapshot.
  const expectingOld = TerminalStream.open(profile, ...target, { op: 'subscribe', snapshot_format: 'xterm-replay-v1', run_id: 'terminal-run-earlier' })
  const refused = await expectingOld.waitFor('the stale subscribe refusal', (frame) => frame.type === 'error')
  expect(refused.code).toBe('stale_incarnation')
  expect(expectingOld.frames.some((frame) => frame.type === 'snapshot')).toBe(false)
  expectingOld.close()

  // Stop the shell: input and resize for the exited incarnation are refused, not written to a dead PTY.
  await profile.call('terminal.stop', { workspace_id: workspace.id, terminal_id: workspace.terminal_id })
  await settledExit(profile, ...target)
  mark = stream.frames.length
  stream.send({ op: 'input', data: 'echo late\n', run_id: runId })
  stream.send({ op: 'resize', cols: 60, rows: 20, claim: true, run_id: runId })
  await expect.poll(() => stream.frames.slice(mark).filter((frame) => frame.code === 'incarnation_exited').length).toBe(2)

  // The CLI reports the refusal instead of claiming the input was submitted.
  const sent = await profile.cli('terminal', 'send', ...target, 'echo late')
  expect(sent.code).not.toBe(0)
  expect(sent.stderr).toMatch(/exited/)
  const resized = await profile.cli('terminal', 'resize', ...target, '90', '25')
  expect(resized.code).not.toBe(0)

  // A duplicate stop of the exited incarnation converges.
  await profile.call('terminal.stop', { workspace_id: workspace.id, terminal_id: workspace.terminal_id })

  // Restart: a new incarnation. The old run_id is now stale everywhere, and nothing sent with it reaches the new shell.
  const beforeRestart = (await terminalMetrics(profile, ...target))!
  await profile.cli('terminal', 'restart', ...target).then((result) => expect(result.code, result.stderr).toBe(0))
  await stream.waitForClose()
  const restarted = (await terminalMetrics(profile, ...target))!
  expect(restarted.run_id).not.toBe(runId)
  expect(restarted.shell_pid).not.toBe(beforeRestart.shell_pid)
  expect(restarted.shell_running).toBe(true)

  // A duplicate restart does not replace the running shell.
  const again = await profile.cli('terminal', 'restart', ...target)
  expect(again.code).not.toBe(0)
  expect((await terminalMetrics(profile, ...target))!.run_id).toBe(restarted.run_id)

  const old = TerminalStream.open(profile, ...target, { op: 'input', data: 'echo "ol""d-run"\n', run_id: runId })
  const stale = await old.waitFor('the stale input refusal', (frame) => frame.type === 'error')
  expect(stale).toMatchObject({ code: 'stale_incarnation', run_id: restarted.run_id })
  old.close()

  const current = TerminalStream.open(profile, ...target)
  expect((await current.snapshot()).run_id).toBe(restarted.run_id)
  current.send({ op: 'input', data: 'echo "ne""w-run"\n', run_id: restarted.run_id })
  await current.waitForText(/new-run/)
  expect(current.text()).not.toMatch(/old-run|stale-input/)
  current.close()

  // The CLI send and resize work against the new incarnation.
  const submitted = await profile.cli('terminal', 'send', ...target, 'echo cli-input')
  expect(submitted.code, submitted.stderr).toBe(0)
  expect(submitted.json).toMatchObject({ type: 'terminal_input_submitted' })
  const resize = await profile.cli('terminal', 'resize', ...target, '90', '25')
  expect(resize.code, resize.stderr).toBe(0)
})

test('a runtime crash starts a new incarnation and fences the old one', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const stream = TerminalStream.open(profile, ...target)
  const runId = (await stream.snapshot()).run_id as string
  stream.send({ op: 'input', data: 'echo "be""fore-crash"\n', run_id: runId })
  await stream.waitForText(/before-crash/)

  await profile.killRuntime()
  await stream.waitForClose()
  await profile.restartDaemon()

  const next = TerminalStream.open(profile, ...target)
  const snapshot = await next.snapshot()
  expect(snapshot.run_id).not.toBe(runId)
  // The new shell's replay starts at its own process start; it never presents the lost shell's output as its own.
  expect((snapshot.terminal_recovery as Record<string, unknown>).complete).toBe(true)
  expect(next.text()).not.toMatch(/before-crash/)

  const stale = TerminalStream.open(profile, ...target, { op: 'input', data: 'echo "ghos""t"\n', run_id: runId })
  expect((await stale.waitFor('the stale refusal', (frame) => frame.type === 'error')).code).toBe('stale_incarnation')
  stale.close()
  next.send({ op: 'input', data: 'echo "af""ter-crash"\n', run_id: snapshot.run_id })
  await next.waitForText(/after-crash/)
  expect(next.text()).not.toMatch(/ghost/)
  next.close()
})
