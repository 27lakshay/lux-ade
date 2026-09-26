import { defineConfig } from '@playwright/test'

process.env.ADE_E2E_HIDE_WINDOW = '1'
// Playwright forces color in workers. Inherited NO_COLOR makes every child Node
// CLI print a warning before its structured JSON error on stderr.
delete process.env.NO_COLOR

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
})
