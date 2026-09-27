// F090 workspace scripts: discovery of checked-in recipes and package scripts,
// supervised runs with workspace identity and output, stop and retire
// controls, and runs that outlive a daemon restart.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { logText } from '../fixtures/services'

async function writeScripts(repo: ScratchRepo): Promise<void> {
  await mkdir(join(repo.path, '.ade'), { recursive: true })
  await mkdir(join(repo.path, 'tools'), { recursive: true })
  await writeFile(join(repo.path, 'tools/greet.mjs'),
    "console.log('script says hello from ' + process.cwd() + ' args=' + process.argv.slice(2).join(','))\n")
  await writeFile(join(repo.path, 'tools/fail.mjs'), "console.log('about to fail'); process.exit(3)\n")
  await writeFile(join(repo.path, 'tools/hold.mjs'),
    "console.log('holding ' + process.pid); setInterval(() => {}, 1 << 30)\n")
  const recipe = (file: string, args: string[] = [], cwd = '.') => ({ program: process.execPath, args: [join(repo.path, file), ...args], cwd })
  await writeFile(join(repo.path, '.ade/scripts.json'), JSON.stringify({
    schema_version: 1,
    scripts: {
      greet: recipe('tools/greet.mjs', ['one', 'two'], 'tools'),
      fail: recipe('tools/fail.mjs'),
      hold: recipe('tools/hold.mjs'),
    },
  }))
  await writeFile(join(repo.path, 'package.json'), JSON.stringify({
    name: 'scratch', private: true, scripts: { 'pkg-greet': 'node -e "console.log(\'package script ran\')"' },
  }))
}

type Run = { run_id: string; state: string; exit_status?: unknown; metrics: unknown }

async function inspect(profile: ScratchProfile, workspaceId: string, runId: string) {
  return profile.call('script.inspect', { workspace_id: workspaceId, run_id: runId })
}

async function waitForExit(profile: ScratchProfile, workspaceId: string, runId: string): Promise<Run> {
  await expect.poll(async () => (await inspect(profile, workspaceId, runId)).state, { timeout: 20_000 }).toBe('exited')
  return inspect(profile, workspaceId, runId)
}

test('scripts are discovered from recipes and package.json and run with their output and exit', async ({ profile, repo }) => {
  await writeScripts(repo)
  const { workspace } = await profile.call('workspace.open', { path: repo.path })

  const listed = await profile.call('script.list', { workspace_id: workspace.id })
  expect(listed.workspace_id).toBe(workspace.id)
  expect(listed.scripts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'ade_recipe', name: 'greet', program: process.execPath, cwd: 'tools' }),
    expect.objectContaining({ kind: 'ade_recipe', name: 'hold' }),
    expect.objectContaining({ kind: 'package_json', name: 'pkg-greet' }),
  ]))

  const greet = await profile.call('script.start', { workspace_id: workspace.id, name: 'greet' })
  expect(greet).toMatchObject({ type: 'script_run', workspace_id: workspace.id, name: 'greet' })
  expect(greet.run_id).toMatch(/^script_greet_[0-9a-f-]{36}$/)
  const done = await waitForExit(profile, workspace.id, greet.run_id)
  expect(done.exit_status).toMatchObject({ kind: 'success' })
  await expect.poll(async () => (await inspect(profile, workspace.id, greet.run_id)).output_coverage.status).toBe('complete')
  const finished = await inspect(profile, workspace.id, greet.run_id)
  expect(logText(finished.output)).toContain(`script says hello from ${join(repo.path, 'tools')} args=one,two`)
  expect(logText(finished.durable_output)).toContain('script says hello')

  const failing = await profile.call('script.start', { workspace_id: workspace.id, name: 'fail' })
  expect((await waitForExit(profile, workspace.id, failing.run_id)).exit_status).toMatchObject({ kind: 'failure' })
  expect(logText((await inspect(profile, workspace.id, failing.run_id)).output)).toContain('about to fail')

  const pkg = await profile.call('script.start', { workspace_id: workspace.id, name: 'pkg-greet' })
  expect(pkg.toolchain).toMatchObject({ manager: 'npm' })
  expect((await waitForExit(profile, workspace.id, pkg.run_id)).exit_status).toMatchObject({ kind: 'success' })
  await expect.poll(async () => logText((await inspect(profile, workspace.id, pkg.run_id)).output)).toContain('package script ran')

  const runs = await profile.call('script.runs', { workspace_id: workspace.id })
  expect(runs.runs.map((run) => run.run_id).sort()).toEqual([greet.run_id, failing.run_id, pkg.run_id].sort())

  // Only configured scripts run; a request never carries a command.
  await expect(profile.call('script.start', { workspace_id: workspace.id, name: 'missing' }))
    .rejects.toThrow(/Workspace script is not configured/)
  await expect(profile.call('script.start', { workspace_id: workspace.id, name: '../escape' }))
    .rejects.toThrow(/Invalid script name/)
  await expect(profile.rpc({ op: 'script.start', workspace_id: workspace.id, name: 'greet', program: '/bin/sh' }))
    .resolves.toMatchObject({ name: 'greet' })
})

