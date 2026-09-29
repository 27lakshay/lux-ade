// F090 workspace script runs beyond scripts.spec.ts: hidden package scripts,
// relative recipe programs and cwd escapes through links, runs of two profiles
// in one checkout, the installed project toolchain under a Finder launch PATH,
// a saturated output spool, handoff of exited runs, and a daemon crash during
// retirement. Ported from the legacy e2e/specs/workspace-scripts spec.
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { expect, test, type AdeHarness, type ScratchProfile } from '../fixtures'
import { logText } from '../fixtures/services'

async function folder(ade: AdeHarness, name: string): Promise<string> {
  const path = join(ade.root, name)
  await mkdir(path, { recursive: true })
  return realpath(path)
}

async function recipes(root: string, scripts: Record<string, unknown>): Promise<string> {
  await mkdir(join(root, '.ade'), { recursive: true })
  const manifest = join(root, '.ade', 'scripts.json')
  await writeFile(manifest, JSON.stringify({ schema_version: 1, scripts }))
  return manifest
}

/**
 * The directory of the executable `name` resolves to on this host. A profile
 * runs with a scratch HOME, so the daemon cannot scan the user's version
 * manager homes; a spec hands it the real install directories through
 * ADE_PROJECT_TOOL_PATHS instead. A mise shim needs that HOME, so it is
 * resolved to the binary it runs.
 */
function installedToolDirectory(name: string): string {
  const found = execFileSync('which', [name], { encoding: 'utf8' }).trim()
  const binary = found.includes('/mise/shims/')
    ? execFileSync('mise', ['which', name], { encoding: 'utf8' }).trim()
    : found
  return dirname(binary)
}

async function inspect(profile: ScratchProfile, workspace_id: string, run_id: string) {
  return profile.call('script.inspect', { workspace_id, run_id })
}

async function outputOf(profile: ScratchProfile, workspace_id: string, run_id: string): Promise<string> {
  return logText((await inspect(profile, workspace_id, run_id)).output)
}

test('workspace package scripts are discovered, run under the workspace, inspected and stopped', async ({
  ade,
  profile,
}) => {
  const root = await folder(ade, 'project')
  const workspace_id = (await profile.call('workspace.open', { path: root })).workspace.id
  const other = (await profile.call('workspace.open', { path: await folder(ade, 'project/other') })).workspace.id
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ade-script-e2e',
      private: true,
      scripts: {
        hello:
          "node -e \"require('fs').writeFileSync('script-output.txt',process.cwd()); console.log('ADE_SCRIPT_DONE')\"",
        long: 'node -e "console.log(\'ADE_SCRIPT_READY\'); setInterval(()=>{},1000)"',
        '.helper': 'echo hidden',
      },
    }),
  )
  // A dot-named package script is hidden; another workspace has none.
  expect((await profile.call('script.list', { workspace_id })).scripts.map((script) => script.name)).toEqual([
    'hello',
    'long',
  ])
  expect((await profile.call('script.list', { workspace_id: other })).scripts).toEqual([])
  await expect(profile.call('script.start', { workspace_id, name: 'missing' })).rejects.toThrow(/not configured/)

  const started = await profile.call('script.start', { workspace_id, name: 'hello' })
  expect(started.state).toBe((started.metrics as { shell_running: boolean }).shell_running ? 'running' : 'exited')
  const runId = started.run_id
  await expect.poll(async () => (await inspect(profile, workspace_id, runId)).state).toBe('exited')
  expect(await outputOf(profile, workspace_id, runId)).toContain('ADE_SCRIPT_DONE')
  expect(await readFile(join(root, 'script-output.txt'), 'utf8')).toBe(root)
  await expect(inspect(profile, other, runId)).rejects.toThrow(/unavailable/)

  const longId = (await profile.call('script.start', { workspace_id, name: 'long' })).run_id
  await expect.poll(() => outputOf(profile, workspace_id, longId)).toContain('ADE_SCRIPT_READY')
  expect((await profile.call('script.runs', { workspace_id })).runs.map((run) => run.run_id)).toEqual(
    expect.arrayContaining([runId, longId]),
  )
  await expect(profile.call('script.retire', { workspace_id, run_id: longId })).rejects.toThrow(/Stop the script/)
  expect((await profile.call('script.stop', { workspace_id, run_id: longId })).state).toBe('exited')
  expect((await inspect(profile, workspace_id, longId)).state).toBe('exited')
  await profile.call('script.retire', { workspace_id, run_id: longId })
  await expect(inspect(profile, workspace_id, longId)).rejects.toThrow(/unavailable/)
})

