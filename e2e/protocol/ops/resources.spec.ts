// F136 resource visibility: measured process-tree and host resources with
// provenance, with unknown markers for what could not be observed, and totals
// that count each process once across nested groups. Each group is correlated
// with the daemon boot, runtime incarnation, Agent run or terminal incarnation
// it measures.
import { expect, isRunning, prompts, send, startConversation, test, type ScratchProfile } from '../fixtures'
import { configureService, waitForReadiness, writeServicePrograms } from '../fixtures/services'

async function resources(profile: ScratchProfile) {
  return (await profile.call('diagnostics.status', {})).resources
}

test('groups measure whole process trees with provenance, and totals count nested processes once', async ({ profile, repo }) => {
  // A service run through a wrapper, like `pnpm dev`: its tree is the shell and the server it starts.
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'wrapped', { program: process.execPath, args: [files.wrapper], ports: ['PORT'] })
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'wrapped' })
  await waitForReadiness(profile, workspace.id, 'wrapped', 'tcp_listening')
  const owner = started.service.terminal_owner!
  const shellPid = (started.metrics as { shell_pid: number }).shell_pid

  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  let report = await resources(profile)
  let run: { run_id: string; pid: number | null } | undefined
  await expect.poll(async () => {
    const status = await profile.call('diagnostics.status', {})
    report = status.resources
    run = status.live.runs.find((entry) => entry.conversation_id === conversationId)
    return Boolean(run && report.groups.some((group) => group.kind === 'agent' && group.subject === conversationId))
  }).toBe(true)

  const before = Date.now()
  report = await resources(profile)
  expect(report).toMatchObject({ observed: true, method: expect.stringMatching(/^(phys_footprint|proportional_set_size)$/) })
  expect(report.observed_at).toBeGreaterThanOrEqual(before - 1_000)
  expect(report.observed_at).toBeLessThanOrEqual(Date.now() + 1_000)
  expect(report.host.logical_cpus).toBeGreaterThanOrEqual(1)
  expect(report.host.memory_bytes).toBeGreaterThan(0)

  const find = (kind: string, subject?: string) =>
    report.groups.find((group) => group.kind === kind && (subject === undefined || group.subject === subject))!
  const daemon = find('daemon')
  expect(daemon).toMatchObject({ root_pid: profile.hello.pid, subject: profile.hello.boot_id, provenance: 'exact' })
  const runtime = find('runtime')
  expect(runtime).toMatchObject({ root_pid: profile.hello.runtime_pid, subject: profile.hello.runtime_instance,
    provenance: 'exact' })
  const agent = find('agent', conversationId)
  expect(agent).toMatchObject({ incarnation: run!.run_id, root_pid: run!.pid, provenance: 'exact' })
  const terminal = find('terminal', owner.terminal_id)
  expect(terminal).toMatchObject({ incarnation: owner.transfer_id, root_pid: shellPid, provenance: 'exact' })
  // The whole tree: the wrapper and the server it spawned.
  expect(terminal.pids.length).toBeGreaterThanOrEqual(2)
  for (const pid of terminal.pids) expect(await isRunning(pid)).toBe(true)

  for (const group of [daemon, runtime, agent, terminal]) {
    expect(group.pids[0]).toBe(group.root_pid)
    expect(group.footprint_bytes).toBeGreaterThan(0)
    expect(group.cpu_time_ms).toBeGreaterThanOrEqual(0)
  }
  // The runtime's tree holds its Agent and terminal trees.
  for (const pid of [...agent.pids, ...terminal.pids]) expect(runtime.pids).toContain(pid)

  // Totals count each distinct process once, however many groups hold it.
  const distinct = new Set(report.groups.flatMap((group) => group.pids))
  expect(report.total_processes).toBe(distinct.size)
  const summed = report.groups.reduce((sum, group) => sum + (group.footprint_bytes ?? 0), 0)
  expect(report.total_footprint_bytes).toBeGreaterThan(0)
  expect(report.total_footprint_bytes!).toBeLessThan(summed)
  const largest = Math.max(...report.groups.map((group) => group.footprint_bytes ?? 0))
  expect(report.total_footprint_bytes!).toBeGreaterThanOrEqual(largest)

  // The CLI reports the same measurement.
  const cli = await profile.cli('diagnostics', 'status')
  expect(cli.code).toBe(0)
  const cliResources = (cli.json as { resources: typeof report }).resources
  expect(cliResources.groups.map((group) => [group.kind, group.root_pid]))
    .toEqual(expect.arrayContaining([['daemon', profile.hello.pid], ['terminal', shellPid]]))

  // A stopped service's tree leaves the measurement.
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'wrapped' })
  await expect.poll(async () => (await resources(profile)).groups.some((group) => group.subject === owner.terminal_id))
    .toBe(false)
  await profile.call('agent.cancel', { conversation_id: conversationId })
})

test('a lost runtime is marked unknown, not measured as zero, and a new one is measured again', async ({ profile }) => {
  const crashed = profile.hello
  await profile.killRuntime()
  const status = await profile.call('diagnostics.status', {})
  const runtime = status.resources.groups.find((group) => group.kind === 'runtime')!
  expect(runtime).toMatchObject({ root_pid: crashed.runtime_pid, subject: crashed.runtime_instance, pids: [],
    footprint_bytes: null, cpu_time_ms: null, provenance: 'unavailable', note: expect.stringMatching(/not found/) })
  // Without a runtime catalogue there are no Agent or terminal groups, and the report says why.
  expect(status.resources.groups.filter((group) => group.kind === 'agent' || group.kind === 'terminal')).toEqual([])
  expect(status.live.observed).toBe(false)
  expect(status.degraded.length).toBeGreaterThan(0)
  // The daemon is still measured, and the totals cover only what was read.
  const daemon = status.resources.groups.find((group) => group.kind === 'daemon')!
  expect(daemon.provenance).toBe('exact')
  expect(status.resources.total_processes).toBe(new Set(status.resources.groups.flatMap((group) => group.pids)).size)

  const replaced = await profile.restartDaemon()
  const after = (await resources(profile)).groups.find((group) => group.kind === 'runtime')!
  expect(after).toMatchObject({ root_pid: replaced.runtime_pid, subject: replaced.runtime_instance, provenance: 'exact' })
  expect(after.footprint_bytes).toBeGreaterThan(0)
})
