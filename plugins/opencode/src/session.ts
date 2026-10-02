// The OpenCode session as an Effect service. This is the one execution path: the
// provider worker (worker.ts) and the Promise/AsyncIterable client (client.ts) both
// run these effects, so errors, cancellation and disposal are the same everywhere.
import type {
  ChildTranscriptPage,
  Connected,
  Event as ProviderEvent,
  ProviderWorkerAck,
  ProviderWorkerAnswerRequest,
  ProviderWorkerCancelRequest,
  ProviderWorkerCancelResult,
  ProviderWorkerChildTranscriptRequest,
  ProviderWorkerHistoryPage,
  ProviderWorkerHistoryRequest,
  ProviderWorkerOpenRequest,
  ProviderWorkerSendRequest,
  ProviderWorkerSendResult,
} from '@ade/contracts'
import type { WorkerFailure } from '@ade/provider-sdk'
import { Cause, Context, Effect, Layer, Queue, Stream } from 'effect'
import { OpenCodeEngine, asFailure, failure } from './native/engine.mjs'

/** Semantic events retained ahead of a slow consumer; past this the session fails visibly. */
const EVENT_CAPACITY = 1024

export type OpenCodeOptions = {
  /** The OpenCode executable; `null` when the installation check found none. */
  readonly command: string | null
  /** Why the executable cannot be used, when `command` is null. */
  readonly unavailable?: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface OpenCodeSessionShape {
  readonly open: (params: ProviderWorkerOpenRequest) => Effect.Effect<Connected, WorkerFailure>
  readonly send: (params: ProviderWorkerSendRequest) => Effect.Effect<ProviderWorkerSendResult, WorkerFailure>
  readonly cancel: (params: ProviderWorkerCancelRequest) => Effect.Effect<ProviderWorkerCancelResult, WorkerFailure>
  readonly answer: (params: ProviderWorkerAnswerRequest) => Effect.Effect<ProviderWorkerAck, WorkerFailure>
  readonly history: (params: ProviderWorkerHistoryRequest) => Effect.Effect<ProviderWorkerHistoryPage, WorkerFailure>
  readonly childTranscript: (
    params: ProviderWorkerChildTranscriptRequest,
  ) => Effect.Effect<ChildTranscriptPage, WorkerFailure>
  readonly events: Stream.Stream<ProviderEvent, WorkerFailure>
}

export class OpenCodeSession extends Context.Service<OpenCodeSession, OpenCodeSessionShape>()(
  '@ade/opencode-provider/OpenCodeSession',
) {
  /** The session for one worker. OpenCode starts on `open`, never while the layer is built. */
  static readonly layer = (options: OpenCodeOptions): Layer.Layer<OpenCodeSession> =>
    Layer.effect(OpenCodeSession, make(options))
}

type Engine = InstanceType<typeof OpenCodeEngine>

const make = Effect.fnUntraced(function* (options: OpenCodeOptions) {
  const queue = yield* Queue.dropping<ProviderEvent, WorkerFailure | Cause.Done>(EVENT_CAPACITY)
  const engine: Engine = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new OpenCodeEngine(
          (event: ProviderEvent) => {
            if (!Queue.offerUnsafe(queue, event))
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(failure('resource_limit', 'OpenCode events outran their consumer') as WorkerFailure),
              )
          },
          { cwd: options.cwd, command: options.command, env: options.env },
        ),
    ),
    // Closing stops the owned OpenCode server and confirms its exit before the scope ends.
    (owned) =>
      Effect.promise(() => owned.close()).pipe(Effect.ensuring(Queue.end(queue)), Effect.withSpan('OpenCode.close')),
  )
  // Every native call is one interruptible effect: interruption aborts its signal,
  // which reaches the in-flight HTTP reads that accept one.
  const call = <A>(name: string, run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, WorkerFailure> =>
    options.command === null
      ? Effect.fail(failure('provider_failure', options.unavailable ?? 'OpenCode is not installed') as WorkerFailure)
      : Effect.tryPromise({
          try: run,
          catch: (error) => asFailure(error) as WorkerFailure,
        }).pipe(Effect.withSpan(`OpenCode.${name}`))
  return OpenCodeSession.of({
    open: (params) => call('open', () => engine.open(params) as Promise<Connected>),
    send: (params) => call('send', () => engine.send(params) as Promise<ProviderWorkerSendResult>),
    cancel: (params) => call('cancel', () => engine.cancel(params) as Promise<ProviderWorkerCancelResult>),
    answer: (params) => call('answer', () => engine.answer(params) as Promise<ProviderWorkerAck>),
    history: (params) =>
      call('history', (signal) => engine.history(params, signal) as Promise<ProviderWorkerHistoryPage>),
    childTranscript: (params) =>
      call('child_transcript', (signal) => engine.childTranscript(params, signal) as Promise<ChildTranscriptPage>),
    events: Stream.fromQueue(queue),
  })
})
