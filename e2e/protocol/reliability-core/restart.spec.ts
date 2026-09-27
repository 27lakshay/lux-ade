// R001 and R002 for runtime.prepare_restart, the one enveloped effect command
// that ends its own daemon. Its receipt lives in the profile database, so the
// daemon that takes over answers a retry of the handover with the recorded
// reply instead of draining itself as well.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'

async function attempt(profile: ScratchProfile, request: Record<string, unknown>) {
  try {
    return { reply: await profile.call('runtime.prepare_restart', request as never) }
  } catch (error) {
    const failure = error as { code: string; message: string }
    return { error: { code: failure.code, message: failure.message } }
  }
}

/** The running daemon is serving and not draining. */
async function serving(profile: ScratchProfile) {
  const status = await profile.call('runtime.status', {})
  return { stopping: status.stopping, boot: status.boot_id }
}

test('R002: a handover retried under its operation ID returns the recorded reply and never drains the next daemon', async ({
  profile,
}) => {
  const first = profile.hello
  const request = { operation_id: 'core-handover', boot_id: first.boot_id }
  const prepared = await attempt(profile, request)
  expect(prepared).toMatchObject({ reply: { boot_id: first.boot_id, runtime_instance: first.runtime_instance } })
  await expect.poll(() => profile.daemonRunning).toBe(false)

  const next = await profile.restartDaemon()
  expect(next.runtime_instance).toBe(first.runtime_instance)
  expect(await attempt(profile, request)).toEqual(prepared)
  expect(await serving(profile)).toEqual({ stopping: false, boot: next.boot_id })
  await expect(
    profile.call('runtime.prepare_restart', { operation_id: 'core-handover', boot_id: next.boot_id }),
  ).rejects.toThrow(/was already used for a different request/)

  await profile.restartDaemon('kill')
  expect(await attempt(profile, request)).toEqual(prepared)
  expect((await serving(profile)).stopping).toBe(false)
})

for (const point of ['admitted', 'dispatched', 'ran'] as const) {
  test(`R001: a handover interrupted by a daemon crash once ${point} is reported and never run again`, async ({
    ade,
  }) => {
    const pause = join(ade.root, 'pause-envelope')
    const profile = await ade.profile({ env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_ENVELOPE_PAUSE_DIR: pause } })
    const request = { operation_id: `core-handover-${point}`, boot_id: profile.hello.boot_id }
    await mkdir(pause, { recursive: true })
    await writeFile(join(pause, point), '')
    const lost = attempt(profile, request)
    await expect
      .poll(() =>
        access(join(pause, `${point}.reached`)).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await profile.killDaemon()
    expect(await lost).toHaveProperty('error')
    const next = await profile.restartDaemon()

    const outcome = await attempt(profile, request)
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      error:
        point === 'admitted'
          ? { code: 'not_applied', message: expect.stringMatching(/nothing changed/) }
          : { code: 'outcome_unknown', message: expect.stringMatching(/is unknown/) },
    })
    expect(await attempt(profile, request)).toEqual(outcome)
    // The retry drained nothing: the new daemon keeps serving.
    expect(await serving(profile)).toEqual({ stopping: false, boot: next.boot_id })
  })
}
