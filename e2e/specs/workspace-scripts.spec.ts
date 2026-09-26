import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

test('workspace package scripts are discovered, run under the workspace, inspected and stopped', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const second = join(daemon.rootDirectory, 'other')
    await mkdir(second)
    const other = (await rpc(daemon.socket, { op: 'workspace.open', path: second }))
      .workspace as { id: string }
    await writeFile(join(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-script-e2e', private: true,
      scripts: {
        hello: 'node -e "require(\'fs\').writeFileSync(\'script-output.txt\',process.cwd()); console.log(\'ADE_SCRIPT_DONE\')"',
        long: 'node -e "console.log(\'ADE_SCRIPT_READY\'); setInterval(()=>{},1000)"',
        '.helper': 'echo hidden',
      },
    }))
    const listed = await rpc(daemon.socket, { op: 'script.list', workspace_id: workspace.id })
    expect((listed.scripts as Array<{ name: string }>).map((script) => script.name)).toEqual(['hello', 'long'])
    expect((await rpc(daemon.socket, { op: 'script.list', workspace_id: other.id })).scripts).toEqual([])
    await expect(rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id, name: 'missing' }))
      .rejects.toThrow(/not configured/)

    const started = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id, name: 'hello' })
    expect(started.state).toBe((started.metrics as { shell_running: boolean }).shell_running
      ? 'running' : 'exited')
    const runId = started.run_id as string
    await expect.poll(async () => {
      const inspected = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
        run_id: runId })
      return inspected.state
    }).toBe('exited')
    const output = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: runId })
    expect(Buffer.from((output.output as { bytes_base64: string }).bytes_base64, 'base64').toString())
      .toContain('ADE_SCRIPT_DONE')
    expect(await readFile(join(daemon.rootDirectory, 'script-output.txt'), 'utf8'))
      .toBe(await realpath(daemon.rootDirectory))
    await expect(rpc(daemon.socket, { op: 'script.inspect', workspace_id: other.id, run_id: runId }))
      .rejects.toThrow(/unavailable/)

    const running = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id, name: 'long' })
    const longId = running.run_id as string
    await expect.poll(async () => {
      const inspected = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
        run_id: longId })
      return Buffer.from((inspected.output as { bytes_base64: string }).bytes_base64, 'base64').toString()
    }).toContain('ADE_SCRIPT_READY')
    const runs = await rpc(daemon.socket, { op: 'script.runs', workspace_id: workspace.id })
    expect((runs.runs as Array<{ run_id: string }>).map((run) => run.run_id))
      .toEqual(expect.arrayContaining([runId, longId]))
    await expect(rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id,
      run_id: longId })).rejects.toThrow(/Stop the script/)
    const stopped = await rpc(daemon.socket, { op: 'script.stop', workspace_id: workspace.id,
      run_id: longId })
    expect(stopped.state).toBe('exited')
    expect((await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: longId })).state).toBe('exited')
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id, run_id: longId })
    await expect(rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: longId })).rejects.toThrow(/unavailable/)
  } finally {
    await daemon.stop()
  }
})

