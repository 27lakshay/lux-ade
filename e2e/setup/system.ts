import type { FullConfig } from '@playwright/test'
import { checkPrerequisites } from './prerequisites.ts'
import { resolve } from 'node:path'
import { backendBuildPrerequisites } from './backend-build.ts'
import { accessSync, constants } from 'node:fs'

export default function systemPrerequisites(config?: FullConfig) {
  return checkPrerequisites(config, () => {
    if (process.env.ADE_E2E_SYSTEM !== '1')
      throw new Error(
        'System acceptance requires explicit ADE_E2E_SYSTEM=1; it mounts a disposable disk image. Run this suite alone.',
      )
    if (process.platform !== 'darwin') throw new Error('The system volume suite requires macOS disk services.')
    accessSync('/usr/bin/hdiutil', constants.X_OK)
    backendBuildPrerequisites(config ? resolve(config.rootDir, '../..') : resolve('.'))
  })
}
