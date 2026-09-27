// R001 and R002 for the two HostResources effect commands at the point where
// their effect has committed and their reply is not yet final:
//
// - resources.claim.resolve removes the claim and records its reply in one
//   transaction; the pause sits after that commit, before the reply goes out.
// - resources.registry.accept commits the binding with its receipt
//   acknowledged, then records the reply in a second write; the pause sits
//   between the two writes.
//
// The daemon's debug-only pause point (`ADE_E2E_RECEIPT_PAUSE_DIR`, see
// `receipts::e2e_pause`) holds the command there. The spec SIGKILLs the daemon
// while it waits, then retries the same operation ID twice with a daemon
// SIGKILL between the retries. Every reply names the daemon incarnation, so a
// retry that answered from the registry as it reads now would differ between
// the two; each retry must return one settled reply, with the effect applied
// once.
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { call, pauseEnvironment } from '../reliability-a/effects'
import { domainCases, type Context } from './domain-cases'

const CONFLICT = /different (parameters|request)|conflicts with another|already used for a different/

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

for (const op of ['resources.claim.resolve', 'resources.registry.accept']) {
  const effect = domainCases.find((entry) => entry.op === op)!

  test(`R001: ${op} with a daemon crash after its effect committed, before its reply was final, replays one settled reply`, async ({ ade }) => {
    const pause = join(ade.root, 'pause-receipt')
    await mkdir(pause, { recursive: true })
    const profile = await ade.profile({ env: { ...pauseEnvironment(ade.root), ADE_E2E_RECEIPT_PAUSE_DIR: pause } })
    const ctx: Context = { ade, profile, repo: await ade.repo() }
    const state = await effect.setup(ctx)
    const base = await effect.effect(ctx, state)
    const request = effect.request(state, 'reply-record', false)

    await writeFile(join(pause, `${op}.armed`), '')
    await sendAndLoseReply(profile, { op, ...request })
    await expect.poll(() => exists(join(pause, `${op}.paused`)), { timeout: 30_000 }).toBe(true)
    await profile.killDaemon()
    // Nothing is armed for the daemons that follow.
    await rm(join(pause, `${op}.armed`))
    await profile.restartDaemon()
    const incarnation = profile.hello.boot_id

    const first = await call(profile, op, request)
    expect(await effect.effect(ctx, state)).toBe(base + 1)
    expect(first).toMatchObject({ type: 'host_resources' })

    await profile.restartDaemon('kill')
    expect(profile.hello.boot_id).not.toBe(incarnation)
    const second = await call(profile, op, request)
    expect(second).toEqual(first)
    await expect(call(profile, op, effect.request(state, 'reply-record', true))).rejects.toThrow(CONFLICT)
    expect(await effect.effect(ctx, state)).toBe(base + 1)
  })
}
