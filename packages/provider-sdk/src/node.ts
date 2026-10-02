import {
  decodeProviderWorkerFailure,
  decodeProviderWorkerInitialize,
  decodeProviderWorkerRequest,
  decodeProviderWorkerResponse,
  decodeProviderWorkerOpenRequest,
  decodeProviderWorkerSendRequest,
  decodeProviderWorkerHistoryRequest,
  decodeProviderWorkerEventNotification,
  decodeProviderWorkerSteerRequest,
  decodeProviderWorkerCancelRequest,
  decodeProviderWorkerAnswerRequest,
  decodeProviderWorkerCompactRequest,
  decodeProviderWorkerRewindRequest,
  decodeProviderWorkerRewindResult,
  decodeProviderWorkerConfigureMcpRequest,
  decodeProviderWorkerChildTranscriptRequest,
  decodeProviderWorkerAck,
  decodeProviderWorkerCancelResult,
  decodeProviderWorkerHistoryPage,
  decodeConnected,
  decodeProviderWorkerSendResult,
  decodeResponse,
} from '@ade/contracts'
import type { ProviderWorkerRequest } from '@ade/contracts'
import { NodeSink } from '@effect/platform-node'
import { Cause, Context, Effect, Fiber, Layer, Logger, ManagedRuntime, Option, Queue, Stream } from 'effect'
import type { Scope } from 'effect'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import type {
  ProviderFactory,
  ProviderWorker,
  WorkerDescriptor,
  WorkerFailure,
  WorkerInput,
  WorkerMethod,
} from './provider.js'
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from './provider.js'

const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024
const MAX_DIAGNOSTIC_TOTAL_BYTES = 32 * 1024
const MAX_JSON_DEPTH = 64
type WorkerRequest = ProviderWorkerRequest
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
type DispatchMessage = {
  readonly id: string | number
  readonly method: WorkerMethod
  readonly params: WorkerInput
  readonly deadline: number
}
type OutputMessage = Buffer
type EncodedFrame =
  | { readonly ok: true; readonly frame: Buffer }
  | { readonly ok: false; readonly failure: WorkerFailure }

const failure = (code: WorkerFailure['code'], message: string): WorkerFailure =>
  decodeProviderWorkerFailure({ code, message: safeMessage(message) })

const safeMessage = (value: unknown): string => {
  const raw = String(value).replace(/[\r\n\0\x1b\x7f-\x9f]/g, ' ')
  let output = ''
  let bytes = 0
  for (const character of raw) {
    const size = Buffer.byteLength(character)
    if (bytes + size > MAX_DIAGNOSTIC_MESSAGE_BYTES) break
    output += character
    bytes += size
  }
  return output || 'Provider worker failed'
}
const failureSummary = (value: unknown): string => {
  if (value instanceof Error) return safeMessage(value.message)
  if (value !== null && typeof value === 'object') {
    try {
      const fields: string[] = []
      let count = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (count++ === 8) break
        const field = (value as Record<string, unknown>)[key]
        fields.push(
          key +
            '=' +
            (field === null || typeof field !== 'object'
              ? safeMessage(field)
              : Array.isArray(field)
                ? 'array'
                : 'object'),
        )
      }
      if (fields.length > 0) return safeMessage(fields.join(' '))
    } catch {
      return 'unavailable cause details'
    }
  }
  return safeMessage(value)
}

let diagnosticBytes = 0
let diagnosticBlocked = false
const writeDiagnostic = (message: unknown): void => {
  if (diagnosticBlocked || diagnosticBytes >= MAX_DIAGNOSTIC_TOTAL_BYTES) return
  const line = Buffer.from(safeMessage(message) + '\n')
  if (diagnosticBytes + line.byteLength > MAX_DIAGNOSTIC_TOTAL_BYTES) return
  diagnosticBytes += line.byteLength
  try {
    if (!process.stderr.write(line)) diagnosticBlocked = true
  } catch {
    diagnosticBlocked = true
  }
}

const jsonStringBytes = (value: string, maxBytes: number): number => {
  let size = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      size += 2
    else if (code < 0x20) size += 6
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 4
        index++
      } else size += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) size += 6
    else size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (size > maxBytes) return size
  }
  return size
}

