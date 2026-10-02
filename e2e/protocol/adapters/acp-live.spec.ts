// Installed evidence for ticket 20: a real ACP executable as a generic adapter through the real
// daemon, runtime and ACP worker. Opt-in, because it sends one real prompt with the agent's own
// sign-in:
//
//   ADE_ACP_LIVE_BIN=$HOME/.opencode/bin/opencode ADE_ACP_LIVE_ARGS=acp \
//     ADE_ACP_LIVE_WORKSPACE=/tmp/acp-live-workspace pnpm test:e2e:protocol:only e2e/protocol/adapters/acp-live.spec.ts
//
// The scratch profile's HOME hides the agent's login, so the definition passes the caller's own
// HOME and XDG directories, as a user's daemon environment would. The workspace is a fresh scratch
// directory; no agent configuration changes. This proves this executable only.
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, waitForMessage } from '../fixtures'

const bin = process.env.ADE_ACP_LIVE_BIN
const args = (process.env.ADE_ACP_LIVE_ARGS ?? 'acp').split(' ').filter(Boolean)

test('installed ACP agent: negotiated scope and one real turn through the daemon', async ({ profile }, testInfo) => {
  test.skip(!bin, 'Set ADE_ACP_LIVE_BIN to an installed ACP executable to run')
  test.setTimeout(240_000)
  const home = homedir()
  await profile.call('adapter.put', {
    definition: {
      id: 'live-acp',
      name: 'Live ACP',
      kind: 'acp',
      command: bin!,
      args,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_STATE_HOME: join(home, '.local/state'),
      },
    },
  })
  const probed = await profile.call('adapter.probe', { id: 'live-acp' })
  const report: Record<string, unknown> = { executable: bin, args, probe: probed.adapter.probe }
  try {
    expect(probed.adapter.readiness).toBe('ready')
    const workspacePath = process.env.ADE_ACP_LIVE_WORKSPACE ?? join(profile.root, 'acp-live-workspace')
    await mkdir(workspacePath, { recursive: true })
    const { workspace } = await profile.call('workspace.open', { path: workspacePath })
    const { conversation } = await profile.call('conversation.create', {
      workspace_id: workspace.id,
      provider: probed.adapter.provider_id,
      title: 'Live ACP',
    })
    report.catalog = (await profile.call('catalog.get', {})).providers.find(
      (descriptor) => descriptor.id === probed.adapter.provider_id,
    )
    await send(profile, conversation.id, 'Reply with the single word ok')
    await waitForMessage(profile, conversation.id, 'ok', 180_000)
    await waitForIdle(profile, conversation.id, 180_000)
    const after = await profile.call('conversation.get', { conversation_id: conversation.id })
    report.messages = after.messages.map((message) => ({
      role: message.role,
      kind: message.kind,
      status: message.status,
      text: message.text.slice(0, 200),
      provider_item_id: message.provider_item_id,
      delivery: message.delivery,
    }))
    const user = after.messages.find((message) => message.role === 'user')
    expect(user?.delivery).toMatchObject({
      native_outcome: 'accepted',
      terminal: { status: 'completed', correlated: true, native_terminal: { stop_reason: 'end_turn' } },
    })
    expect(after.messages.some((message) => message.role === 'assistant' && /\bok\b/i.test(message.text))).toBe(true)
  } finally {
    const body = JSON.stringify(report, null, 2)
    await testInfo.attach('acp-live-report.json', { body, contentType: 'application/json' })
    if (process.env.ADE_ACP_LIVE_REPORT) await writeFile(process.env.ADE_ACP_LIVE_REPORT, body)
  }
})
