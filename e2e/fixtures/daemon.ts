import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { access, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Reply = Record<string, unknown> & { type?: string; message?: string }

export async function rpc(socket: string, request: Record<string, unknown>, timeoutMs = 5_000): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const peer = createConnection(socket)
    let frame = ''
    const timer = setTimeout(() => peer.destroy(new Error('Daemon request timed out')), timeoutMs)
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
    peer.once('close', () => {
      clearTimeout(timer)
      rejectReply(new Error('Connection closed before a reply'))
    })
  })
}

export type RunningDaemon = {
  socket: string
  dataDirectory: string
  rootDirectory: string
  hello: Reply
  stop: () => Promise<void>
}

export async function startDaemon(
  extraEnvironment: Record<string, string> = {},
  startupCheck?: (hello: Reply) => void,
): Promise<RunningDaemon> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'ade-e2e-'))
  const dataDirectory = join(rootDirectory, 'data')
  const socket = join(rootDirectory, 'daemon.sock')
  const runtimeSocket = join(rootDirectory, 'runtime.sock')
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
      ADE_RUNTIME_SOCKET: runtimeSocket,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 8_192) })

  try {
    const hello = await waitForHello(socket, child, () => stderr)
    if (typeof hello.runtime_pid !== 'number' || typeof hello.runtime_instance !== 'string'
      || typeof hello.runtime_socket !== 'string') throw new Error('Daemon did not report a runtime identity')
    startupCheck?.(hello)
    return {
      socket,
      dataDirectory,
      rootDirectory,
      hello,
      stop: async () => {
        let stopped = false
        try {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await prepareRestart(socket, hello.boot_id)
            } catch {
              // A failed graceful restart must not strand the detached runtime.
              child.kill('SIGKILL')
            }
          }
          try {
            await waitForExit(child)
          } catch {
            child.kill('SIGKILL')
            await waitForExit(child)
          }
          const runtimeSocket = hello.runtime_socket
          if (typeof runtimeSocket === 'string') {
            await stopRuntime(runtimeSocket, hello.runtime_instance, hello.runtime_pid)
            await waitForRuntimeExit(runtimeSocket, hello.runtime_instance, hello.runtime_pid)
          }
          stopped = true
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          await waitForExit(child).catch(() => undefined)
          // Keep logs and ownership files if shutdown cannot be confirmed.
          if (stopped) await rm(rootDirectory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    child.kill('SIGKILL')
    await waitForExit(child).catch(() => undefined)
    const runtimeLog = await readFile(join(dataDirectory, 'runtime.log'), 'utf8').catch(() => '')
    const logExists = await access(join(dataDirectory, 'runtime.log')).then(() => true, () => false)
    let cleanupError: unknown
    if (logExists) {
      try {
        const runtime = await waitForRuntimeHello(runtimeSocket)
        if (runtime.data_directory !== await realpath(dataDirectory)
          || typeof runtime.instance_id !== 'string' || typeof runtime.pid !== 'number') {
          throw new Error('Runtime startup identity does not match this fixture')
        }
        await stopRuntime(runtimeSocket, runtime.instance_id, runtime.pid)
        await waitForRuntimeExit(runtimeSocket, runtime.instance_id, runtime.pid)
      } catch (failure) {
        cleanupError = failure
      }
    }
    if (!cleanupError) await rm(rootDirectory, { recursive: true, force: true })
    throw new Error(`ADE daemon failed to start: ${String(error)}\n${stderr}\n${runtimeLog}`
      + (cleanupError ? `\nDetached runtime cleanup is unconfirmed; diagnostics retained at ${rootDirectory}: ${String(cleanupError)}` : ''))
  }
}

async function prepareRestart(socket: string, bootId: unknown): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(socket, { op: 'runtime.prepare_restart', boot_id: bootId })
      return
    } catch (error) {
      if (attempt === 49 || !String(error).includes('A command is still being admitted')) throw error
      await delay(100)
    }
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

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function stopRuntime(socket: string, instance: unknown, pid: unknown): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await rpc(socket, { op: 'runtime.stop', instance_id: instance, stop_active: true }, 500)
      return
    } catch (error) {
      if (String(error).includes('Runtime identity changed')) throw error
      const observed = await rpc(socket, { op: 'hello' }, 500).catch(() => null)
      if (observed && observed.instance_id !== instance) throw new Error('Runtime changed identity during stop')
      if (!observed && !isProcessAlive(pid)) return
      if (observed && !String(error).includes('Disconnect the application daemon')
        && !String(error).includes('Connection closed before a reply')
        && !String(error).includes('timed out')) throw error
      await delay(50)
    }
  }
  throw new Error(`Runtime stop could not be confirmed before deadline; socket: ${socket}`)
}

async function waitForRuntimeHello(socket: string): Promise<Reply> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      const hello = await rpc(socket, { op: 'hello' }, 500)
      if (hello.type === 'hello') return hello
    } catch { /* The detached runtime may still be starting. */ }
    await delay(50)
  }
  throw new Error(`Detached runtime did not become ready at ${socket}`)
}

async function waitForRuntimeExit(socket: string, instance: unknown, pid: unknown): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    let socketAlive = false
    try {
      const hello = await rpc(socket, { op: 'hello' }, 500)
      if (hello.instance_id !== instance) throw new Error('Runtime socket changed identity during stop')
      socketAlive = true
    } catch (error) {
      if (String(error).includes('changed identity')) throw error
    }
    if (!socketAlive && !isProcessAlive(pid)) return
    await delay(50)
  }
  throw new Error(`Runtime did not exit after stop; socket: ${socket}`)
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('Daemon did not exit')), 10_000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}