const boundedValue = (root: unknown, maxEntries: number, maxBytes: number): boolean => {
  const active = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > MAX_JSON_DEPTH) return false
    if (typeof value === 'string') {
      bytes += jsonStringBytes(value, maxBytes)
      return bytes <= maxBytes
    }
    if (value === null) {
      bytes += 4
      return bytes <= maxBytes
    }
    if (typeof value === 'boolean') {
      bytes += value ? 4 : 5
      return bytes <= maxBytes
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false
      bytes += JSON.stringify(value).length
      return bytes <= maxBytes
    }
    if (typeof value !== 'object' || active.has(value)) return false
    active.add(value)
    let entries = 0
    if (Array.isArray(value)) {
      if (value.length > maxEntries) return false
      bytes += 2 + Math.max(0, value.length - 1)
      if (bytes > maxBytes) return false
      for (const child of value) {
        if (!visit(child, depth + 1)) return false
      }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
      bytes += 2
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        const property = Object.getOwnPropertyDescriptor(value, key)
        if (!property?.enumerable) continue
        if (!('value' in property) || ++entries > maxEntries) return false
        bytes += (first ? 0 : 1) + jsonStringBytes(key, maxBytes) + 1
        first = false
        if (bytes > maxBytes || !visit(property.value, depth + 1)) return false
      }
    }
    active.delete(value)
    return true
  }
  return visit(root, 0)
}

const encodeFrame = (value: unknown, maxBytes: number, maxEntries: number, method?: WorkerMethod): EncodedFrame => {
  const maxJsonBytes = Math.min(MAX_FRAME_BYTES, maxBytes) - 1
  if (maxJsonBytes < 0 || !boundedValue(value, maxEntries, maxJsonBytes)) {
    return {
      ok: false,
      failure: failure('resource_limit', 'Provider worker response exceeds its declared byte, entry, or depth limit'),
    }
  }
  let json: string | undefined
  try {
    if (isRecord(value) && value.method === 'event') decodeProviderWorkerEventNotification(value)
    else {
      const response = decodeProviderWorkerResponse(value)
      if ('result' in response && method !== undefined) {
        switch (method) {
          case 'open':
            decodeConnected(response.result)
            break
          case 'send':
          case 'steer':
            decodeProviderWorkerSendResult(response.result)
            break
          case 'history':
            decodeProviderWorkerHistoryPage(response.result)
            break
          case 'rewind':
            decodeProviderWorkerRewindResult(response.result)
            break
          case 'cancel':
            decodeProviderWorkerCancelResult(response.result)
            break
          case 'answer':
          case 'compact':
          case 'configure_mcp':
            decodeProviderWorkerAck(response.result)
            break
          case 'child_transcript':
            decodeResponse('agent.child_transcript', response.result)
            break
        }
      }
    }
    json = JSON.stringify(value)
  } catch {
    return {
      ok: false,
      failure: failure('integration_bug', 'Provider worker response does not match the Rust-generated wire contract'),
    }
  }
  if (json === undefined)
    return { ok: false, failure: failure('integration_bug', 'Provider worker response could not be encoded') }
  if (Buffer.byteLength(json) + 1 > Math.min(MAX_FRAME_BYTES, maxBytes)) {
    return { ok: false, failure: failure('resource_limit', 'Provider worker response exceeds its declared byte limit') }
  }
  return { ok: true, frame: Buffer.from(json + '\n') }
}

const errorResponse = (id: string | number | null, detail: WorkerFailure, code = -32000) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message: 'Provider worker request failed', data: detail },
})

const enqueueFrame = (
  queue: Queue.Queue<OutputMessage, Cause.Done>,
  frame: Buffer,
  generation?: { active: boolean },
): Effect.Effect<void, WorkerFailure> => {
  if (generation && !generation.active) return Effect.void
  return Queue.offer(queue, frame).pipe(
    Effect.flatMap((accepted) =>
      accepted ? Effect.void : Effect.fail(failure('resource_limit', 'Provider worker output queue is full')),
    ),
  )
}

