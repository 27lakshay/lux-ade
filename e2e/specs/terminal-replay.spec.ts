import { expect, test } from '@playwright/test'
import { createConnection, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

type Frame = Record<string, unknown> & { type?: string }

function terminalStream(socketPath: string, workspaceId: string): {
  send: (value: Record<string, unknown>) => void
  next: (type: string) => Promise<Frame>
  close: () => void
} {
  const socket = createConnection(socketPath)
  let buffer = ''
  const frames: Frame[] = []
  const waiters: Array<() => void> = []
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      frames.push(JSON.parse(buffer.slice(0, end)) as Frame)
      buffer = buffer.slice(end + 1)
      for (const wake of waiters.splice(0)) wake()
    }
  })
  return {
    send: (value) => socket.write(`${JSON.stringify({ workspace_id: workspaceId, ...value })}\n`),
    next: async (type) => {
      const deadline = Date.now() + 5_000
      for (;;) {
        const index = frames.findIndex((frame) => frame.type === type)
        if (index >= 0) return frames.splice(index, 1)[0]
        if (Date.now() >= deadline || socket.destroyed) throw new Error(`Terminal stream ended before ${type}`)
        await new Promise<void>((resolveWake) => {
          const timer = setTimeout(resolveWake, 100)
          waiters.push(() => { clearTimeout(timer); resolveWake() })
        })
      }
    },
    close: () => socket.destroy(),
  }
}

test('replays real PTY output and resize events after detaching a viewer', async () => {
  const daemon = await startDaemon()
  try {
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const first = terminalStream(daemon.socket, workspace.id)
    try {
      first.send({ op: 'subscribe', snapshot_format: 'xterm-replay-v1' })
      const initial = await first.next('snapshot')
      expect(initial.terminal_snapshot_format).toBe('xterm-replay-v1')
      first.send({ op: 'resize', cols: 82, rows: 23, claim: true })
      await first.next('terminal_resize')
      first.send({ op: 'input', data: "printf '__ADE_REPLAY_MARKER__\\n'\n" })
      for (;;) {
        const output = await first.next('terminal')
        if (JSON.stringify(output).includes('__ADE_REPLAY_MARKER__')) break
      }
    } finally {
      first.close()
    }

    const second = terminalStream(daemon.socket, workspace.id)
    try {
      second.send({ op: 'subscribe', snapshot_format: 'xterm-replay-v1' })
      const snapshot = await second.next('snapshot')
      const recovery = snapshot.terminal_recovery as {
        complete: boolean
        through_offset: number
        events: Array<{ type: string; cols?: number; rows?: number; bytes_base64?: string }>
      }
      expect(recovery.complete).toBe(true)
      expect(recovery.events.some((event) => event.type === 'resize' && event.cols === 82 && event.rows === 23)).toBe(true)
      const output = recovery.events.filter((event) => event.type === 'output')
        .map((event) => Buffer.from(event.bytes_base64 ?? '', 'base64').toString('utf8')).join('')
      expect(output).toContain('__ADE_REPLAY_MARKER__')
      expect(recovery.through_offset).toBeGreaterThan(0)
    } finally {
      second.close()
    }
  } finally {
    await daemon.stop()
  }
})

test('reports incomplete recovery after the bounded replay window fills', async () => {
  const daemon = await startDaemon()
  try {
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalog.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]
    const writer = terminalStream(daemon.socket, workspace.id)
    writer.send({ op: 'input', data: "python3 -c 'import sys; sys.stdout.write(\"X\" * 4500000)'\n" })

    let bytes = 0
    let shellRunning = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await rpc(daemon.socket, { op: 'runtime.status' })
      const terminal = (status.terminals as Array<{ metrics: { terminal_bytes: number; shell_running: boolean } }>)[0]
      bytes = terminal.metrics.terminal_bytes
      shellRunning = terminal.metrics.shell_running
      if (bytes > 4 * 1024 * 1024) break
      await delay(100)
    }
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(shellRunning).toBe(true)
    writer.close()

    const viewer = terminalStream(daemon.socket, workspace.id)
    try {
      viewer.send({ op: 'subscribe', snapshot_format: 'xterm-replay-v1' })
      const snapshot = await viewer.next('snapshot')
      const recovery = snapshot.terminal_recovery as { complete: boolean; reason: string; events: unknown[] }
      expect(recovery.complete).toBe(false)
      expect(recovery.reason).toBe('replay_limit_exceeded')
      expect(recovery.events).toEqual([])
    } finally {
      viewer.close()
    }
  } finally {
    await daemon.stop()
  }
})
