import { defineConfig } from '@playwright/test'
import protocol from './playwright.protocol.config'
import { faultSuite } from './e2e/protocol/fault-suite'

// The fault conformance suite (F140): the protocol E2E tests, across every
// area, that inject a fault. See e2e/protocol/fault-suite.ts for how a test
// joins it.
export default defineConfig({
  ...protocol,
  grep: faultSuite,
  outputDir: './test-results/protocol-faults',
})