const enqueueResponse = (
  queue: Queue.Queue<OutputMessage, Cause.Done>,
  value: unknown,
  limits: WorkerDescriptor['limits'],
  id?: string | number | null,
  generation?: { active: boolean },
): Effect.Effect<void, WorkerFailure> => {
  const encoded = encodeFrame(value, limits.max_output_frame_bytes, limits.max_output_entries)
  if (encoded.ok) return enqueueFrame(queue, encoded.frame, generation)
  if (id !== undefined && encoded.failure.code === 'resource_limit') {
    const fallback = encodeFrame(
      errorResponse(id, encoded.failure),
      limits.max_output_frame_bytes,
      limits.max_output_entries,
    )
    return fallback.ok ? enqueueFrame(queue, fallback.frame, generation) : Effect.fail(fallback.failure)
  }
  return Effect.fail(encoded.failure)
}

const writeLoop = (
  output: Queue.Queue<OutputMessage, Cause.Done>,
  capacityChanged: Queue.Queue<void>,
): Effect.Effect<void, WorkerFailure> => {
  const outputStream: Stream.Stream<OutputMessage, never> = Stream.fromQueue(output).pipe(
    Stream.map((frame) => {
      Queue.offerUnsafe(capacityChanged, undefined)
      return frame
    }),
  )
  return outputStream.pipe(
    Stream.run(
      NodeSink.fromWritable({
        evaluate: () => process.stdout,
        onError: () => failure('transport_failure', 'Provider worker output transport failed'),
        endOnDone: false,
      }),
    ),
  )
}

const failProcess = (message: string) => {
  process.exitCode = 1
  writeDiagnostic(message)
}

/** One ManagedRuntime owns the provider worker, dependencies, and cleanup. */
export const runProviderWorker = <R>(factory: ProviderFactory<R>, input: Readable = process.stdin): void => {
  try {
    decodeProviderWorkerInitialize({ ...factory.descriptor, protocol_version: PROTOCOL_VERSION })
  } catch {
    failProcess('Provider worker descriptor does not match the Rust-generated contract')
    return
  }
  const limits = factory.descriptor.limits
  const cleanupFailure: { value?: WorkerFailure } = {}
  const WorkerInstance = Context.Service<ProviderWorker<R>>('ADE provider worker instance')
  const acquired = Effect.acquireRelease(
    factory.acquire.pipe(
      Effect.timeoutOrElse({
        duration: limits.max_initialize_ms,
        orElse: () => Effect.fail(failure('timeout', 'Provider worker initialization exceeded its declared deadline')),
      }),
    ),
    (instance) =>
      Effect.matchCauseEffect(
        (instance.close ?? Effect.void).pipe(
          Effect.timeoutOrElse({
            duration: limits.max_cleanup_ms,
            orElse: () => Effect.fail(failure('timeout', 'Provider worker cleanup exceeded its declared deadline')),
          }),
        ),
        {
          onSuccess: () => Effect.void,
          onFailure: (cause) =>
            Effect.sync(() => {
              const typed = Cause.findErrorOption(cause)
              cleanupFailure.value = Option.isSome(typed)
                ? decodeProviderWorkerFailure(typed.value)
                : failure('integration_bug', 'Provider worker cleanup failed unexpectedly')
            }),
        },
      ),
  )
  const workerLogger = Logger.make(({ message }) => writeDiagnostic('Effect: ' + safeMessage(message)))
  const dependencies = factory.dependencies.pipe(Layer.provideMerge(Logger.layer([workerLogger])))
  const layer = Layer.effect(WorkerInstance, acquired).pipe(Layer.provideMerge(dependencies))
  const runtime = ManagedRuntime.make(layer)
  let initialized = false
  let initializationTimedOut = false
  let startupTimer: ReturnType<typeof setTimeout>
  let forcedExitTimer: ReturnType<typeof setTimeout> | undefined
  const beginShutdown = () => {
    if (forcedExitTimer) return
    forcedExitTimer = setTimeout(() => {
      writeDiagnostic('Provider worker shutdown exceeded its declared cleanup deadline')
      process.exit(1)
    }, limits.max_cleanup_ms + 100)
  }
  const markInitialized = () => {
    if (initialized) return
    initialized = true
    clearTimeout(startupTimer)
  }
  const program = Effect.gen(function* () {
    const worker = yield* WorkerInstance
    return yield* Effect.scoped(processInput(input, factory.descriptor, worker, markInitialized, beginShutdown))
  })
  const dispose = () => {
    clearTimeout(startupTimer)
    let finished = false
    const disposalTimer = setTimeout(() => {
      if (finished) return
      writeDiagnostic('Provider worker runtime disposal exceeded its declared deadline')
      process.exit(1)
    }, limits.max_cleanup_ms + 100)
    return runtime.dispose().then(
      () => {
        finished = true
        clearTimeout(disposalTimer)
        if (forcedExitTimer) clearTimeout(forcedExitTimer)
        if (cleanupFailure.value) failProcess('Provider worker cleanup failed (' + cleanupFailure.value.code + ')')
      },
      () => {
        finished = true
        clearTimeout(disposalTimer)
        failProcess('Provider worker runtime disposal failed')
        if (forcedExitTimer) clearTimeout(forcedExitTimer)
      },
    )
  }
  startupTimer = setTimeout(() => {
    if (initialized) return
    initializationTimedOut = true
    failProcess('Provider worker initialization exceeded its declared deadline (timeout)')
    input.destroy()
    beginShutdown()
  }, limits.max_initialize_ms)
  void runtime
    .runPromise(program)
    .then(
      () => dispose(),
      (error) => {
        if (!initializationTimedOut) {
          const code = (() => {
            try {
              return decodeProviderWorkerFailure(error).code
            } catch {
              return 'integration_bug'
            }
          })()
          failProcess('Provider worker runtime failed (' + code + '): ' + failureSummary(error))
        }
        return dispose()
      },
    )
    .catch(() => failProcess('Provider worker runtime failed (integration_bug)'))
}

