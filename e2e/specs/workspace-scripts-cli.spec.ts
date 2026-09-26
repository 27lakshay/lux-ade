import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function command(socket: string, ...words: string[]): Promise<{ code: number; value: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...words], { timeout: 12_000 })
    return { code: 0, value: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, value: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('named CLI script commands share a supervised workspace run', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    await writeFile(resolve(daemon.rootDirectory, 'package.json'), JSON.stringify({
      name: 'ade-script-cli-e2e', private: true,
      scripts: { serve: 'node -e "console.log(\'CLI_SCRIPT_READY\'); setInterval(()=>{},1000)"' },
    }))
    const listed = await command(daemon.socket, 'script', 'list', workspace.id)
    expect(listed).toMatchObject({ code: 0, value: { type: 'scripts', scripts: [{ name: 'serve' }] } })
    expect(await command(daemon.socket, 'script', 'start', workspace.id))
      .toMatchObject({ code: 2, value: { code: 'usage' } })

    const started = await command(daemon.socket, 'script', 'start', workspace.id, 'serve')
    expect(started).toMatchObject({ code: 0, value: { type: 'script_run', state: 'running' } })
    const runId = started.value.run_id as string
    await expect.poll(async () => {
      const inspected = await command(daemon.socket, 'script', 'inspect', workspace.id, runId, '1024')
      expect(inspected.code).toBe(0)
      return Buffer.from((inspected.value.output as { bytes_base64: string }).bytes_base64, 'base64').toString()
    }).toContain('CLI_SCRIPT_READY')
    const runs = await command(daemon.socket, 'script', 'runs', workspace.id)
    expect((runs.value.runs as { run_id: string }[]).map((run) => run.run_id)).toContain(runId)
    const stopped = await command(daemon.socket, 'script', 'stop', workspace.id, runId)
    expect(stopped).toMatchObject({ code: 0, value: { state: 'exited' } })
    const retired = await command(daemon.socket, 'script', 'retire', workspace.id, runId)
    expect(retired).toMatchObject({ code: 0, value: { type: 'ack', run_id: runId } })
  } finally {
    await daemon.stop()
  }
})
