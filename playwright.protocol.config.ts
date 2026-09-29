import { reporting } from './e2e/reporting'
import { availableParallelism } from 'node:os'
import { defineConfig } from '@playwright/test'
import { suites } from './e2e/suites'

// Headless backend E2E: real daemon and runtime processes, no Electron.
// Specs must not inherit a profile, socket or data directory from the caller.
for (const name of [
  'ADE_SOCKET',
  'ADE_PROFILES_HOME',
  'ADE_RUNTIME_HOME',
  'ADE_DATA_DIR',
  'ADE_ROOT',
  'ADE_DAEMON_BIN',
]) {
  delete process.env[name]
}
// Playwright forces color in workers. Inherited NO_COLOR makes every child Node
// CLI print a warning before its structured JSON error on stderr.
delete process.env.NO_COLOR

const requested = Number(process.env.ADE_E2E_WORKERS)
// Bound automatic concurrency to the largest locally measured complete-suite setting.
const workers =
  Number.isInteger(requested) && requested > 0
    ? requested
    : Math.max(1, Math.min(5, Math.floor(availableParallelism() / 2)))

export default defineConfig({
  ...suites.protocol,
  outputDir: './test-results/protocol',
  fullyParallel: true,
  workers,
  // Keep the first failure: a retry would hide a flake instead of reporting it.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  reporter: [['list']],
  // After every run, the slowest spec files: where a long suite spends its time.
  reportSlowTests: { max: 15, threshold: 10_000 },
  ...reporting('protocol'),
})
