// Promise and AsyncIterable access to the same OpenCodeSession effects, for hosts
// that do not run Effect. One ManagedRuntime owns the session: each Promise method
// runs the service effect, an AbortSignal interrupts that fiber, and `dispose`
// closes the session scope (stopping OpenCode) exactly as the worker runtime does.
import type { Event as ProviderEvent } from '@ade/contracts'
import type { WorkerFailure } from '@ade/provider-sdk'
import { Cause, Effect, Exit, ManagedRuntime, Option, Stream } from 'effect'
import { OpenCodeSession } from './session.js'
import type { OpenCodeOptions, OpenCodeSessionShape } from './session.js'

/** A Promise rejection carrying the same typed failure the Effect interface fails with. */
export class OpenCodeFailure extends Error {
  readonly failure: WorkerFailure
  constructor(failure: WorkerFailure) {
    super(failure.message)
    this.name = 'OpenCodeFailure'
    this.failure = failure
  }
}

type Operation = Exclude<keyof OpenCodeSessionShape, 'events'>
type Params<K extends Operation> = Parameters<OpenCodeSessionShape[K]>[0]
type Result<K extends Operation> = Effect.Success<ReturnType<OpenCodeSessionShape[K]>>

const toFailure = (cause: Cause.Cause<WorkerFailure>): WorkerFailure => {
  const typed = Cause.findErrorOption(cause)
  if (Option.isSome(typed)) return typed.value
  if (Cause.hasInterrupts(cause)) return { code: 'cancelled', message: 'The OpenCode call was cancelled' }
  return { code: 'internal', message: 'The OpenCode call failed unexpectedly' }
}

export class OpenCodeClient {
  readonly #runtime: ManagedRuntime.ManagedRuntime<OpenCodeSession, never>

  private constructor(options: OpenCodeOptions) {
    this.#runtime = ManagedRuntime.make(OpenCodeSession.layer(options))
  }

  static make(options: OpenCodeOptions): OpenCodeClient {
    return new OpenCodeClient(options)
  }

  async #run<K extends Operation>(operation: K, params: Params<K>, signal?: AbortSignal): Promise<Result<K>> {
    const effect = Effect.gen(function* () {
      const session = yield* OpenCodeSession
      return yield* (session[operation] as (input: Params<K>) => Effect.Effect<Result<K>, WorkerFailure>)(params)
    })
    const exit = await this.#runtime.runPromiseExit(effect, signal ? { signal } : undefined)
    if (Exit.isSuccess(exit)) return exit.value
    throw new OpenCodeFailure(toFailure(exit.cause))
  }

  open(params: Params<'open'>, options?: { signal?: AbortSignal }) {
    return this.#run('open', params, options?.signal)
  }
  send(params: Params<'send'>, options?: { signal?: AbortSignal }) {
    return this.#run('send', params, options?.signal)
  }
  cancel(params: Params<'cancel'>, options?: { signal?: AbortSignal }) {
    return this.#run('cancel', params, options?.signal)
  }
  answer(params: Params<'answer'>, options?: { signal?: AbortSignal }) {
    return this.#run('answer', params, options?.signal)
  }
  history(params: Params<'history'>, options?: { signal?: AbortSignal }) {
    return this.#run('history', params, options?.signal)
  }
  childTranscript(params: Params<'childTranscript'>, options?: { signal?: AbortSignal }) {
    return this.#run('childTranscript', params, options?.signal)
  }

  /** Provider events as an AsyncIterable; ends when the client is disposed. */
  events(): AsyncIterable<ProviderEvent> {
    const runtime = this.#runtime
    return {
      [Symbol.asyncIterator]: () => {
        let iterator: AsyncIterator<ProviderEvent> | undefined
        const start = async () =>
          (iterator ??= Stream.toAsyncIterableWith(
            Stream.unwrap(
              Effect.gen(function* () {
                return (yield* OpenCodeSession).events
              }),
            ),
            await runtime.context(),
          )[Symbol.asyncIterator]())
        return {
          next: async () => (await start()).next(),
          return: async (value?: unknown) =>
            (await start()).return?.(value) ?? { done: true as const, value: undefined },
        }
      },
    }
  }

  /** Closes the session scope: the owned OpenCode server is stopped and its exit confirmed. */
  dispose(): Promise<void> {
    return this.#runtime.dispose()
  }
}
