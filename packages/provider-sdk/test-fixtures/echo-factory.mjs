// A minimal ProviderFactory for the harness's `factoryModule` target: it opens sessions and
// answers each prompt with one delta, through the SDK's own runner. Cancel and answer are
// declared unsupported, so their checks are reported as not exercised.
import { Effect, Layer, Queue, Stream } from 'effect'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from '../dist/index.js'

const unsupported = 'The echo provider has no native turns to interrupt or requests to answer'
const operations = [
  ['initialize', 'query', true],
  ['open', 'effect_command', true],
  ['send', 'effect_command', true],
  ['steer', 'effect_command', false],
  ['cancel', 'idempotent_command', false],
  ['answer', 'effect_command', false],
  ['history', 'query', false],
]

export function echoProvider() {
  return {
    descriptor: {
      compatible_protocol_versions: [2],
      name: 'Echo factory',
      capabilities: [],
      permission_modes: ['default'],
      operations: operations.map(([method, tier, available]) => ({
        method,
        tier,
        availability: available ? 'available' : 'unsupported',
        reason: available ? '' : unsupported,
      })),
      limits: DEFAULT_LIMITS,
      requirements: SDK_REQUIREMENTS,
    },
    dependencies: Layer.empty,
    acquire: Effect.gen(function* () {
      const events = yield* Queue.unbounded()
      const sessions = new Set(['echo-session'])
      const results = new Map()
      return {
        events: Stream.fromQueue(events),
        open: ({ resume }) =>
          resume === null || sessions.has(resume)
            ? Effect.succeed({ session: resume ?? 'echo-session', history: [] })
            : Effect.fail({ code: 'invalid_request', message: 'Unknown echo session' }),
        send: ({ session, submission, text }) =>
          Effect.gen(function* () {
            const known = results.get(submission)
            if (known) return known
            const result = { admitted: true, dispatch: 'dispatched', native_outcome: 'pending', turn: null }
            results.set(submission, result)
            const base = { session, submission, turn: null }
            yield* Queue.offerAll(events, [
              { type: 'started', ...base },
              {
                type: 'submitted',
                submission,
                turn: null,
                admitted: true,
                dispatch: 'dispatched',
                native_outcome: 'accepted',
              },
              { type: 'delta', ...base, id: `echo-${submission}`, kind: 'text', role: 'assistant', text },
              { type: 'finished', ...base, status: 'completed', error: null, interrupt_requested: false },
            ])
            return result
          }),
      }
    }),
  }
}