test('a running script is stopped, retired only once stopped, and its identity stays in its workspace', async ({ ade, profile, repo }) => {
  await writeScripts(repo)
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const other = await ade.repo({ name: 'other' })
  const otherWorkspace = (await profile.call('workspace.open', { path: other.path })).workspace

  const hold = await profile.call('script.start', { workspace_id: workspace.id, name: 'hold' })
  expect(hold.state).toBe('running')
  const pid = (hold.metrics as { shell_pid: number }).shell_pid
  await expect.poll(async () => logText((await inspect(profile, workspace.id, hold.run_id)).output)).toContain(`holding ${pid}`)
  const running = await inspect(profile, workspace.id, hold.run_id)
  expect(running.output_coverage).toMatchObject({ status: 'pending', reason: 'process_running' })

  // Another workspace can neither see nor control the run.
  expect((await profile.call('script.runs', { workspace_id: otherWorkspace.id })).runs).toEqual([])
  await expect(inspect(profile, otherWorkspace.id, hold.run_id)).rejects.toThrow(/Script run is unavailable/)
  await expect(profile.call('script.stop', { workspace_id: otherWorkspace.id, run_id: hold.run_id }))
    .rejects.toThrow(/Script run is unavailable/)

  await expect(profile.call('script.retire', { workspace_id: workspace.id, run_id: hold.run_id }))
    .rejects.toThrow(/Stop the script before retiring its run/)

  const stopped = await profile.call('script.stop', { workspace_id: workspace.id, run_id: hold.run_id })
  expect(stopped.state).toBe('exited')
  expect(stopped.exit_status).toMatchObject({ kind: 'signaled' })
  expect(await isRunning(pid)).toBe(false)
  // A repeated stop converges on the same exit.
  const again = await profile.call('script.stop', { workspace_id: workspace.id, run_id: hold.run_id })
  expect(again).toMatchObject({ state: 'exited', exit_status: stopped.exit_status })

  const retired = await profile.call('script.retire', { workspace_id: workspace.id, run_id: hold.run_id })
  expect(retired).toMatchObject({ workspace_id: workspace.id, run_id: hold.run_id })
  expect((await profile.call('script.runs', { workspace_id: workspace.id })).runs).toEqual([])
  await expect(inspect(profile, workspace.id, hold.run_id)).rejects.toThrow(/Script run is unavailable/)
  await expect(profile.call('script.retire', { workspace_id: workspace.id, run_id: hold.run_id }))
    .rejects.toThrow(/Script run is unavailable/)
})

for (const mode of ['graceful', 'kill'] as const) {
  test(`a running script survives a ${mode} daemon restart and is stopped afterwards`, async ({ profile, repo }) => {
    await writeScripts(repo)
    const { workspace } = await profile.call('workspace.open', { path: repo.path })
    const hold = await profile.call('script.start', { workspace_id: workspace.id, name: 'hold' })
    const pid = (hold.metrics as { shell_pid: number }).shell_pid

    await profile.restartDaemon(mode)

    expect(await isRunning(pid)).toBe(true)
    const runs = await profile.call('script.runs', { workspace_id: workspace.id })
    expect(runs.runs).toEqual([expect.objectContaining({ run_id: hold.run_id, state: 'running' })])
    const stopped = await profile.call('script.stop', { workspace_id: workspace.id, run_id: hold.run_id })
    expect(stopped.state).toBe('exited')
    expect(await isRunning(pid)).toBe(false)
    await profile.call('script.retire', { workspace_id: workspace.id, run_id: hold.run_id })
  })
}

test('a recipe that escapes its workspace is refused at discovery', async ({ profile, repo }) => {
  await mkdir(join(repo.path, '.ade'), { recursive: true })
  await writeFile(join(repo.path, '.ade/scripts.json'), JSON.stringify({ schema_version: 1,
    scripts: { outside: { program: process.execPath, args: ['-v'], cwd: '..' } } }))
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  await expect(profile.call('script.list', { workspace_id: workspace.id })).rejects.toThrow(/ADE script directory must be workspace-relative/)
  await expect(profile.call('script.start', { workspace_id: workspace.id, name: 'outside' }))
    .rejects.toThrow(/ADE script directory must be workspace-relative/)
  await writeFile(join(repo.path, '.ade/scripts.json'), JSON.stringify({ schema_version: 2, scripts: {} }))
  await expect(profile.call('script.list', { workspace_id: workspace.id })).rejects.toThrow(/Unsupported ADE script schema version/)
})

test('the CLI lists, starts, inspects, stops and retires scripts', async ({ profile, repo }) => {
  await writeScripts(repo)
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const listed = await profile.cli('script', 'list', workspace.id)
  expect(listed.code).toBe(0)
  expect(JSON.stringify(listed.json)).toContain('"name":"hold"')

  const started = await profile.cli('script', 'start', workspace.id, 'hold')
  expect(started.code).toBe(0)
  const runId = String(started.json?.run_id)
  const inspected = await profile.cli('script', 'inspect', workspace.id, runId, '4096')
  expect(inspected.json).toMatchObject({ type: 'script_run', run_id: runId })
  const stopped = await profile.cli('script', 'stop', workspace.id, runId)
  expect(stopped.json).toMatchObject({ state: 'exited' })
  expect((await profile.cli('script', 'retire', workspace.id, runId)).code).toBe(0)
  expect((await profile.cli('script', 'runs', workspace.id)).json).toMatchObject({ runs: [] })
})
