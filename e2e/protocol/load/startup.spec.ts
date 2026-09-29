import { test, expect } from '../fixtures/performance'
import { TerminalStream, primaryShell } from '../fixtures/terminals'
import { terminalEcho } from '../fixtures/load'

test('startup: five fresh profiles reach hello, catalog and a responding shell @load', async ({
  ade,
  measurements,
}) => {
  test.setTimeout(120_000)
  measurements.details.workload = {
    samples: 5,
    cache: 'warm binaries and OS cache; fresh profile/home/database per sample',
    ready: [
      'hello includes runtime identity',
      'catalog query succeeds',
      'terminal snapshot received',
      'shell arithmetic result observed',
    ],
    input: 'one arithmetic echo per profile',
  }
  for (let sample = 0; sample < 5; sample++) {
    let stop: (() => Promise<void>) | undefined
    try {
      await measurements.measure(`startup.${sample}.ready`, async () => {
        const profile = await measurements.measure(`startup.${sample}.hello`, () => ade.profile())
        stop = () => profile.stop()
        expect(profile.hello.runtime_pid).toBeGreaterThan(0)
        expect(profile.hello.runtime_instance).toBeTruthy()
        await measurements.measure(`startup.${sample}.catalog`, () => profile.call('catalog.get', {}))
        const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
        const terminal = await primaryShell(profile, workspace.id)
        const stream = TerminalStream.open(profile, workspace.id, terminal)
        try {
          await measurements.measure(`startup.${sample}.snapshot`, () => stream.snapshot())
          await terminalEcho(stream, 1, 900_000 + sample, (observation) =>
            measurements.record({ ...observation, name: `startup.${sample}.${observation.name}` }),
          )
        } finally {
          stream.close()
        }
        if (process.env.ADE_PERFORMANCE_DIAGNOSTICS === '1') {
          const status = await profile.call('diagnostics.status', {})
          measurements.details[`resources.${sample}`] = status.resources
          expect(status.resources.observed).toBe(true)
        }
      })
    } finally {
      await stop?.()
    }
  }
})
