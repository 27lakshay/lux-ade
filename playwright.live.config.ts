import { defineConfig } from '@playwright/test'

process.env.ADE_E2E_HIDE_WINDOW = '1'
// Specs must not inherit a profile, socket or data directory from the caller.
for (const name of ['ADE_SOCKET', 'ADE_PROFILES_HOME', 'ADE_RUNTIME_HOME', 'ADE_DATA_DIR', 'ADE_ROOT', 'ADE_DAEMON_BIN']) {
  delete process.env[name]
}
delete process.env.NO_COLOR

export default defineConfig({
  testDir: './e2e/live',
  timeout: 150_000,
  workers: 1,
  reporter: [['list']],
})
