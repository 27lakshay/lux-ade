import { defineConfig } from '@playwright/test'

process.env.ADE_E2E_HIDE_WINDOW = '1'
delete process.env.NO_COLOR

export default defineConfig({
  testDir: './e2e/live',
  timeout: 150_000,
  workers: 1,
  reporter: [['list']],
})