const processInput = <R>(
  input: Readable,
  descriptor: WorkerDescriptor,
  worker: ProviderWorker<R>,
  onInitialized: () => void,
  onStopping: () => void,
): Effect.Effect<void, WorkerFailure, R | Scope.Scope> =>
  Effect.gen(function* () {
    const concurrency = descriptor.limits.max_concurrency
    const normalConcurrency = concurrency - 1
    const requests = yield* Queue.dropping<DispatchMessage>(normalConcurrency)
    const controls = yield* Queue.dropping<DispatchMessage>(1)
    const outputCapacity = Math.min(descriptor.limits.max_output_entries, concurrency * 2)
    const output = yield* Queue.dropping<OutputMessage, Cause.Done>(outputCapacity)
    const capacityChanged = yield* Queue.dropping<void>(1)
    const fatal = yield* Queue.dropping<WorkerFailure>(1)
    const generation = { active: true }
    const supervise = (effect: Effect.Effect<void, WorkerFailure, R | Scope.Scope>) =>
      Effect.matchCauseEffect(effect, {
        onSuccess: () => Effect.void,
        onFailure: (cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.void
          const typed = Cause.findErrorOption(cause)
          const detail = Option.isSome(typed)
            ? decodeProviderWorkerFailure(typed.value)
            : failure('integration_bug', 'Provider worker task failed unexpectedly')
          return Queue.offer(fatal, detail).pipe(Effect.asVoid)
        },
      })
    const writer = yield* Effect.forkScoped(writeLoop(output, capacityChanged))
    // Semantic events share the FIFO with replies, but cannot consume the reply/control reserve.
    // Fixed queue capacity and individually bounded frames also bound retained bytes.
    const eventReader = worker.events
      ? yield* Effect.forkScoped(
          supervise(
            Stream.runForEach(worker.events, (event) => {
              const encoded = encodeFrame(
                { jsonrpc: '2.0', method: 'event', params: event },
                descriptor.limits.max_output_frame_bytes,
                descriptor.limits.max_output_entries,
              )
              if (!encoded.ok) return Effect.fail(encoded.failure)
              return Effect.gen(function* () {
                const eventCapacity = outputCapacity - concurrency
                if (eventCapacity <= 0)
                  return yield* Effect.fail(
                    failure('resource_limit', 'Provider worker has no reserved event output capacity'),
                  )
                while (generation.active && Queue.sizeUnsafe(output) >= eventCapacity)
                  yield* Queue.take(capacityChanged)
                if (!generation.active) return
                if (!Queue.offerUnsafe(output, encoded.frame))
                  return yield* Effect.fail(
                    failure('resource_limit', 'Provider worker semantic event output exceeded its reserved capacity'),
                  )
              })
            }),
          ),
        )
      : undefined
    const dispatchers = [
      yield* Effect.forkScoped(supervise(dispatchLoop(controls, output, descriptor, worker, generation))),
    ]
    for (let index = 0; index < normalConcurrency; index++) {
      dispatchers.push(
        yield* Effect.forkScoped(supervise(dispatchLoop(requests, output, descriptor, worker, generation))),
      )
    }
    const iterator = yield* Effect.acquireRelease(
      Effect.sync(() => input[Symbol.asyncIterator]()),
      (owned) =>
        Effect.tryPromise({
          try: async () => {
            if (!input.destroyed) input.destroy()
            await owned.return?.()
          },
          catch: (): WorkerFailure => failure('transport_failure', 'Provider worker input cleanup failed'),
        }).pipe(Effect.catch(() => Effect.sync(() => failProcess('Provider worker input cleanup failed')))),
    )
    const reader = yield* Effect.forkScoped(
      readInput(iterator, descriptor, requests, controls, output, onInitialized, generation),
    )
    const writerFailure = Fiber.join(writer).pipe(Effect.flatMap(() => Effect.never))
    const readOrFailure = Effect.raceFirst(
      Fiber.join(reader),
      Effect.raceFirst(Queue.take(fatal).pipe(Effect.flatMap((detail) => Effect.fail(detail))), writerFailure),
    )
    const producers = eventReader === undefined ? [reader, ...dispatchers] : [reader, eventReader, ...dispatchers]
    const owned = [writer, ...producers]
    const gracefulShutdown = Effect.gen(function* () {
      onStopping()
      generation.active = false
      yield* Fiber.interruptAll(producers)
      yield* Queue.end(output).pipe(Effect.asVoid)
      yield* Fiber.join(writer)
    }).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, descriptor.limits.max_cleanup_ms / 2),
        orElse: () => Effect.fail(failure('timeout', 'Provider worker shutdown drain exceeded its cleanup deadline')),
      }),
    )
    yield* Effect.ensuring(
      readOrFailure.pipe(Effect.flatMap(() => gracefulShutdown)),
      Effect.flatMap(
        Effect.sync(() => {
          generation.active = false
          onStopping()
        }),
        () =>
          Fiber.interruptAll(owned).pipe(
            Effect.timeoutOrElse({
              duration: Math.max(1, descriptor.limits.max_cleanup_ms / 2),
              orElse: () => Effect.void,
            }),
          ),
      ),
    )
  })

