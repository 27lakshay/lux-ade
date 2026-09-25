import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Reply = Record<string, unknown> & { type?: string; message?: string }

export async function rpc(socket: string, request: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const peer = createConnection(socket)
    let frame = ''
    const timer = setTimeout(() => peer.destroy(new Error('Daemon request timed out')), 5_000)
    peer.setEncoding('utf8')
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: string) => {
      frame += chunk
      if (frame.length > 128 * 1024) peer.destroy(new Error('Daemon reply is too large'))
      const end = frame.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      peer.destroy()
      try {
        const reply = JSON.parse(frame.slice(0, end)) as Reply
        if (reply.type === 'error') rejectReply(new Error(reply.message ?? 'Daemon error'))
        else resolveReply(reply)
      } catch (error) {
        rejectReply(error)
      }
    })
    peer.once('error', (error) => {
      clearTimeout(timer)
      rejectReply(error)
    })
    peer.once('close', () => clearTimeout(timer))
  })
}

export type RunningDaemon = {
  socket: string
  dataDirectory: string
  rootDirectory: string
  hello: Reply
  stop: () => Promise<void>
}

export async function startDaemon(extraEnvironment: Record<string, string> = {}): Promise<RunningDaemon> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'ade-e2e-'))
  const dataDirectory = join(rootDirectory, 'data')
  const socket = join(rootDirectory, 'daemon.sock')
  await mkdir(dataDirectory, { mode: 0o700 })
  const binary = resolve('target/debug/ade-daemon')
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      ADE_DATA_DIR: dataDirectory,
      ADE_SOCKET: socket,
      ADE_ROOT: rootDirectory,
      SHELL: '/bin/sh',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 8_192) })

  try {
    const hello = await waitForHello(socket, child, () => stderr)
    return {
      socket,
      dataDirectory,
      rootDirectory,
      hello,
      stop: async () => {
        try {
          await rpc(socket, { op: 'runtime.prepare_restart', boot_id: hello.boot_id })
          await waitForExit(child)
          const runtimeSocket = hello.runtime_socket
          if (typeof runtimeSocket === 'string') {
            await stopRuntime(runtimeSocket, hello.runtime_instance)
          }
        } finally {
          if (child.exitCode === null) child.kill()
          await waitForExit(child).catch(() => undefined)
          await rm(rootDirectory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    child.kill()
    await waitForExit(child).catch(() => undefined)
    const runtimeLog = await readFile(join(dataDirectory, 'runtime.log'), 'utf8').catch(() => '')
    await rm(rootDirectory, { recursive: true, force: true })
    throw new Error(`ADE daemon failed to start: ${String(error)}\n${stderr}\n${runtimeLog}`)
  }
}

async function waitForHello(socket: string, child: ChildProcess, diagnostics: () => string): Promise<Reply> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Daemon exited (${child.exitCode}): ${diagnostics()}`)
    try {
      const hello = await rpc(socket, { op: 'hello' })
      if (hello.type === 'hello') return hello
    } catch { /* The socket is not ready yet. */ }
    await delay(50)
  }
  throw new Error(`Daemon did not become ready: ${diagnostics()}`)
}

async function stopRuntime(socket: string, instance: unknown): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(socket, { op: 'runtime.stop', instance_id: instance, stop_active: true })
      return
    } catch (error) {
      if (attempt === 49) throw error
      await delay(20)
    }
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('Daemon did not exit')), 10_000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}