test('checked-in ADE recipes run explicit argv and report success, nonzero exit and signaled stop', async () => {
  const daemon = await startDaemon()
  const outside = await mkdtemp(join(tmpdir(), 'ade-script-escape-'))
  try {
    const subdirectory = join(daemon.rootDirectory, 'work')
    const manifestDirectory = join(daemon.rootDirectory, '.ade')
    await mkdir(subdirectory)
    await mkdir(manifestDirectory)
    await writeFile(join(subdirectory, 'runner.sh'), '#!/bin/sh\nprintf "ADE_RELATIVE_%s\\n" "$1"\n')
    await chmod(join(subdirectory, 'runner.sh'), 0o755)
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const recipes = { schema_version: 1, scripts: {
      success: { program: process.execPath, args: ['-e',
        'require("fs").writeFileSync("receipt", process.cwd()); console.log("ADE_RECIPE_OK")'], cwd: 'work' },
      failure: { program: process.execPath, args: ['-e', 'process.exit(23)'] },
      relative: { program: './runner.sh', args: ['ARGV'], cwd: 'work' },
      hold: { program: process.execPath, args: ['-e',
        'console.log("ADE_RECIPE_HOLD"); setInterval(()=>{},1000)'] },
    } }
    const manifest = join(manifestDirectory, 'scripts.json')
    await writeFile(manifest, JSON.stringify(recipes))
    const listed = await rpc(daemon.socket, { op: 'script.list', workspace_id: workspace.id })
    expect((listed.scripts as Array<{ name: string; kind: string }>).map((script) => [script.name, script.kind]))
      .toEqual([['failure', 'ade_recipe'], ['hold', 'ade_recipe'],
        ['relative', 'ade_recipe'], ['success', 'ade_recipe']])
    const success = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'success' })
    const successId = success.run_id as string
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'script.inspect',
      workspace_id: workspace.id, run_id: successId })).exit_status).toEqual({ kind: 'success', code: 0 })
    const succeeded = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: successId })
    expect(succeeded.state).toBe('exited')
    expect(succeeded.output_coverage).toMatchObject({ status: 'complete', reason: null })
    expect(Buffer.from((succeeded.output as { bytes_base64: string }).bytes_base64, 'base64').toString())
      .toContain('ADE_RECIPE_OK')
    expect(await readFile(join(subdirectory, 'receipt'), 'utf8')).toBe(await realpath(subdirectory))
    const relative = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'relative' })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'script.inspect',
      workspace_id: workspace.id, run_id: relative.run_id })).exit_status)
      .toEqual({ kind: 'success', code: 0 })
    const relativeOutput = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: relative.run_id })
    expect(Buffer.from((relativeOutput.output as { bytes_base64: string }).bytes_base64, 'base64').toString())
      .toContain('ADE_RELATIVE_ARGV')

    const failure = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'failure' })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'script.inspect',
      workspace_id: workspace.id, run_id: failure.run_id })).exit_status)
      .toEqual({ kind: 'failure', code: 23 })
    const hold = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'hold' })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'script.inspect',
      workspace_id: workspace.id, run_id: hold.run_id })).state).toBe('running')
    const stopped = await rpc(daemon.socket, { op: 'script.stop', workspace_id: workspace.id,
      run_id: hold.run_id })
    expect(stopped.state).toBe('exited')
    expect(stopped.exit_status).toMatchObject({ kind: 'signaled' })
    expect((stopped.exit_status as { signal: string }).signal).toBeTruthy()

    await writeFile(join(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-duplicate', scripts: { success: 'echo duplicate' },
    }))
    await expect(rpc(daemon.socket, { op: 'script.list', workspace_id: workspace.id }))
      .rejects.toThrow(/Duplicate workspace script name/)
    await unlink(join(daemon.rootDirectory, 'package.json'))
    await symlink(outside, join(subdirectory, 'escape'))
    await writeFile(manifest, JSON.stringify({ schema_version: 1, scripts: {
      escape: { program: process.execPath, cwd: 'work/escape' },
    } }))
    await expect(rpc(daemon.socket, { op: 'script.list', workspace_id: workspace.id }))
      .rejects.toThrow(/directory escapes its workspace/)
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id, run_id: successId })
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id,
      run_id: failure.run_id })
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id,
      run_id: relative.run_id })
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id,
      run_id: hold.run_id })
  } finally {
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})

test('two profile daemons isolate runs in the same physical checkout', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'ade-script-shared-'))
  await mkdir(join(checkout, '.ade'))
  await writeFile(join(checkout, '.ade', 'scripts.json'), JSON.stringify({ schema_version: 1,
    scripts: { hold: { program: process.execPath, args: ['-e',
      'console.log("PROFILE_SCRIPT_READY"); setInterval(()=>{},1000)'] } },
  }))
  const first = await startDaemon()
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    second = await startDaemon()
    const one = (await rpc(first.socket, { op: 'workspace.open', path: checkout }))
      .workspace as { id: string }
    const two = (await rpc(second.socket, { op: 'workspace.open', path: checkout }))
      .workspace as { id: string }
    expect(one.id).not.toBe(two.id)
    const left = await rpc(first.socket, { op: 'script.start', workspace_id: one.id, name: 'hold' })
    const right = await rpc(second.socket, { op: 'script.start', workspace_id: two.id, name: 'hold' })
    expect(left.run_id).not.toBe(right.run_id)
    await expect(rpc(second.socket, { op: 'script.inspect', workspace_id: two.id,
      run_id: left.run_id })).rejects.toThrow(/unavailable/)
    const stopped = await rpc(second.socket, { op: 'script.stop', workspace_id: two.id,
      run_id: right.run_id })
    expect(stopped.exit_status).toMatchObject({ kind: 'signaled' })
    expect((await rpc(first.socket, { op: 'script.inspect', workspace_id: one.id,
      run_id: left.run_id })).state).toBe('running')
    await rpc(first.socket, { op: 'script.stop', workspace_id: one.id, run_id: left.run_id })
    await rpc(first.socket, { op: 'script.retire', workspace_id: one.id, run_id: left.run_id })
    await rpc(second.socket, { op: 'script.retire', workspace_id: two.id, run_id: right.run_id })
  } finally {
    await second?.stop()
    await first.stop()
    await rm(checkout, { recursive: true, force: true })
  }
})

