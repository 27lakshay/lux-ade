import { defineConfig } from '@playwright/test'

process.env.ADE_E2E_HIDE_WINDOW = '1'

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
})
