import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error JavaScript discovery helper is verified by native runner tests.
import { discoverPrerequisiteInventory } from '../../scripts/prerequisite-discovery.mjs'
import type { FullConfig } from '@playwright/test'

// Only prerequisite checks belong here. Test execution errors must retain their native category.
export function checkPrerequisites(config: FullConfig | undefined, check: () => void) {
  const reporting = config?.metadata.testReporting
  const write = (status: string, inventoryError?: string) => {
    if (!reporting) return
    mkdirSync(reporting.directory, { recursive: true })
    writeFileSync(
      resolve(reporting.directory, 'prerequisites.json'),
      JSON.stringify({ ...reporting, status, inventoryError }, null, 2) + '\n',
    )
  }
  write('checking')
  try {
    check()
  } catch (error) {
    // Keep credentials and environment values out of the structured report.
    let inventoryError: string | undefined
    if (reporting) {
      try {
        const inventory = discoverPrerequisiteInventory(process.argv)
        writeFileSync(
          resolve(reporting.directory, 'prerequisite-inventory.json'),
          JSON.stringify({ invocationId: reporting.invocationId, native: inventory }, null, 2) + '\n',
        )
      } catch {
        inventoryError = 'Native selected-case inventory could not be reconstructed; requirement coverage is unknown'
      }
    }
    write('unavailable', inventoryError)
    throw error
  }
  write('ready')
}