test('checked-in ADE recipes run explicit argv and report success, nonzero exit and signaled stop', async ({
  ade,
  profile,
}) => {
  const root = await folder(ade, 'project')
  const outside = await folder(ade, 'outside')
  const subdirectory = await folder(ade, 'project/work')
  await writeFile(join(subdirectory, 'runner.sh'), '#!/bin/sh\nprintf "ADE_RELATIVE_%s\\n" "$1"\n')
  await chmod(join(subdirectory, 'runner.sh'), 0o755)
  const workspace_id = (await profile.call('workspace.open', { path: root })).workspace.id
  const manifest = await recipes(root, {
    success: {
      program: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("receipt", process.cwd()); console.log("ADE_RECIPE_OK")'],
      cwd: 'work',
    },
    failure: { program: process.execPath, args: ['-e', 'process.exit(23)'] },
    relative: { program: './runner.sh', args: ['ARGV'], cwd: 'work' },
    hold: { program: process.execPath, args: ['-e', 'console.log("ADE_RECIPE_HOLD"); setInterval(()=>{},1000)'] },
  })
  const listed = await profile.call('script.list', { workspace_id })
  expect(listed.scripts.map((script) => [script.name, script.kind])).toEqual([
    ['failure', 'ade_recipe'],
    ['hold', 'ade_recipe'],
    ['relative', 'ade_recipe'],
    ['success', 'ade_recipe'],
  ])
  const exitOf = async (run_id: string) => (await inspect(profile, workspace_id, run_id)).exit_status

  const successId = (await profile.call('script.start', { workspace_id, name: 'success' })).run_id
  await expect.poll(() => exitOf(successId)).toMatchObject({ kind: 'success', code: 0 })
  const succeeded = await inspect(profile, workspace_id, successId)
  expect(succeeded.state).toBe('exited')
  expect(succeeded.output_coverage).toMatchObject({ status: 'complete', reason: null })
  expect(logText(succeeded.output)).toContain('ADE_RECIPE_OK')
  expect(await readFile(join(subdirectory, 'receipt'), 'utf8')).toBe(subdirectory)

  // A relative program resolves against the recipe's directory and gets its argv.
  const relativeId = (await profile.call('script.start', { workspace_id, name: 'relative' })).run_id
  await expect.poll(() => exitOf(relativeId)).toMatchObject({ kind: 'success', code: 0 })
  expect(await outputOf(profile, workspace_id, relativeId)).toContain('ADE_RELATIVE_ARGV')

  const failureId = (await profile.call('script.start', { workspace_id, name: 'failure' })).run_id
  await expect.poll(() => exitOf(failureId)).toMatchObject({ kind: 'failure', code: 23 })
  const holdId = (await profile.call('script.start', { workspace_id, name: 'hold' })).run_id
  await expect.poll(async () => (await inspect(profile, workspace_id, holdId)).state).toBe('running')
  const stopped = await profile.call('script.stop', { workspace_id, run_id: holdId })
  expect(stopped.state).toBe('exited')
  expect(stopped.exit_status).toMatchObject({ kind: 'signaled' })
  expect((stopped.exit_status as { signal: string }).signal).toBeTruthy()

  // A package script with a recipe's name is a conflict, not a silent choice.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'ade-duplicate', scripts: { success: 'echo duplicate' } }),
  )
  await expect(profile.call('script.list', { workspace_id })).rejects.toThrow(/Duplicate workspace script name/)
  await unlink(join(root, 'package.json'))
  // A cwd that leaves the workspace through a link is refused.
  await symlink(outside, join(subdirectory, 'escape'))
  await writeFile(
    manifest,
    JSON.stringify({ schema_version: 1, scripts: { escape: { program: process.execPath, cwd: 'work/escape' } } }),
  )
  await expect(profile.call('script.list', { workspace_id })).rejects.toThrow(/directory escapes its workspace/)
  for (const run_id of [successId, failureId, relativeId, holdId]) {
    await profile.call('script.retire', { workspace_id, run_id })
  }
})

test('two profile daemons isolate runs in the same physical checkout', async ({ ade }) => {
  const checkout = await folder(ade, 'shared')
  await recipes(checkout, {
    hold: {
      program: process.execPath,
      args: ['-e', 'console.log("PROFILE_SCRIPT_READY"); setInterval(()=>{},1000)'],
    },
  })
  const first = await ade.profile()
  const second = await ade.profile()
  const one = (await first.call('workspace.open', { path: checkout })).workspace.id
  const two = (await second.call('workspace.open', { path: checkout })).workspace.id
  expect(one).not.toBe(two)
  const left = await first.call('script.start', { workspace_id: one, name: 'hold' })
  const right = await second.call('script.start', { workspace_id: two, name: 'hold' })
  expect(left.run_id).not.toBe(right.run_id)
  await expect(inspect(second, two, left.run_id)).rejects.toThrow(/unavailable/)
  const stopped = await second.call('script.stop', { workspace_id: two, run_id: right.run_id })
  expect(stopped.exit_status).toMatchObject({ kind: 'signaled' })
  expect((await inspect(first, one, left.run_id)).state).toBe('running')
  await first.call('script.stop', { workspace_id: one, run_id: left.run_id })
  await first.call('script.retire', { workspace_id: one, run_id: left.run_id })
  await second.call('script.retire', { workspace_id: two, run_id: right.run_id })
})

