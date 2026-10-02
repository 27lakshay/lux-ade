// The ACP agent process and its official-SDK client connection.
//
// The SDK dispatches each incoming message without awaiting the previous one, so a request's
// reply can resolve before the notifications that preceded it reached a handler. ADE needs the
// exact wire order: a `session/load` replay ends where its reply arrives, and a turn owns exactly
// the updates between its `session/prompt` request and that request's reply. Both streams are
// therefore observed at the SDK's transport boundary, synchronously and in order: `onOutgoing`
// sees each message before the agent can, and `onIncoming` sees each message before the SDK
// dispatches it. `onIncoming` may return a promise to hold the agent's output (backpressure).
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

/** The largest single ACP message accepted from the agent. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

export function startAgent({ command, args, env, cwd, onIncoming, onOutgoing, onPermission, onExit }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Agent diagnostics can carry account or prompt material: count them, never retain them.
  let stderrBytes = 0
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
  })
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      resolve({ code: null, signal: null, error: error.message })
    })
    child.once('close', (code, signal) => resolve({ code, signal, error: null }))
  })
  void exited.then((status) => onExit({ ...status, stderrBytes }))
  child.stdin.on('error', () => {})
  const base = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), {
    maxMessageBytes: MAX_MESSAGE_BYTES,
  })
  const each = (message, observe) => {
    if (Array.isArray(message)) {
      for (const entry of message) observe(entry)
      return undefined
    }
    return observe(message)
  }
  const readable = base.readable.pipeThrough(
    new TransformStream({
      async transform(message, controller) {
        const hold = each(message, onIncoming)
        if (hold) await hold
        controller.enqueue(message)
      },
    }),
  )
  const writer = base.writable.getWriter()
  const writable = new WritableStream({
    async write(message) {
      each(message, onOutgoing)
      await writer.write(message)
    },
    async close() {
      await writer.close()
    },
    async abort(reason) {
      await writer.abort(reason)
    },
  })
  const connection = acp
    .client({ name: 'ade' })
    .onRequest(acp.methods.client.session.requestPermission, (context) => onPermission(context))
    .connect({ readable, writable })
  return {
    agent: connection.agent,
    connection,
    child,
    exited,
    /** Ends the agent: closes its input, then signals it if it does not exit in time. */
    async stop(graceMs) {
      try {
        child.stdin.end()
      } catch {}
      const timer = (ms) => new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref())
      if ((await Promise.race([exited, timer(graceMs)])) !== 'timeout') return
      child.kill('SIGTERM')
      if ((await Promise.race([exited, timer(graceMs)])) !== 'timeout') return
      child.kill('SIGKILL')
      await exited
    },
  }
}

/** A JSON-RPC error from the agent as a typed worker failure. */
export function agentFailure(error, fallback) {
  if (error instanceof acp.RequestError) {
    if (error.code === -32000)
      return {
        code: 'authentication_required',
        message: 'The ACP agent requires sign-in; sign in with the agent’s own CLI, then try again',
      }
    if (error.code === -32601)
      return { code: 'unsupported', message: `The ACP agent does not implement this method: ${error.message}` }
    return { code: 'provider_failure', message: `${fallback}: ${String(error.message).slice(0, 512)}` }
  }
  return { code: 'transport_failure', message: `${fallback}: ${String(error?.message ?? error).slice(0, 512)}` }
}

export { acp }
