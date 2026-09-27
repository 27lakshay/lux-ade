// R001 and R002 for the effect commands in `effects.ts`, each checked the same
// way against a real daemon, runtime and Git:
//
// - R002: the same operation ID and payload returns the recorded outcome and
//   applies the effect once; the same ID with one field changed is a
//   conflict that applies nothing. Both hold again after a daemon SIGKILL.
// - R001: a request whose reply is lost is followed by a daemon SIGKILL at
//   three points: at once (usually before admission), after the effect is
//   visible (after settlement), and, for commands settled by a Git worker,
//   while the worker holds the dispatched command. The retry returns a
//   recorded outcome or an explicit unknown; it never runs the command twice.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type AdeHarness } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { call, effectCases, pauseEnvironment, type Context, type EffectCase } from './effects'

const CONFLICT = /different (parameters|request)|conflicts with another/

async function context(ade: AdeHarness): Promise<Context> {
  const profile = await ade.profile({ env: pauseEnvironment(ade.root) })
  return { ade, profile, repo: await ade.repo() }
}

const UNKNOWN = /outcome is unknown|will not run again|was interrupted/

/**
 * Send the command and read its settled outcome. A daemon that reports an
 * interrupted command in its error frame (outcome unknown, or known to have
 * changed nothing) yields `{ unknown: message }`.
 */
async function attempt(effect: EffectCase, ctx: Context, state: unknown, id: string, request: Record<string, unknown>) {
  let reply: unknown
  try {
    reply = await call(ctx.profile, effect.op, request)
  } catch (error) {
    if (UNKNOWN.test(String(error))) return { unknown: String(error) }
    throw error
  }
  return effect.outcome(ctx, state, id, reply)
}

function unknown(effect: EffectCase, outcome: Record<string, unknown>): boolean {
  return 'unknown' in outcome || effect.unknown(outcome)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

for (const effect of effectCases) {
  test.describe(effect.op, () => {
    test(`R002: ${effect.op} replays one ID and refuses it for another payload, also after a daemon crash`, async ({
      ade,
    }) => {
      const ctx = await context(ade)
      const state = await effect.setup(ctx)
      const base = await effect.effect(ctx, state)
      const request = effect.request(state, 'reliability-1', false)
      const first = await attempt(effect, ctx, state, 'reliability-1', request)
      expect(unknown(effect, first), JSON.stringify(first)).toBe(false)
      expect(await effect.effect(ctx, state), JSON.stringify(first)).toBe(base + 1)

      expect(await attempt(effect, ctx, state, 'reliability-1', request)).toEqual(first)
      await expect(call(ctx.profile, effect.op, effect.request(state, 'reliability-1', true))).rejects.toThrow(CONFLICT)

      await ctx.profile.restartDaemon('kill')
      expect(await attempt(effect, ctx, state, 'reliability-1', request)).toEqual(first)
      await expect(call(ctx.profile, effect.op, effect.request(state, 'reliability-1', true))).rejects.toThrow(CONFLICT)
      expect(await effect.effect(ctx, state)).toBe(base + 1)
    })

    for (const point of ['at once', 'after the effect'] as const) {
      test(`R001: ${effect.op} with a lost reply and a daemon crash ${point} runs once`, async ({ ade }) => {
        const ctx = await context(ade)
        const state = await effect.setup(ctx)
        const base = await effect.effect(ctx, state)
        const request = effect.request(state, 'reliability-lost', false)
        await sendAndLoseReply(ctx.profile, { op: effect.op, ...request })
        if (point === 'after the effect') {
          await expect.poll(() => effect.effect(ctx, state), { timeout: 30_000 }).toBe(base + 1)
        }
        await ctx.profile.killDaemon()
        await ctx.profile.restartDaemon()

        const outcome = await attempt(effect, ctx, state, 'reliability-lost', request)
        const applied = (await effect.effect(ctx, state)) - base
        if (/nothing changed/.test(String(outcome.unknown))) expect(applied, JSON.stringify(outcome)).toBe(0)
        else if (unknown(effect, outcome)) expect(applied, JSON.stringify(outcome)).toBeLessThanOrEqual(1)
        else expect(applied, JSON.stringify(outcome)).toBe(1)
        // A further retry reads the same outcome and applies nothing more.
        expect(await attempt(effect, ctx, state, 'reliability-lost', request)).toEqual(outcome)
        expect((await effect.effect(ctx, state)) - base).toBe(applied)
        await expect(call(ctx.profile, effect.op, effect.request(state, 'reliability-lost', true))).rejects.toThrow(
          CONFLICT,
        )
      })
    }

    if (effect.pause) {
      test(`R001: ${effect.op} dispatched to a Git worker when the daemon crashes is reported unknown and never rerun`, async ({
        ade,
      }) => {
        const ctx = await context(ade)
        const state = await effect.setup(ctx)
        const base = await effect.effect(ctx, state)
        const pause = pauseEnvironment(ade.root)[
          effect.pause === 'review' ? 'ADE_E2E_REVIEW_PAUSE_DIR' : 'ADE_E2E_WORKER_PAUSE_DIR'
        ]
        await mkdir(pause, { recursive: true })
        await writeFile(join(pause, 'armed'), '')
        const request = effect.request(state, 'reliability-held', false)
        await call(ctx.profile, effect.op, request)
        await expect.poll(() => exists(join(pause, 'signal')), { timeout: 30_000 }).toBe(true)
        // The command is admitted and dispatched; its worker has not run Git yet.
        expect(await effect.effect(ctx, state)).toBe(base)
        await ctx.profile.killDaemon()
        await ctx.profile.restartDaemon()

        const outcome = await attempt(effect, ctx, state, 'reliability-held', request)
        expect(unknown(effect, outcome), JSON.stringify(outcome)).toBe(true)
        // Let the orphaned worker go; whatever it does, the daemon never runs the command again.
        await writeFile(join(pause, 'release'), '')
        if (effect.pause === 'review') {
          // The unknown stays listed for the person until acknowledged; acknowledging never reruns it.
          const workspaceId = request.workspace_id as string
          const listed = await ctx.profile.call('review.operation.list', { workspace_id: workspaceId })
          expect(listed.operations.map((entry) => [entry.operation.id, entry.operation.status])).toContainEqual([
            'reliability-held',
            'interrupted',
          ])
          await ctx.profile.call('review.operation.acknowledge', {
            workspace_id: workspaceId,
            operation_id: 'reliability-held',
          })
          expect(
            (await ctx.profile.call('review.operation.list', { workspace_id: workspaceId })).operations.map(
              (entry) => entry.operation.id,
            ),
          ).not.toContain('reliability-held')
        }
        expect(await attempt(effect, ctx, state, 'reliability-held', request)).toEqual(outcome)
        expect((await effect.effect(ctx, state)) - base).toBeLessThanOrEqual(1)
        await expect(call(ctx.profile, effect.op, effect.request(state, 'reliability-held', true))).rejects.toThrow(
          CONFLICT,
        )
      })
    }
  })
}
