import { spawnSync } from 'node:child_process'
import { backendBuildPrerequisites } from './backend-build.ts'
import { resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { checkPrerequisites } from './prerequisites.ts'

export function deviceRuntimePrerequisites(env: NodeJS.ProcessEnv = process.env) {
  // The scripted device tools invoke Python directly through /bin/sh.
  const python = spawnSync('python3', ['--version'], { env, encoding: 'utf8', timeout: 5000 })
  if (python.status !== 0 || !python.stdout.startsWith('Python 3.'))
    throw new Error('Device acceptance requires a runnable Python 3 on PATH for the scripted device tools.')
}

export default function devicePrerequisites(config: FullConfig) {
  checkPrerequisites(config, () => {
    if (process.platform !== 'darwin') throw new Error('The maintained device fixture suite requires macOS.')
    deviceRuntimePrerequisites()
    backendBuildPrerequisites(resolve(config.rootDir, '../..'))
  })
}
