// R002 for remote.host.install: the install copies backend binaries to a host
// over SSH (a local fake SSH here). Its operation ID replays the recorded reply
// without uploading again, also after a daemon crash, and another payload under
// it is a strict conflict.
import { expect, test } from '../fixtures/remote-hosts'
import { addAndPair } from '../remote/steps'

test('R002: remote.host.install replays one operation ID and refuses it for another host, also after a daemon crash', async ({ remote }) => {
  test.setTimeout(300_000)
  const profile = await remote.profile()
  const host = await remote.host('bare', { artifacts: [] })
  await addAndPair(profile, host, 'bare')
  const uploads = () => remote.calls().then((calls) => calls.filter((call) => call.remote_command?.includes('ade-installed'))
    .length)
  const install = (hostId: string) => profile.call('remote.host.install', { host_id: hostId, operation_id: 'core-install' },
    { timeoutMs: 250_000 })

  const first = await install('bare')
  expect(first).toMatchObject({ outcome: 'installed', host_id: 'bare' })
  const uploaded = await uploads()
  expect(await install('bare')).toEqual(first)
  await expect(install('elsewhere')).rejects.toThrow(/already used for different parameters/)

  await profile.restartDaemon('kill')
  expect(await install('bare')).toEqual(first)
  await expect(install('elsewhere')).rejects.toThrow(/already used for different parameters/)
  expect(await uploads()).toBe(uploaded)
})

test('R001: an install held on the host when the local daemon crashes is reported unknown and never sent again', async ({ remote }) => {
  test.setTimeout(300_000)
  const profile = await remote.profile()
  const host = await remote.host('bare', { artifacts: [] })
  await addAndPair(profile, host, 'bare')
  const request = { host_id: 'bare', operation_id: 'core-held-install' }
  const remoteCommands = () => remote.calls().then((calls) => calls.filter((call) => call.remote_command).length)

  await host.holdCommands()
  const lost = profile.call('remote.host.install', request, { timeoutMs: 250_000 }).catch((error: unknown) => error)
  await expect.poll(async () => (await remote.calls()).some((call) => call.held !== undefined)).toBe(true)
  await profile.killDaemon()
  expect(await lost).toBeInstanceOf(Error)
  await host.releaseCommands()
  await profile.restartDaemon()

  const sent = await remoteCommands()
  const retried = await profile.call('remote.host.install', request, { timeoutMs: 250_000 })
  expect(retried).toMatchObject({ outcome: 'unknown', host_id: 'bare' })
  expect(await profile.call('remote.host.install', request, { timeoutMs: 250_000 })).toEqual(retried)
  expect(await remoteCommands()).toBe(sent)
})