test('a monorepo child inherits the real installed npm and Node versions under a Finder launch PATH', async ({
  ade,
}) => {
  const nodeVersion = process.version.slice(1)
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  const root = await folder(ade, 'monorepo')
  const child = await folder(ade, 'monorepo/packages/app')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      workspaces: ['packages/*'],
      packageManager: `npm@${npmVersion}`,
      engines: { node: `>=${nodeVersion}` },
    }),
  )
  await writeFile(join(root, '.node-version'), `${nodeVersion}\n`)
  await writeFile(
    join(child, 'package.json'),
    JSON.stringify({
      name: 'ade-project-app',
      private: true,
      scripts: { hello: 'node -e "console.log(\'ADE_PROJECT_TOOLCHAIN\', process.version)"' },
    }),
  )
  // A Finder launch gives the daemon no useful PATH; ADE finds the installed tools itself.
  const profile = await ade.profile({
    env: { PATH: '/no-system-tools', ADE_PROJECT_TOOL_PATHS: installedToolDirectory('node') },
  })
  const workspace_id = (await profile.call('workspace.open', { path: child })).workspace.id
  const started = await profile.call('script.start', { workspace_id, name: 'hello' })
  expect(started.toolchain).toMatchObject({
    manager: 'npm',
    manager_version: npmVersion,
    node: { version: nodeVersion },
  })
  await expect
    .poll(() => outputOf(profile, workspace_id, started.run_id))
    .toContain(`ADE_PROJECT_TOOLCHAIN ${process.version}`)

  await writeFile(
    join(child, 'package.json'),
    JSON.stringify({
      name: 'ade-project-app',
      private: true,
      packageManager: 'pnpm@12.1.0',
      scripts: { hello: 'echo wrong' },
    }),
  )
  await expect(profile.call('script.start', { workspace_id, name: 'hello' })).rejects.toThrow(
    /Conflicting packageManager/,
  )
})

test('declared pnpm, Bun and Yarn versions run with the installed project tools', async ({ ade }) => {
  const project = await folder(ade, 'project')
  const shims = await folder(ade, 'corepack-shims')
  execFileSync('corepack', ['enable', '--install-directory', shims])
  // Corepack runs offline from a scratch copy of the host's package cache.
  const corepackHome = join(ade.root, 'corepack-home')
  await cp(process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'), corepackHome, { recursive: true })
  const corepack = { COREPACK_HOME: corepackHome, COREPACK_ENABLE_NETWORK: '0' }
  const versions = [
    ['pnpm', execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()],
    ['bun', execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()],
    [
      'yarn',
      execFileSync('corepack', ['yarn', '--version'], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, ...corepack },
      }).trim(),
    ],
  ] as const
  const toolPaths = [shims, ...['pnpm', 'bun', 'node'].map(installedToolDirectory)].join(':')
  const profile = await ade.profile({
    env: { PATH: '/no-system-tools', ADE_PROJECT_TOOL_PATHS: toolPaths, ...corepack },
  })
  const workspace_id = (await profile.call('workspace.open', { path: project })).workspace.id
  for (const [manager, version] of versions) {
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
      await unlink(join(project, name)).catch(() => undefined)
    }
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'ade-project-tool-test',
        private: true,
        packageManager: `${manager}@${version}`,
        scripts: { hello: `node -e "console.log('ADE_${manager.toUpperCase()}_READY')"` },
      }),
    )
    const started = await profile.call('script.start', { workspace_id, name: 'hello' })
    expect(started.toolchain).toMatchObject({ manager, manager_version: version, version })
    await expect
      .poll(() => outputOf(profile, workspace_id, started.run_id))
      .toContain(`ADE_${manager.toUpperCase()}_READY`)
  }
})

