import { defineConfig } from '@playwright/test'
import protocol from './playwright.protocol.config'
import { reporting } from './e2e/reporting'
import { suites } from './e2e/suites'

const evidence = reporting('devices')
export default defineConfig({
  ...protocol,
  ...suites.devices,
  globalSetup: './e2e/setup/devices.ts',
  ...evidence,
  metadata: {
    ...evidence.metadata,
    acceptanceScope: {
      requirementIds: ['F098', 'F099', 'F100'],
      environment: 'real daemon with scripted device tools',
      physicalDeviceAcceptance: 'unexecuted',
      displayApplicationInput: 'known-gap',
    },
  },
})
