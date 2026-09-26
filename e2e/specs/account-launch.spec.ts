import { expect, test } from '@playwright/test'
import { access, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

test('an unverified managed account cannot fall back to ambient Claude credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-account-launch-'))
  const launcher = join(directory, 'claude-bridge')
  const launched = join(directory, 'launched')
  await writeFile(launcher, `#!/bin/sh\ntouch ${JSON.stringify(launched)}\nexit 1\n`)
  await chmod(launcher, 0o700)
  const daemon = await startDaemon({ ADE_CLAUDE_BRIDGE_BIN: launcher, ANTHROPIC_API_KEY: 'ambient-token' })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const account = (await rpc(daemon.socket, { op: 'account.create', provider: 'claude', name: 'Other account' })).account as { id: string; state: string }
    expect(account.state).toBe('unverified')
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: account.id })).conversation as { id: string }
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'managed-attempt', text: 'Use the selected account' })).rejects.toThrow(/account is not verified/)
    await expect(access(launched)).rejects.toThrow()
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect(snapshot.conversation).toMatchObject({ account_id: account.id })
    expect(snapshot.messages).toEqual([])
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
