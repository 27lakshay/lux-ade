import { reporting } from './e2e/reporting'
import { defineConfig } from '@playwright/test'
import { suites } from './e2e/suites'

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
delete process.env.NO_COLOR

export default defineConfig({
  projects: [
    { name: 'package-protocol', ...suites.packageProtocol },
    { name: 'package-desktop', ...suites.packageDesktop },
    { name: 'package-desktop-current', ...suites.packageDesktopCurrent },
  ],
  globalSetup: './e2e/setup/package.ts',
  outputDir: './test-results/package',
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  ...reporting('package'),
})
