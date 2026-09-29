import { reporting } from './e2e/reporting'
import { defineConfig } from '@playwright/test'
import { suites } from './e2e/suites'

// Desktop E2E: the built Electron app against a scratch daemon and runtime with the provider
// mocks (e2e/desktop/README.md). Windows stay hidden and no debugging port is opened.
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

export default defineConfig({
  ...suites.desktop,
  outputDir: './test-results/desktop',
  fullyParallel: true,
  // Each test runs an Electron app beside a daemon and a runtime: two at a time by default.
  workers: Number.isInteger(requested) && requested > 0 ? requested : 2,
  // Keep the first failure: a retry would hide a flake instead of reporting it.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  reporter: [['list']],
  ...reporting('desktop'),
})
