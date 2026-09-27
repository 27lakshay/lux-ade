// Conversation fault fixtures: a Codex mock behind a proxy (codex_faults.py)
// that can stream one message past the daemon's 1 MiB message limit and hold
// a native compaction call until a release file exists. Start a profile with
// `ade.profile({ env: conversationFaults.env })`.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { mockDirectory } from './providers'
import type { ScratchProfile } from './profile'

export const conversationFaults = {
  /** Daemon environment that routes Codex through the fault proxy. */
  env: { ADE_CODEX_BIN: join(__dirname, 'codex_faults.py') },
  /** The prompt whose turn streams one agent message and one command output of `largeBytes` each. */
  largePrompt: 'large-message',
  largeBytes: 24 * 65536,
  /** While this release file exists, `thread/compact/start` waits for `releaseCompact`. */
  holdCompact: 'hold-compact',
  releaseCompact: 'release-compact',
}

/** Wait until the proxy is holding a compaction call it has not forwarded. */
export async function waitForHeldCompaction(profile: ScratchProfile, timeout = 15_000): Promise<void> {
  const held = join(mockDirectory(profile.root, 'codex'), 'compact-held')
  await expect
    .poll(
      () =>
        access(held).then(
          () => true,
          () => false,
        ),
      { timeout, message: 'a held compaction' },
    )
    .toBe(true)
}
