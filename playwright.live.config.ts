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

const evidence = reporting('live')
export default defineConfig({
  ...suites.live,
  globalSetup: './e2e/setup/live.ts',
  retries: 0,
  forbidOnly: true,
  outputDir: './test-results/live',
  timeout: 150_000,
  workers: 1,
  reporter: [['list']],
  ...evidence,
  metadata: {
    ...evidence.metadata,
    acceptanceScope: {
      requirementIds: ['F010'],
      authenticationPreflight: 'unverified',
      knownGaps: [
        'The live desktop specs require a composer and transcript; conversation tab content is currently unbuilt.',
      ],
    },
  },
})
