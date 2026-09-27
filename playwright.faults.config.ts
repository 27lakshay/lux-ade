import { defineConfig } from '@playwright/test'
import protocol from './playwright.protocol.config'
import { faultSuite, loadRun } from './e2e/protocol/fault-suite'

// The fault conformance suite (F140): the protocol E2E tests, across every
// area, that inject a fault. See e2e/protocol/fault-suite.ts for how a test
// joins it. The load run (`@load`) crashes a daemon too, but it measures
// latency and runs alone, so it is left out.
export default defineConfig({
  ...protocol,
  grep: faultSuite,
  grepInvert: loadRun,
  outputDir: './test-results/protocol-faults',
})
