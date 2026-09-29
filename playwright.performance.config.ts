import { reporting } from './e2e/reporting'
import { defineConfig } from '@playwright/test'
import protocol from './playwright.protocol.config'
import { suites } from './e2e/suites'

export default defineConfig({
  ...protocol,
  ...suites.performance,
  globalSetup: './e2e/setup/performance.ts',
  fullyParallel: false,
  workers: 1,
  outputDir: './test-results/performance',
  ...reporting('performance'),
})
