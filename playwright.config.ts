import { defineConfig } from '@playwright/test'

process.env.ADE_E2E_HIDE_WINDOW = '1'
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

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
})
