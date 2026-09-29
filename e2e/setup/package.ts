import type { FullConfig } from '@playwright/test'
import { checkPrerequisites } from './prerequisites.ts'
import { resolve } from 'node:path'
// @ts-expect-error JavaScript candidate validation is covered by native runner tests.
import { verifyCandidate } from '../../scripts/package-candidate.mjs'
// @ts-expect-error JavaScript report writer is shared with the aggregate command.
import { writeJson } from '../../scripts/run-stages.mjs'

export default function packagePrerequisites(config?: FullConfig) {
  return checkPrerequisites(config, () => {
    if (process.platform !== 'darwin')
      throw new Error('Package acceptance requires macOS and a compatible macOS candidate.')
    const app = resolve(process.env.ADE_E2E_PACKAGE_APP ?? 'dist/electron/mac-arm64/Lux ADE.app')
    const candidate = verifyCandidate(app)
    const directory = config?.metadata.testReporting?.directory
    if (directory) writeJson(resolve(directory, 'candidate.json'), candidate)
  })
}
