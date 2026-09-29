import { reporting } from './e2e/reporting'
import { defineConfig } from '@playwright/test'
import protocol from './playwright.protocol.config'
import { suites } from './e2e/suites'

export default defineConfig({
  ...protocol,
  ...suites.system,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/setup/system.ts',
  outputDir: './test-results/system',
  ...reporting('system'),
})
