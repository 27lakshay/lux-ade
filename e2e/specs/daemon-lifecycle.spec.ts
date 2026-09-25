import { expect, test } from '@playwright/test'
import { rpc, startDaemon } from '../fixtures/daemon'

test('starts an isolated real daemon and reads its public catalog', async () => {
  const daemon = await startDaemon()
  try {
    expect(daemon.hello.application_protocol).toBe('ade-application-v1')
    expect(daemon.hello.runtime_protocol).toBe('ade-runtime-v8')
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    expect(catalog.type).toBe('catalog')
    expect(catalog.boot_id).toBe(daemon.hello.boot_id)
    expect(catalog.catalog).toBeTruthy()
  } finally {
    await daemon.stop()
  }
})
