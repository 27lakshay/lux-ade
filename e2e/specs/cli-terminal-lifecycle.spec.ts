import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function runCli(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('CLI creates, stops and retires only the selected workspace terminal', async () => {
  const daemon = await startDaemon()
  try {
    const catalogue = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalogue.catalog as { workspaces: Array<{ id: string; terminal_id: string }> }).workspaces[0]
    const primary = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(primary.code).toBe(0)
    const primaryPid = (primary.output.metrics as { shell_pid: number }).shell_pid

    const requestId = 'cli-terminal-create-lost-reply'
    await new Promise<void>((resolveSent, rejectSent) => {
      const peer = createConnection(daemon.socket)
      peer.once('error', rejectSent)
      peer.once('connect', () => {
        peer.end(`${JSON.stringify({ op: 'terminal.create', workspace_id: workspace.id, request_id: requestId })}\n`)
        resolveSent()
      })
    })
    await expect.poll(async () => (await runCli(daemon.socket, 'terminal', 'operation', workspace.id, requestId)).code)
      .toBe(0)
    const created = await runCli(daemon.socket, 'terminal', 'create', workspace.id, '--request-id', requestId)
    expect(created).toMatchObject({ code: 0, output: { type: 'ack' } })
    const terminalId = created.output.terminal_id as string
    expect(terminalId).toBeTruthy()
    expect(terminalId).not.toBe(workspace.terminal_id)
    expect((await runCli(daemon.socket, 'terminal', 'operation', workspace.id, requestId)).output)
      .toMatchObject({ terminal_id: terminalId, request_id: requestId })
    expect((await runCli(daemon.socket, 'terminal', 'create', workspace.id, '--request-id', requestId)).output.terminal_id)
      .toBe(terminalId)
    expect((await runCli(daemon.socket, 'terminal', 'create', 'unrelated-workspace', '--request-id', requestId)).code)
      .not.toBe(0)
    const listed = await runCli(daemon.socket, 'terminal', 'list')
    expect(listed.output.terminals).toEqual(expect.arrayContaining([
      { workspace_id: workspace.id, terminal_id: workspace.terminal_id },
      { workspace_id: workspace.id, terminal_id: terminalId },
    ]))

    const inspected = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, terminalId)
    expect(inspected.code).toBe(0)
    const shellPid = (inspected.output.metrics as { shell_pid: number }).shell_pid
    expect(shellPid).toBeGreaterThan(0)
    expect(shellPid).not.toBe(primaryPid)
    const sent = await runCli(daemon.socket, 'terminal', 'send', workspace.id, terminalId,
      "printf '%s%s\\n' '__ADE_SECOND_' 'EXECUTED__'")
    expect(sent.output.type).toBe('terminal_input_submitted')
    await expect.poll(async () => {
      const snapshot = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, terminalId)
      const events = (snapshot.output.terminal_recovery as { events: Array<{ type: string; bytes_base64?: string }> }).events
      return events.filter((event) => event.type === 'output' && event.bytes_base64)
        .map((event) => Buffer.from(event.bytes_base64!, 'base64').toString('utf8')).join('')
    }).toContain('__ADE_SECOND_EXECUTED__')

    const premature = await runCli(daemon.socket, 'terminal', 'retire', workspace.id, terminalId)
    expect(premature.code).not.toBe(0)
    expect((await runCli(daemon.socket, 'terminal', 'list')).output.terminals)
      .toEqual(expect.arrayContaining([{ workspace_id: workspace.id, terminal_id: terminalId }]))
    const wrongTarget = await runCli(daemon.socket, 'terminal', 'stop', 'unrelated-workspace', terminalId)
    expect(wrongTarget.code).not.toBe(0)
    expect((await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, terminalId)).output.metrics)
      .toMatchObject({ shell_pid: shellPid, shell_running: true })

    expect(await runCli(daemon.socket, 'terminal', 'stop', workspace.id, terminalId))
      .toMatchObject({ code: 0, output: { type: 'ack' } })
    await expect.poll(async () => {
      const runtime = await rpc(daemon.socket, { op: 'runtime.status' })
      const terminals = runtime.terminals as Array<{ metrics: { terminal_id: string; shell_running: boolean } }>
      return terminals.find((item) => item.metrics.terminal_id === terminalId)?.metrics.shell_running
    }).toBe(false)
    const runtime = await rpc(daemon.socket, { op: 'runtime.status' })
    const terminals = runtime.terminals as Array<{ metrics: { terminal_id: string; shell_pid: number; shell_running: boolean } }>
    expect(terminals.find((item) => item.metrics.terminal_id === workspace.terminal_id)?.metrics)
      .toMatchObject({ shell_pid: primaryPid, shell_running: true })

    expect(await runCli(daemon.socket, 'terminal', 'retire', workspace.id, terminalId))
      .toMatchObject({ code: 0, output: { type: 'ack' } })
    const remaining = await runCli(daemon.socket, 'terminal', 'list')
    expect(remaining.output.terminals).toEqual([{ workspace_id: workspace.id, terminal_id: workspace.terminal_id }])
    expect((await runCli(daemon.socket, 'terminal', 'stop', workspace.id, terminalId)).code).not.toBe(0)
  } finally {
    await daemon.stop()
  }
})