const readInput = (
  iterator: AsyncIterator<unknown>,
  descriptor: WorkerDescriptor,
  requests: Queue.Queue<DispatchMessage>,
  controls: Queue.Queue<DispatchMessage>,
  output: Queue.Queue<OutputMessage, Cause.Done>,
  onInitialized: () => void,
  generation: { active: boolean },
): Effect.Effect<void, WorkerFailure> =>
  Effect.gen(function* () {
    const maxBytes = Math.min(MAX_FRAME_BYTES, descriptor.limits.max_input_frame_bytes)
    let carry = Buffer.allocUnsafe(Math.min(1024, maxBytes))
    let used = 0
    let partialStarted: number | undefined
    while (generation.active) {
      const nextEffect = Effect.tryPromise({
        try: () => iterator.next(),
        catch: (): WorkerFailure => failure('transport_failure', 'Provider worker input transport failed'),
      })
      let next: IteratorResult<unknown>
      if (used === 0 || partialStarted === undefined) next = yield* nextEffect
      else {
        const remaining = descriptor.limits.max_partial_frame_ms - (performance.now() - partialStarted)
        if (remaining <= 0)
          return yield* Effect.fail(failure('timeout', 'Provider worker partial frame exceeded its declared deadline'))
        next = yield* nextEffect.pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () =>
              Effect.fail(failure('timeout', 'Provider worker partial frame exceeded its declared deadline')),
          }),
        )
      }
      if (next.done) {
        if (used > 0)
          yield* handleFrame(carry.subarray(0, used), descriptor, requests, controls, output, onInitialized, generation)
        return
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(offset, end)
        if (used + part.length > maxBytes)
          return yield* Effect.fail(
            failure('resource_limit', 'Provider worker input frame exceeds its declared byte limit'),
          )
        const required = used + part.length
        if (required > carry.length) {
          const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(required, carry.length * 2)))
          carry.copy(grown, 0, 0, used)
          carry = grown
        }
        part.copy(carry, used)
        used = required
        if (newline < 0) {
          if (used > 0 && partialStarted === undefined) partialStarted = performance.now()
          break
        }
        yield* handleFrame(carry.subarray(0, used), descriptor, requests, controls, output, onInitialized, generation)
        used = 0
        partialStarted = undefined
        offset = newline + 1
      }
    }
  })

