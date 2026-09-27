// R001 and R002 for the 21 effect commands whose receipts the daemon's
// envelope keeps (crates/ade-daemon/src/envelope.rs), each checked the same
// way against a real daemon and runtime:
//
// - R002: the same operation ID and payload returns the recorded reply and
//   applies the effect once; the same ID with one field changed is a strict
//   conflict that applies nothing. Both hold on new connections and again
//   after a daemon SIGKILL.
// - R001: the daemon is SIGKILLed at each step between admission and
//   settlement: after the intent commits, after dispatch is recorded but
//   before the handler runs, and after the handler has acted but before the
//   outcome is recorded. The retry returns an explicit outcome ("not applied"
//   or unknown), or the outcome reconciled from the current state; the
//   command is never run a second time.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type AdeHarness } from '../fixtures'
import { call, envelopeCases, type Context, type EnvelopeCase, type Fields } from './envelope-cases'

const CONFLICT = /was already used for a different request/

function pauseDirectory(ade: AdeHarness): string {
  return join(ade.root, 'pause-envelope')
}

async function context(ade: AdeHarness): Promise<Context> {
  const profile = await ade.profile({
    env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_ENVELOPE_PAUSE_DIR: pauseDirectory(ade) },
  })
  return { ade, profile, repo: await ade.repo() }
}

type Outcome = { reply: unknown } | { error: { code: string; message: string; delivery?: string } }

/** The daemon's reply, or its error frame's code and message. */
async function attempt(ctx: Context, op: string, request: Fields): Promise<Outcome> {
  try {
    return { reply: await call(ctx.profile, op, request) }
  } catch (error) {
    const failure = error as { code: string; message: string }
    return { error: { code: failure.code, message: failure.message } }
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Wait until the observed effect differs from `before`, and return it. */
async function applied(effect: EnvelopeCase, ctx: Context, state: unknown, before: unknown): Promise<unknown> {
  let after: unknown
  await expect
    .poll(
      async () => {
        after = await effect.observe(ctx, state)
        return JSON.stringify(after) !== JSON.stringify(before)
      },
      { timeout: 30_000, message: `${effect.op} to take effect` },
    )
    .toBe(true)
  return after
}

async function refusesAlteredPayload(effect: EnvelopeCase, ctx: Context, state: unknown, id: string): Promise<void> {
  const conflict = await attempt(ctx, effect.op, { ...effect.request(state, true), operation_id: id })
  expect(conflict, JSON.stringify(conflict)).toMatchObject({
    error: { code: 'conflict', message: expect.stringMatching(CONFLICT) },
  })
}

for (const effect of envelopeCases) {
  test.describe(effect.op, () => {
    test(`R002: ${effect.op} replays one operation ID, refuses it for another payload, also after a daemon crash`, async ({
      ade,
    }) => {
      const ctx = await context(ade)
      const state = await effect.setup(ctx)
      const request = { ...effect.request(state, false), operation_id: 'core-replay' }
      const before = await effect.observe(ctx, state)

      const first = await attempt(ctx, effect.op, request)
      expect(first, JSON.stringify(first)).toHaveProperty('reply')
      let expected = await applied(effect, ctx, state, before)
      if (effect.reset) {
        // Undo the effect under another ID: a rerun of the original ID would redo it.
        const done = expected
        await effect.reset(ctx, state)
        expected = await effect.observe(ctx, state)
        expect(expected).not.toEqual(done)
      }

      expect(await attempt(ctx, effect.op, request)).toEqual(first)
      expect(await effect.observe(ctx, state)).toEqual(expected)
      await refusesAlteredPayload(effect, ctx, state, 'core-replay')

      await ctx.profile.restartDaemon('kill')
      expect(await attempt(ctx, effect.op, request)).toEqual(first)
      await refusesAlteredPayload(effect, ctx, state, 'core-replay')
      expect(await effect.observe(ctx, state)).toEqual(expected)
    })

    for (const point of ['admitted', 'dispatched', 'ran'] as const) {
      test(`R001: ${effect.op} interrupted by a daemon crash once ${point} is never run again`, async ({ ade }) => {
        const ctx = await context(ade)
        const state = await effect.setup(ctx)
        const request = { ...effect.request(state, false), operation_id: `core-${point}` }
        const before = await effect.observe(ctx, state)
        const pause = pauseDirectory(ade)
        await mkdir(pause, { recursive: true })
        await writeFile(join(pause, point), '')

        const lost = attempt(ctx, effect.op, request)
        await expect.poll(() => exists(join(pause, `${point}.reached`)), { timeout: 30_000 }).toBe(true)
        const effectAtCrash = point === 'ran' ? await applied(effect, ctx, state, before) : before
        await ctx.profile.killDaemon()
        // The caller never learned the outcome.
        expect(await lost).toMatchObject({ error: { code: expect.any(String) } })
        await ctx.profile.restartDaemon()
        // Before any retry, the new daemon already lists a possibly applied command as unknown.
        const listed = async () =>
          (await ctx.profile.call('diagnostics.status', {})).unknown.some(
            (entry) => entry.subject === request.operation_id && entry.operation === effect.op,
          )
        expect(await listed()).toBe(point !== 'admitted')

        const outcome = await attempt(ctx, effect.op, request)
        if (point === 'admitted') {
          // The intent was recorded but the command never reached its handler.
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            error: {
              code: 'not_applied',
              message: expect.stringMatching(/interrupted before it ran; nothing changed/),
            },
          })
        } else if (point === 'ran' && effect.reconciles) {
          // The current state proves the effect, so the receipt settles with its reply.
          expect(outcome, JSON.stringify(outcome)).toEqual({ reply: { type: 'ack' } })
        } else {
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            error: {
              code: 'outcome_unknown',
              message: expect.stringMatching(/outcome of operation core-\w+ is unknown/),
            },
          })
        }
        expect(await effect.observe(ctx, state)).toEqual(effectAtCrash)
        // A reconciled command leaves the unknown list; an unresolved one stays on it.
        expect(await listed()).toBe(point !== 'admitted' && !(point === 'ran' && effect.reconciles))

        // A further retry reads the same outcome and changes nothing.
        expect(await attempt(ctx, effect.op, request)).toEqual(outcome)
        expect(await effect.observe(ctx, state)).toEqual(effectAtCrash)
        await refusesAlteredPayload(effect, ctx, state, `core-${point}`)
      })
    }
  })
}
