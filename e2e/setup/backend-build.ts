import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'

export function backendBuildPrerequisites(root: string) {
  for (const [entry, mode] of [
    ['target/debug/ade-daemon', constants.X_OK],
    ['target/debug/ade-runtime', constants.X_OK],
    ['apps/cli/dist/index.js', constants.R_OK],
    ['packages/client/dist/index.js', constants.R_OK],
  ] as const) {
    try {
      accessSync(resolve(root, entry), mode)
      if (!statSync(resolve(root, entry)).isFile()) throw new Error('Expected a built file')
    } catch {
      throw new Error(
        `Backend acceptance prerequisite missing: ${entry}. Build the backend, SDK and CLI before running this suite.`,
      )
    }
  }
}