const PROVIDER_WORKER_METHODS = new Set([
  'initialize',
  'open',
  'send',
  'steer',
  'cancel',
  'answer',
  'history',
  'compact',
  'rewind',
  'configure_mcp',
  'child_transcript',
])

// Count the complete wire shape before parsing, including unknown fields.
const withinJsonBudget = (frame: Buffer): boolean => {
  let nodes = 0,
    depth = 0,
    string = false,
    escaped = false,
    primitive = false
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
    if (nodes > 4096 || depth > 64 || frame.length * 4 + nodes * 512 > 8 * 1024 * 1024) return false
  }
  return true
}

const parseRequestFrame = (
  frame: Buffer,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly resourceLimit?: boolean } => {
  try {
    if (!withinJsonBudget(frame)) return { ok: false, resourceLimit: true }
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) }
  } catch {
    return { ok: false }
  }
}

const decodeRequest = (value: unknown): WorkerRequest | undefined => {
  try {
    return decodeProviderWorkerRequest(value)
  } catch {
    return undefined
  }
}

const handleFrame = (
  frame: Buffer,
  descriptor: WorkerDescriptor,
  requests: Queue.Queue<DispatchMessage>,
  controls: Queue.Queue<DispatchMessage>,
  output: Queue.Queue<OutputMessage, Cause.Done>,
  onInitialized: () => void,
  generation: { active: boolean },
): Effect.Effect<void, WorkerFailure> =>
  Effect.gen(function* () {
    if (!generation.active) return
    const parsed = parseRequestFrame(frame)
    if (!parsed.ok) {
      yield* enqueueResponse(
        output,
        errorResponse(
          null,
          failure(
            parsed.resourceLimit ? 'resource_limit' : 'invalid_request',
            parsed.resourceLimit
              ? 'Provider worker request exceeds the aggregate node, depth, or decoded-byte budget'
              : 'Invalid JSON-RPC frame',
          ),
          parsed.resourceLimit ? -32602 : -32700,
        ),
        descriptor.limits,
        null,
        generation,
      )
      return
    }
    const raw = parsed.value
    const rawId = isRecord(raw) ? raw.id : undefined
    const validId = typeof rawId === 'string' || (typeof rawId === 'number' && Number.isSafeInteger(rawId))
    const id = validId ? rawId : null
    if (!boundedValue(raw, descriptor.limits.max_input_entries, descriptor.limits.max_input_frame_bytes)) {
      yield* enqueueResponse(
        output,
        errorResponse(
          id,
          failure('resource_limit', 'Provider worker request exceeds its declared entry or depth limit'),
        ),
        descriptor.limits,
        id,
        generation,
      )
      return
    }
    const rawMethod = isRecord(raw) && typeof raw.method === 'string' ? raw.method : undefined
    const validHeader =
      isRecord(raw) &&
      raw.jsonrpc === '2.0' &&
      validId &&
      rawMethod !== undefined &&
      Object.keys(raw).every((key) => key === 'jsonrpc' || key === 'id' || key === 'method' || key === 'params')
    if (!validHeader) {
      yield* enqueueResponse(
        output,
        errorResponse(id, failure('invalid_request', 'Invalid JSON-RPC request header'), -32600),
        descriptor.limits,
        id,
        generation,
      )
      return
    }
    if (!PROVIDER_WORKER_METHODS.has(rawMethod!)) {
      yield* enqueueResponse(
        output,
        errorResponse(id, failure('unsupported', 'Unsupported provider worker method'), -32601),
        descriptor.limits,
        id,
        generation,
      )
      return
    }
    if (!isRecord(raw.params)) {
      yield* enqueueResponse(
        output,
        errorResponse(id, failure('invalid_request', 'Invalid provider worker parameters'), -32602),
        descriptor.limits,
        id,
        generation,
      )
      return
    }
    const request = decodeRequest(raw)
    if (!request) {
      yield* enqueueResponse(
        output,
        errorResponse(id, failure('invalid_request', 'Invalid provider worker parameters'), -32602),
        descriptor.limits,
        id,
        generation,
      )
      return
    }
    if (request.method === 'initialize') {
      const offered = request.params.versions
      if (!Array.isArray(offered) || !offered.every(Number.isSafeInteger)) {
        yield* enqueueResponse(
          output,
          errorResponse(request.id, failure('invalid_request', 'Invalid initialize parameters'), -32602),
          descriptor.limits,
          request.id,
          generation,
        )
        onInitialized()
        return
      }
      if (!offered.includes(PROTOCOL_VERSION) || !descriptor.compatible_protocol_versions.includes(PROTOCOL_VERSION)) {
        yield* enqueueResponse(
          output,
          errorResponse(request.id, failure('protocol_mismatch', 'No compatible provider worker protocol version')),
          descriptor.limits,
          request.id,
          generation,
        )
        onInitialized()
        return
      }
      yield* enqueueResponse(
        output,
        { jsonrpc: '2.0', id: request.id, result: { ...descriptor, protocol_version: PROTOCOL_VERSION } },
        descriptor.limits,
        request.id,
        generation,
      )
      onInitialized()
      return
    }
    const method = request.method as WorkerMethod
    const operation = descriptor.operations.find((candidate) => candidate.method === method)
    if (!operation || operation.availability !== 'available') {
      const detail = failure(
        operation?.availability === 'unsupported' ? 'unsupported' : 'provider_failure',
        operation?.reason || 'Provider worker operation ' + method + ' is unavailable',
      )
      yield* enqueueResponse(output, errorResponse(request.id, detail), descriptor.limits, request.id, generation)
      return
    }
    const queue = method === 'steer' || method === 'cancel' || method === 'answer' ? controls : requests
    const accepted = yield* Queue.offer(queue, {
      id: request.id,
      method,
      params: request.params,
      deadline: performance.now() + descriptor.limits.max_operation_ms,
    })
    if (!accepted)
      yield* enqueueResponse(
        output,
        errorResponse(request.id, failure('resource_limit', 'Provider worker dispatch queue is full')),
        descriptor.limits,
        request.id,
        generation,
      )
  })