test('a saturated script spool reports incomplete output without changing the verified exit', async ({
  ade,
  profile,
}) => {
  const root = await folder(ade, 'project')
  await recipes(root, {
    flood: {
      program: process.execPath,
      args: ['-e', 'process.stdout.write("A".repeat(1300000) + "ADE_SPOOL_END\\n")'],
    },
  })
  const workspace_id = (await profile.call('workspace.open', { path: root })).workspace.id
  const runId = (await profile.call('script.start', { workspace_id, name: 'flood' })).run_id
  await expect
    .poll(async () => (await inspect(profile, workspace_id, runId)).exit_status)
    .toMatchObject({ kind: 'success', code: 0 })
  const inspected = await inspect(profile, workspace_id, runId)
  expect(inspected.state).toBe('exited')
  expect(inspected.output_coverage).toMatchObject({ status: 'incomplete', reason: 'retention_overflow' })
  expect((inspected.output_coverage as { produced_bytes: number }).produced_bytes).toBeGreaterThan(1_048_576)
  expect(inspected.durable_output).toMatchObject({ available: true, retention_overflow: true })
  expect((inspected.durable_output as { retained_start_offset: number }).retained_start_offset).toBeGreaterThan(0)
  expect((inspected.output as { retention_overflow: boolean }).retention_overflow).toBe(true)
  expect((inspected.output as { retained_start_offset: number }).retained_start_offset).toBeGreaterThan(0)
  expect(logText(inspected.durable_output)).toContain('ADE_SPOOL_END')
  expect((await profile.call('script.stop', { workspace_id, run_id: runId })).exit_status).toMatchObject({
    kind: 'success',
    code: 0,
  })
  await profile.call('script.retire', { workspace_id, run_id: runId })
  await expect(inspect(profile, workspace_id, runId)).rejects.toThrow(/unavailable/)
})

test('running and exited script runs survive daemon handoff with their output and stop controls', async ({
  ade,
  profile,
}) => {
  const root = await folder(ade, 'project')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ade-handoff',
      private: true,
      scripts: {
        quick: 'node -e "console.log(\'QUICK_DONE\')"',
        hold: 'node -e "console.log(\'HOLD_READY\');setInterval(()=>{},1000)"',
      },
    }),
  )
  const workspace_id = (await profile.call('workspace.open', { path: root })).workspace.id
  const quickId = (await profile.call('script.start', { workspace_id, name: 'quick' })).run_id
  const holdId = (await profile.call('script.start', { workspace_id, name: 'hold' })).run_id
  await expect.poll(async () => (await inspect(profile, workspace_id, quickId)).state).toBe('exited')
  await expect.poll(() => outputOf(profile, workspace_id, holdId)).toContain('HOLD_READY')
  const runtimeInstance = profile.hello.runtime_instance

  const hello = await profile.restartDaemon('graceful')
  expect(hello.runtime_instance).toBe(runtimeInstance)
  expect((await profile.call('script.runs', { workspace_id })).runs.map((run) => run.run_id)).toEqual(
    expect.arrayContaining([quickId, holdId]),
  )
  const quickAfter = await inspect(profile, workspace_id, quickId)
  expect(quickAfter.state).toBe('exited')
  expect(logText(quickAfter.output)).toContain('QUICK_DONE')
  expect((await inspect(profile, workspace_id, holdId)).state).toBe('running')
  expect((await profile.call('script.stop', { workspace_id, run_id: holdId })).state).toBe('exited')
  await profile.call('script.retire', { workspace_id, run_id: quickId })
  await profile.call('script.retire', { workspace_id, run_id: holdId })
})

test('a daemon crash between runtime and catalogue retirement reconciles an exited script', async ({ ade }) => {
  const root = await folder(ade, 'project')
  const gate = join(ade.root, 'retire-entered')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ade-retire',
      private: true,
      scripts: { quick: 'node -e "console.log(\'RETIRE_READY\')"' },
    }),
  )
  const profile = await ade.profile({ env: { ADE_E2E_SCRIPT_RETIRE_GATE: gate } })
  const workspace_id = (await profile.call('workspace.open', { path: root })).workspace.id
  const runId = (await profile.call('script.start', { workspace_id, name: 'quick' })).run_id
  await expect.poll(async () => (await inspect(profile, workspace_id, runId)).state).toBe('exited')
  const runtimeInstance = profile.hello.runtime_instance

  // The daemon enters retirement, records the gate and waits; the crash cuts the reply.
  void profile
    .rpc({ op: 'script.retire', operation_id: 'retire-crash', workspace_id, run_id: runId })
    .catch(() => undefined)
  await expect.poll(() => readFile(gate, 'utf8').catch(() => '')).toBe(runId)
  const hello = await profile.restartDaemon('kill')
  expect(hello.runtime_instance).toBe(runtimeInstance)
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.terminals.map((terminal) => terminal.id)).not.toContain(runId)
  expect((await profile.call('script.runs', { workspace_id })).runs).toEqual([])
  await expect(inspect(profile, workspace_id, runId)).rejects.toThrow(/unavailable/)
})
