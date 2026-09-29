import type { FullConfig } from '@playwright/test'
import { checkPrerequisites } from './prerequisites.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error JavaScript executable lookup is covered by installed-provider prerequisite tests.
import { executable } from '../../scripts/test-prerequisites.mjs'
import packagePrerequisites from './package.ts'

export function liveLocalPrerequisites(root: string, env: NodeJS.ProcessEnv = process.env) {
  for (const [label, command] of [
    ['Codex CLI', env.ADE_CODEX_BIN ?? 'codex'],
    ['Claude CLI', env.ADE_CLAUDE_BIN ?? 'claude'],
    ['Node.js', 'node'],
    ['debug daemon', resolve(root, 'target/debug/ade-daemon')],
    ['debug runtime', resolve(root, 'target/debug/ade-runtime')],
  ]) {
    if (!executable(command, env)) throw new Error(`Live acceptance prerequisite missing: ${label}`)
  }
  for (const entry of [
    'apps/desktop/out/main/index.js',
    'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/index.html',
    'providers/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  ]) {
    try {
      accessSync(resolve(root, entry), constants.R_OK)
      if (!statSync(resolve(root, entry)).isFile()) throw new Error('Expected a built file')
    } catch {
      throw new Error(`Live acceptance prerequisite missing: ${entry}. Install dependencies and build the desktop.`)
    }
  }
  // The packaged Claude case already requires this directory before launching.
  if (!env.CLAUDE_CONFIG_DIR || !statSync(env.CLAUDE_CONFIG_DIR, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Live packaged Claude acceptance requires an existing CLAUDE_CONFIG_DIR.')
}

export default function livePrerequisites(config?: FullConfig) {
  return checkPrerequisites(config, () => {
    if (process.env.ADE_RUN_LIVE_PROVIDERS !== '1')
      throw new Error(
        'Live acceptance requires ADE_RUN_LIVE_PROVIDERS=1 and installed, authenticated providers. It can incur provider usage.',
      )
    // This entry point includes built and packaged desktop continuity cases.
    liveLocalPrerequisites(resolve('.'))
    packagePrerequisites()
  })
}
