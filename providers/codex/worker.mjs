import { spawn } from 'node:child_process'
import { Cause, Effect, Layer, Queue, Stream } from 'effect'
import { runProviderWorker } from '@ade/provider-sdk/node'

// Rust produces this metadata from the same native descriptor used by the daemon.
// No native executable starts while the factory is acquired or initialized.
const descriptor = JSON.parse(process.env.ADE_CODEX_WORKER_DESCRIPTOR ?? 'null')
if (!descriptor) throw new Error('The owning ADE runtime must provide Codex worker metadata')
const FRAME = 1024 * 1024
const EVENT_BYTES = 4 * FRAME
const failure = (code, message) => ({ code, message })

function withinBudget(frame) {
  let nodes = 0,
    depth = 0,
    string = false,
    escaped = false,
    primitive = false
  if (frame.length > FRAME) return false
  for (const byte of frame) {
    if (string) {
      if (escaped) escaped = false
      else if (byte === 92) escaped = true
      else if (byte === 34) string = false
      continue
    }
    if (byte === 34) {
      nodes++
      string = true
      primitive = false
    } else if (byte === 123 || byte === 91) {
      nodes++
      depth++
      primitive = false
    } else if (byte === 125 || byte === 93) {
      depth = Math.max(0, depth - 1)
      primitive = false
    } else if (byte === 44 || byte === 58 || byte === 32 || byte === 9 || byte === 10 || byte === 13) primitive = false
    else if (!primitive) {
      nodes++
      primitive = true
    }
    if (nodes > 4096 || depth > 64 || frame.length * 4 + nodes * 512 > 8 * FRAME) return false
  }
  return true
}

runProviderWorker({
  descriptor,
  dependencies: Layer.empty,
  acquire: Effect.gen(function* () {
    const events = yield* Queue.dropping(32)
    let queuedBytes = 0
    let native
    let launchFailure
    let active = true

    function fail(detail) {
      if (!active) return
      launchFailure = detail
      Queue.failCauseUnsafe(events, Cause.fail(detail))
      native?.failPending(detail)
    }

    function acquireNative() {
      if (launchFailure) throw launchFailure
      if (native) return native
      const executable = process.env.ADE_CODEX_NATIVE_CLIENT
      if (!executable)
        throw failure('provider_failure', 'The owning ADE runtime did not provide the native Codex client')
      const child = spawn(executable, ['--codex-native-client'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const pending = new Map()
      let nextId = 0
      let carry = Buffer.alloc(0)
      let closed = false
      const exited = new Promise((resolve) =>
        child.once('close', (code, signal) => {
          closed = true
          resolve({ code, signal })
        }),
      )
      const failPending = (detail) => {
        for (const resume of pending.values()) resume(Effect.fail(detail))
        pending.clear()
      }
      child.stderr.on('data', () => {}) // Drain, never retain native diagnostics or account material.
      child.on('error', () => fail(failure('transport_failure', 'Could not launch the owned native Codex client')))
      child.on('close', () => {
        if (active) fail(failure('transport_failure', 'The owned native Codex client disconnected'))
      })
      function readFrame(frame) {
        if (!active) return
        if (!withinBudget(frame))
          return fail(
            failure('resource_limit', 'Native Codex data exceeds the aggregate byte, node, or nesting budget'),
          )
        let value
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))
        } catch {
          return fail(failure('transport_failure', 'Native Codex returned malformed JSON'))
        }
        if (value.method === 'event') {
          if (
            queuedBytes + frame.length > EVENT_BYTES ||
            !Queue.offerUnsafe(events, { value: value.params, bytes: frame.length })
          ) {
            return fail(
              failure('resource_limit', 'Native Codex semantic events exceeded the retained byte or entry budget'),
            )
          }
          queuedBytes += frame.length
        } else {
          const resume = pending.get(value.id)
          if (!resume) return // A timed-out/interrupted request is fenced, never replayed.
          pending.delete(value.id)
          if (value.error)
            resume(Effect.fail(value.error.data ?? failure('provider_failure', 'Native Codex refused the request')))
          else resume(Effect.succeed(value.result))
        }
      }
      child.stdout.on('data', (chunk) => {
        let start = 0
        while (active && start < chunk.length) {
          const end = chunk.indexOf(10, start)
          const part = chunk.subarray(start, end < 0 ? chunk.length : end)
          if (carry.length + part.length > FRAME)
            return fail(failure('resource_limit', 'Native Codex frame exceeded its byte budget'))
          const frame = carry.length ? Buffer.concat([carry, part]) : part
          if (end < 0) {
            carry = Buffer.from(frame)
            return
          }
          carry = Buffer.alloc(0)
          if (frame.length) readFrame(frame)
          start = end + 1
        }
      })
      native = {
        failPending,
        request(method, params) {
          return Effect.callback((resume) => {
            if (!active || closed || launchFailure)
              return resume(Effect.fail(launchFailure ?? failure('shutdown', 'Native Codex is stopping')))
            const control = method === 'cancel' || method === 'answer' || method === 'steer'
            if (pending.size >= (control ? 8 : 7))
              return resume(Effect.fail(failure('resource_limit', 'Native Codex request capacity is exhausted')))
            const id = ++nextId
            if (!Number.isSafeInteger(id))
              return resume(Effect.fail(failure('resource_limit', 'Native Codex request identity space is exhausted')))
            let frame
            try {
              frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
            } catch {
              return resume(Effect.fail(failure('invalid_request', 'Native Codex request could not be encoded')))
            }
            if (!withinBudget(frame) || child.stdin.writableLength + frame.length > 2 * FRAME) {
              return resume(
                Effect.fail(
                  failure('resource_limit', 'Native Codex request exceeds its retained structural/byte budget'),
                ),
              )
            }
            pending.set(id, resume)
            child.stdin.write(frame, (error) => {
              if (error) fail(failure('transport_failure', 'Native Codex request delivery outcome is unknown'))
            })
            return Effect.sync(() => pending.delete(id))
          })
        },
        async close() {
          active = false
          failPending(failure('shutdown', 'Native Codex worker closed'))
          child.stdin.end()
          const result = await Promise.race([
            exited,
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(null), 4000)
              timer.unref()
            }),
          ])
          if (!result)
            throw failure('timeout', 'Native Codex client did not confirm shutdown within its cleanup deadline')
          if (result.code !== 0 || result.signal)
            throw failure('transport_failure', 'Native Codex client exited without confirming clean shutdown')
        },
      }
      return native
    }

    const request = (method, params) =>
      Effect.try({ try: acquireNative, catch: (error) => error }).pipe(
        Effect.flatMap((client) => client.request(method, params)),
      )
    return {
      open: (params) => request('open', params),
      send: (params) => request('send', params),
      steer: (params) => request('steer', params),
      cancel: (params) => request('cancel', params),
      answer: (params) => request('answer', params),
      history: (params) => request('history', params),
      compact: (params) => request('compact', params),
      rewind: (params) => request('rewind', params),
      configure_mcp: (params) => request('configure_mcp', params),
      child_transcript: (params) => request('child_transcript', params),
      events: Stream.fromQueue(events).pipe(
        Stream.map(({ value, bytes }) => {
          queuedBytes -= bytes
          return value
        }),
      ),
      close: Effect.tryPromise({
        try: async () => {
          active = false
          if (native) await native.close()
        },
        catch: (error) => error,
      }),
    }
  }),
})
