import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
})