test('a configured pnpm executable supplies its sibling node on a stripped launch PATH', async () => {
  const toolRoot = await mkdtemp(join(tmpdir(), 'ade-script-bin-'))
  const pnpmBin = join(toolRoot, 'pnpm')
  const nodeBin = join(toolRoot, 'node')
  await writeFile(pnpmBin, '#!/bin/sh\nexec node -e "console.log(\'ADE_BUNDLED_PATH_READY\')"\n')
  await writeFile(nodeBin, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  await chmod(pnpmBin, 0o755)
  await chmod(nodeBin, 0o755)
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    daemon = await startDaemon({ ADE_PNPM_BIN: pnpmBin, PATH: '/no-system-tools' })
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    await writeFile(join(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-path-e2e', private: true, scripts: { hello: 'node -e "console.log(1)"' },
    }))
    const started = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'hello' })
    await expect.poll(async () => {
      const inspected = await rpc(daemon!.socket, { op: 'script.inspect', workspace_id: workspace.id,
        run_id: started.run_id })
      return Buffer.from((inspected.output as { bytes_base64: string }).bytes_base64, 'base64').toString()
    }).toContain('ADE_BUNDLED_PATH_READY')
  } finally {
    await daemon?.stop()
    await rm(toolRoot, { recursive: true, force: true })
  }
})

test('a saturated script spool reports incomplete output without changing the verified exit', async () => {
  const daemon = await startDaemon()
  try {
    await mkdir(join(daemon.rootDirectory, '.ade'))
    await writeFile(join(daemon.rootDirectory, '.ade', 'scripts.json'), JSON.stringify({
      schema_version: 1, scripts: { flood: { program: process.execPath, args: [
        '-e', 'process.stdout.write("A".repeat(1300000) + "ADE_SPOOL_END\\n")',
      ] } },
    }))
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const started = await rpc(daemon.socket, { op: 'script.start', workspace_id: workspace.id,
      name: 'flood' })
    const runId = started.run_id as string
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'script.inspect',
      workspace_id: workspace.id, run_id: runId })).exit_status)
      .toEqual({ kind: 'success', code: 0 })
    const inspected = await rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: runId })
    expect(inspected.state).toBe('exited')
    expect(inspected.output_coverage).toMatchObject({ status: 'incomplete', reason: 'retention_overflow' })
    expect((inspected.output_coverage as { produced_bytes: number }).produced_bytes).toBeGreaterThan(1_048_576)
    expect(inspected.durable_output).toMatchObject({ available: true, retention_overflow: true })
    expect((inspected.durable_output as { retained_start_offset: number }).retained_start_offset)
      .toBeGreaterThan(0)
    expect((inspected.output as { retention_overflow: boolean }).retention_overflow).toBe(true)
    expect((inspected.output as { retained_start_offset: number }).retained_start_offset).toBeGreaterThan(0)
    expect(Buffer.from((inspected.durable_output as { bytes_base64: string }).bytes_base64, 'base64').toString())
      .toContain('ADE_SPOOL_END')
    const stopped = await rpc(daemon.socket, { op: 'script.stop', workspace_id: workspace.id,
      run_id: runId })
    expect(stopped.exit_status).toEqual({ kind: 'success', code: 0 })
    await rpc(daemon.socket, { op: 'script.retire', workspace_id: workspace.id, run_id: runId })
    await expect(rpc(daemon.socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: runId })).rejects.toThrow(/unavailable/)
  } finally {
    await daemon.stop()
  }
})

