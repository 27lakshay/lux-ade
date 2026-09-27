// F138: configured retention. The service log idle limit and the diagnostic
// log age limit are set per profile under a revision guard. The preview and
// apply follow the configured policy, a preview made under another policy
// cannot apply, and active resources stay whatever the limits say.
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { age, DAY_MS, diagnosticLogDirectory, names, plantDiagnosticLog, plantOrphanServiceLog, serviceLogDirectory,
  startService } from '../ops/steps'

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

async function policy(profile: ScratchProfile) {
  return profile.call('retention.policy.get', {})
}

test('F138: a configured policy selects what the defaults keep, and a preview under the old policy cannot apply', async ({ profile, repo }) => {
  const defaults = await policy(profile)
  expect(defaults.policy).toMatchObject({ revision: 0, service_log_idle_ms: 7 * DAY_MS, diagnostic_log_max_age_ms: 30 * DAY_MS })
  expect(defaults.configured).toEqual({ service_log_idle_ms: null, diagnostic_log_max_age_ms: null })

  // A live service whose log is older than any limit below: an active resource.
  const live = await startService(profile, repo.path, 'web')
  for (const file of await names(serviceLogDirectory(profile))) {
    if (live.logKeys.some((key) => file.startsWith(key))) await age(join(serviceLogDirectory(profile), file), 4)
  }
  const orphan = await plantOrphanServiceLog(profile, 3)
  const rotated = await plantDiagnosticLog(profile, 'e2e-proc', '2026-09-01', 10)
  const current = await plantDiagnosticLog(profile, 'e2e-proc', '2026-09-02', 10)

  // The defaults keep all of them.
  const before = await profile.call('retention.preview', {})
  expect(before.policy.revision).toBe(0)
  expect(before.candidates.map((candidate) => candidate.id)).not.toContain(orphan)
  expect(before.candidates.map((candidate) => candidate.id)).not.toContain(rotated)

  // Out-of-range limits and a stale revision are refused and change nothing.
  await expect(profile.call('retention.policy.set', { expected_revision: 0, service_log_idle_ms: DAY_MS - 1 }))
    .rejects.toThrow(/between 1 and 365 days/)
  await expect(profile.call('retention.policy.set', { expected_revision: 0, diagnostic_log_max_age_ms: 366 * DAY_MS }))
    .rejects.toThrow(/between 1 and 365 days/)
  await expect(profile.call('retention.policy.set', { expected_revision: 4, service_log_idle_ms: 2 * DAY_MS }))
    .rejects.toThrow(/changed since revision 4/)
  expect((await policy(profile)).policy.revision).toBe(0)

  const change = { expected_revision: 0, service_log_idle_ms: 2 * DAY_MS, diagnostic_log_max_age_ms: 5 * DAY_MS }
  const set = await profile.call('retention.policy.set', change)
  expect(set).toMatchObject({ changed: true, policy: { revision: 1, service_log_idle_ms: 2 * DAY_MS,
    diagnostic_log_max_age_ms: 5 * DAY_MS }, configured: { service_log_idle_ms: 2 * DAY_MS, diagnostic_log_max_age_ms: 5 * DAY_MS } })
  // A retry after a lost reply converges; another writer at the old revision is refused.
  expect(await profile.call('retention.policy.set', change)).toMatchObject({ changed: false, policy: { revision: 1 } })
  await expect(profile.call('retention.policy.set', { expected_revision: 0, service_log_idle_ms: 3 * DAY_MS }))
    .rejects.toThrow(/changed since revision 0; it is at revision 1/)

  // The preview made under the defaults no longer names the current set.
  await expect(profile.call('retention.apply', { generation: before.generation })).rejects.toThrow(/changed since the preview/)
  expect(await exists(join(serviceLogDirectory(profile), `${orphan}.0`))).toBe(true)

  // The policy survives a daemon crash.
  await profile.restartDaemon('kill')
  expect((await policy(profile)).policy).toMatchObject({ revision: 1, service_log_idle_ms: 2 * DAY_MS })

  const after = await profile.call('retention.preview', {})
  expect(after.policy).toMatchObject({ revision: 1, service_log_idle_ms: 2 * DAY_MS, diagnostic_log_max_age_ms: 5 * DAY_MS })
  const ids = after.candidates.map((candidate) => candidate.id)
  expect(ids).toContain(orphan)
  expect(ids).toContain(rotated)
  // A process's current log and a live service's log stay under any limit.
  expect(ids).not.toContain(current)
  for (const key of live.logKeys) expect(ids).not.toContain(key)
  expect(after.reclaimable_bytes).toBeGreaterThan(0)

  const applied = await profile.call('retention.apply', { generation: after.generation })
  expect(applied).toMatchObject({ complete: true, replayed: false })
  expect(applied.results.map((result) => result.id).sort()).toEqual([...ids].sort())
  expect(await exists(join(serviceLogDirectory(profile), `${orphan}.0`))).toBe(false)
  expect(await exists(join(diagnosticLogDirectory(profile), rotated))).toBe(false)
  expect(await exists(join(diagnosticLogDirectory(profile), current))).toBe(true)
  const remaining = await names(serviceLogDirectory(profile))
  for (const key of live.logKeys) expect(remaining.some((file) => file.startsWith(key))).toBe(true)
})

test('F138: the CLI shows and configures the policy, and an omitted limit returns to its default', async ({ profile }) => {
  const shown = await profile.cli('retention', 'policy')
  expect(shown.code, shown.stderr).toBe(0)
  expect(shown.json).toMatchObject({ type: 'retention_policy', policy: { revision: 0 } })
  const set = await profile.cli('retention', 'policy', 'set', '0', '--service-log-idle-days', '14')
  expect(set.code, set.stderr).toBe(0)
  expect(set.json).toMatchObject({ changed: true, policy: { revision: 1, service_log_idle_ms: 14 * DAY_MS,
    diagnostic_log_max_age_ms: 30 * DAY_MS } })
  const stale = await profile.cli('retention', 'policy', 'set', '0', '--diagnostic-log-days', '9')
  expect(stale.code).not.toBe(0)
  expect(JSON.stringify(stale.json)).toMatch(/changed since revision 0/)
  const reset = await profile.cli('retention', 'policy', 'set', '1')
  expect(reset.json).toMatchObject({ changed: true, policy: { revision: 2, service_log_idle_ms: 7 * DAY_MS },
    configured: { service_log_idle_ms: null, diagnostic_log_max_age_ms: null } })
  expect((await profile.call('retention.preview', {})).policy.revision).toBe(2)
})