const dispatchLoop = <R>(
  queue: Queue.Queue<DispatchMessage>,
  output: Queue.Queue<OutputMessage, Cause.Done>,
  descriptor: WorkerDescriptor,
  worker: ProviderWorker<R>,
  generation: { active: boolean },
): Effect.Effect<void, WorkerFailure, R | Scope.Scope> =>
  Effect.gen(function* () {
    while (generation.active) {
      const message = yield* Queue.take(queue)
      if (!generation.active) return
      const frame = yield* operationResponse(message, descriptor, worker)
      yield* enqueueFrame(output, frame, generation)
    }
  })

const decodeParameters = <T>(decode: (value: unknown) => T, value: unknown): Effect.Effect<T, WorkerFailure> =>
  Effect.try({
    try: () => decode(value),
    catch: () => failure('invalid_request', 'Provider worker parameters do not match the generated method contract'),
  })

const operationResponse = <R>(
  job: DispatchMessage,
  descriptor: WorkerDescriptor,
  worker: ProviderWorker<R>,
): Effect.Effect<Buffer, WorkerFailure, R | Scope.Scope> =>
  Effect.gen(function* () {
    const handler = worker[job.method]
    if (!handler) {
      return yield* encodeOperationResponse(
        job.id,
        errorResponse(
          job.id,
          failure('integration_bug', 'Provider worker declared ' + job.method + ' available without a handler'),
        ),
        descriptor.limits,
      )
    }
    const remaining = job.deadline - performance.now()
    if (remaining <= 0)
      return yield* encodeOperationResponse(
        job.id,
        errorResponse(job.id, failure('timeout', 'Provider worker ' + job.method + ' operation timed out')),
        descriptor.limits,
      )
    const outcome = yield* Effect.matchCauseEffect(
      Effect.suspend(() => {
        switch (job.method) {
          case 'open':
            return decodeParameters(decodeProviderWorkerOpenRequest, job.params).pipe(
              Effect.flatMap((params) => worker.open!(params)),
            )
          case 'send':
            return decodeParameters(decodeProviderWorkerSendRequest, job.params).pipe(
              Effect.flatMap((params) => worker.send!(params)),
            )
          case 'history':
            return decodeParameters(decodeProviderWorkerHistoryRequest, job.params).pipe(
              Effect.flatMap((params) => worker.history!(params)),
            )
          case 'steer':
            return decodeParameters(decodeProviderWorkerSteerRequest, job.params).pipe(
              Effect.flatMap((params) => worker.steer!(params)),
            )
          case 'cancel':
            return decodeParameters(decodeProviderWorkerCancelRequest, job.params).pipe(
              Effect.flatMap((params) => worker.cancel!(params)),
            )
          case 'answer':
            return decodeParameters(decodeProviderWorkerAnswerRequest, job.params).pipe(
              Effect.flatMap((params) => worker.answer!(params)),
            )
          case 'compact':
            return decodeParameters(decodeProviderWorkerCompactRequest, job.params).pipe(
              Effect.flatMap((params) => worker.compact!(params)),
            )
          case 'rewind':
            return decodeParameters(decodeProviderWorkerRewindRequest, job.params).pipe(
              Effect.flatMap((params) => worker.rewind!(params)),
            )
          case 'configure_mcp':
            return decodeParameters(decodeProviderWorkerConfigureMcpRequest, job.params).pipe(
              Effect.flatMap((params) => worker.configure_mcp!(params)),
            )
          case 'child_transcript':
            return decodeParameters(decodeProviderWorkerChildTranscriptRequest, job.params).pipe(
              Effect.flatMap((params) => worker.child_transcript!(params)),
            )
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: remaining,
          orElse: () => Effect.fail(failure('timeout', 'Provider worker ' + job.method + ' operation timed out')),
        }),
      ),
      {
        onSuccess: (result) => Effect.succeed({ result } as const),
        onFailure: (cause) => {
          if (Cause.hasDies(cause)) {
            writeDiagnostic('Provider worker handler defect')
            return Effect.succeed({
              failure: failure('integration_bug', 'Provider worker handler failed unexpectedly'),
            } as const)
          }
          if (Cause.hasInterrupts(cause))
            return Effect.succeed({ failure: failure('cancelled', 'Provider worker handler was interrupted') } as const)
          const typed = Cause.findErrorOption(cause)
          return Option.isSome(typed)
            ? Effect.succeed({ failure: decodeProviderWorkerFailure(typed.value) } as const)
            : Effect.succeed({ failure: failure('internal', 'Provider worker handler failed') } as const)
        },
      },
    )
    const response =
      'failure' in outcome
        ? errorResponse(job.id, outcome.failure)
        : { jsonrpc: '2.0', id: job.id, result: outcome.result }
    return yield* encodeOperationResponse(job.id, response, descriptor.limits, job.method)
  })

const encodeOperationResponse = (
  id: string | number,
  response: unknown,
  limits: WorkerDescriptor['limits'],
  method?: WorkerMethod,
): Effect.Effect<Buffer, WorkerFailure> => {
  const maxEntries =
    method === 'open' || method === 'history' || method === 'child_transcript'
      ? limits.max_history_page_items
      : limits.max_output_entries
  const encoded = encodeFrame(response, limits.max_output_frame_bytes, maxEntries, method)
  if (encoded.ok) return Effect.succeed(encoded.frame)
  const fallback = encodeFrame(
    errorResponse(id, encoded.failure),
    limits.max_output_frame_bytes,
    limits.max_output_entries,
  )
  return fallback.ok ? Effect.succeed(fallback.frame) : Effect.fail(fallback.failure)
}
