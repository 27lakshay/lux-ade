import { expect, test } from '../fixtures'
import { rpc, startDaemon } from '../../fixtures/daemon'

test('the live desktop daemon starts in isolation from an inherited ADE secret-store setting', async () => {
  const previous = process.env.ADE_SECRET_STORE
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  let startupError: unknown
  try {
    // Invalid rather than a real Keychain/profile: the old helper must fail without touching one.
    process.env.ADE_SECRET_STORE = 'inherited-store-must-not-be-used'
    try {
      daemon = await startDaemon()
    } catch (error) {
      startupError = error
    } finally {
      if (previous === undefined) delete process.env.ADE_SECRET_STORE
      else process.env.ADE_SECRET_STORE = previous
    }
    expect(startupError).toBeUndefined()
    expect(daemon).toBeDefined()
    const hello = await rpc(daemon!.socket, { op: 'hello' })
    expect(hello.runtime_instance).toBe(daemon!.hello.runtime_instance)
  } finally {
    await daemon?.stop()
  }
})