test('running and exited script runs survive daemon handoff with their output and stop controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-script-handoff-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  await mkdir(dataDirectory)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ade-handoff', private: true,
    scripts: {
      quick: 'node -e "console.log(\'QUICK_DONE\')"',
      hold: 'node -e "console.log(\'HOLD_READY\');setInterval(()=>{},1000)"',
    },
  }))
  let child: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for the daemon socket. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const quick = await rpc(socket, { op: 'script.start', workspace_id: workspace.id, name: 'quick' })
    const hold = await rpc(socket, { op: 'script.start', workspace_id: workspace.id, name: 'hold' })
    const quickId = quick.run_id as string
    const holdId = hold.run_id as string
    await expect.poll(async () => (await rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: quickId })).state).toBe('exited')
    await expect.poll(async () => {
      const result = await rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
        run_id: holdId })
      return Buffer.from((result.output as { bytes_base64: string }).bytes_base64, 'base64').toString()
    }).toContain('HOLD_READY')
    const runtimeInstance = hello?.runtime_instance
    const original = child
    await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello?.boot_id })
    await expect.poll(() => original?.exitCode).not.toBeNull()
    await launch()
    expect(hello?.runtime_instance).toBe(runtimeInstance)
    const runs = await rpc(socket, { op: 'script.runs', workspace_id: workspace.id })
    expect((runs.runs as Array<{ run_id: string }>).map((run) => run.run_id))
      .toEqual(expect.arrayContaining([quickId, holdId]))
    const quickAfter = await rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: quickId })
    expect(quickAfter.state).toBe('exited')
    expect(Buffer.from((quickAfter.output as { bytes_base64: string }).bytes_base64, 'base64').toString())
      .toContain('QUICK_DONE')
    expect((await rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: holdId })).state).toBe('running')
    expect((await rpc(socket, { op: 'script.stop', workspace_id: workspace.id,
      run_id: holdId })).state).toBe('exited')
    await rpc(socket, { op: 'script.retire', workspace_id: workspace.id, run_id: quickId })
    await rpc(socket, { op: 'script.retire', workspace_id: workspace.id, run_id: holdId })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null && hello) {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => child?.once('exit', done))
    }
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true }).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('a daemon crash between runtime and catalogue retirement reconciles an exited script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-script-retire-'))
  const dataDirectory = join(root, 'data')
  const socket = join(root, 'daemon.sock')
  const gate = join(root, 'retire-entered')
  await mkdir(dataDirectory)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ade-retire', private: true,
    scripts: { quick: 'node -e "console.log(\'RETIRE_READY\')"' },
  }))
  let child: ChildProcess | undefined
  let hello: Record<string, unknown> | undefined
  const launch = async (): Promise<void> => {
    child = spawn(resolve('target/debug/ade-daemon'), [], { env: { ...process.env,
      ADE_DATA_DIR: dataDirectory, ADE_SOCKET: socket, ADE_ROOT: root, SHELL: '/bin/sh',
      ADE_E2E_SCRIPT_RETIRE_GATE: gate }, stdio: ['ignore', 'ignore', 'pipe'] })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        hello = await rpc(socket, { op: 'hello' })
        if (hello.type === 'hello') return
      } catch { /* Wait for the daemon socket. */ }
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${child.exitCode}`)
      await delay(50)
    }
    throw new Error('Daemon did not start')
  }
  try {
    await launch()
    const workspace = (await rpc(socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const run = await rpc(socket, { op: 'script.start', workspace_id: workspace.id, name: 'quick' })
    const runId = run.run_id as string
    await expect.poll(async () => (await rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: runId })).state).toBe('exited')
    const runtimeInstance = hello?.runtime_instance
    // The daemon socket closes mid-request on SIGKILL; the fixture's RPC
    // promise has no completion frame, so this fault injection does not await it.
    void rpc(socket, { op: 'script.retire', workspace_id: workspace.id,
      run_id: runId }).catch(() => undefined)
    await expect.poll(() => readFile(gate, 'utf8').catch(() => '')).toBe(runId)
    const crashed = child
    crashed?.kill('SIGKILL')
    await expect.poll(() => crashed?.exitCode ?? crashed?.signalCode).not.toBeNull()
    await launch()
    expect(hello?.runtime_instance).toBe(runtimeInstance)
    const catalog = await rpc(socket, { op: 'catalog.get' })
    const restored = (catalog.catalog as { workspaces: Array<{ id: string; extra_terminals: string[] }> })
      .workspaces.find((item) => item.id === workspace.id)
    expect(restored?.extra_terminals).not.toContain(runId)
    expect((await rpc(socket, { op: 'script.runs', workspace_id: workspace.id })).runs).toEqual([])
    await expect(rpc(socket, { op: 'script.inspect', workspace_id: workspace.id,
      run_id: runId })).rejects.toThrow(/unavailable/)
  } finally {
    await writeFile(join(root, 'retire-entered.release'), '').catch(() => undefined)
    if (child && child.exitCode === null && child.signalCode === null && hello) {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id }).catch(() => undefined)
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => child?.once('exit', done))
    }
    if (typeof hello?.runtime_socket === 'string') {
      await rpc(hello.runtime_socket, { op: 'runtime.stop', instance_id: hello.runtime_instance,
        stop_active: true }).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})
