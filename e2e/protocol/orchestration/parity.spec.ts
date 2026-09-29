// F101, F102 and F103: one versioned command API. Every operation family is
// reachable through both the SDK and the CLI against a real daemon, both apply
// the same rules and errors, the CLI controls work created elsewhere, and a
// headless SDK consumer follows the feed without React or Electron.
import { pathToFileURL } from 'node:url'
import type { Operation } from '../../../packages/client/dist/index.js'
import {
  expect,
  prompts,
  send,
  startConversation,
  test,
  turnReply,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from '../fixtures'
import { binaries } from '../fixtures/environment'
import { subscribeFeed } from '../fixtures/feed'
import { repositoryId } from '../fixtures/worktrees'

type Context = { workspace: string; conversation: string; repository: string }
type Sample = {
  op: Operation
  request: (context: Context) => Record<string, unknown>
  cli: (context: Context) => string[]
}

/** One operation per contract domain, with the named CLI command that reaches it. */
const samples: Record<string, Sample> = {
  workspaces: { op: 'catalog.get', request: () => ({}), cli: () => ['workspace', 'list'] },
  conversations: {
    op: 'conversation.get',
    request: (c) => ({ conversation_id: c.conversation }),
    cli: (c) => ['conversation', 'inspect', c.conversation],
  },
  // No turn is active, so both surfaces must refuse the cancel with the same rule.
  agents: {
    op: 'agent.cancel',
    request: (c) => ({ conversation_id: c.conversation }),
    cli: (c) => ['conversation', 'cancel', c.conversation],
  },
  accounts: { op: 'account.list', request: () => ({}), cli: () => ['account', 'list'] },
  // No window has this ID, so both surfaces refuse it with the same rule.
  layout: {
    op: 'layout.get',
    request: () => ({ window_id: 'e2e-missing' }),
    cli: () => ['layout', 'get', '--window', 'e2e-missing'],
  },
  terminals: {
    op: 'terminal.operation',
    request: (c) => ({ workspace_id: c.workspace, operation_id: 'e2e-missing' }),
    cli: (c) => ['terminal', 'operation', c.workspace, 'e2e-missing'],
  },
  settings: { op: 'settings.get', request: () => ({}), cli: () => ['settings', 'get'] },
  services: {
    op: 'service.list',
    request: (c) => ({ workspace_id: c.workspace }),
    cli: (c) => ['service', 'list', c.workspace],
  },
  review: {
    op: 'review.status',
    request: (c) => ({ workspace_id: c.workspace }),
    cli: (c) => ['git', 'status', c.workspace],
  },
  worktrees: {
    op: 'worktree.get',
    request: (c) => ({ project_id: c.repository }),
    cli: (c) => ['worktree', 'list', c.repository],
  },
  scripts: {
    op: 'script.list',
    request: (c) => ({ workspace_id: c.workspace }),
    cli: (c) => ['script', 'list', c.workspace],
  },
  files: {
    op: 'file.list',
    request: (c) => ({ workspace_id: c.workspace }),
    cli: (c) => ['file', 'list', c.workspace],
  },
  daemon: { op: 'runtime.status', request: () => ({}), cli: () => ['runtime', 'status'] },
  activity: { op: 'activity.list', request: () => ({}), cli: () => ['activity', 'list'] },
  mcp: { op: 'mcp.server.list', request: () => ({}), cli: () => ['mcp', 'list'] },
  skills: { op: 'skill.list', request: () => ({}), cli: () => ['skill', 'list'] },
  plugins: { op: 'plugin.list', request: () => ({}), cli: () => ['plugin', 'list'] },
  orchestration: {
    op: 'orchestration.children',
    request: (c) => ({ parent_conversation_id: c.conversation }),
    cli: (c) => ['child', 'list', c.conversation],
  },
  history: { op: 'history.list', request: () => ({}), cli: () => ['history', 'list'] },
  resources: { op: 'resources.inspect', request: () => ({}), cli: () => ['resources', 'inspect'] },
  checkpoints: {
    op: 'checkpoint.list',
    request: (c) => ({ workspace_id: c.workspace }),
    cli: (c) => ['checkpoint', 'list', c.workspace],
  },
  usage: { op: 'usage.limits', request: () => ({}), cli: () => ['usage', 'limits'] },
  remote: { op: 'remote.host.list', request: () => ({}), cli: () => ['remote', 'list'] },
  retention: { op: 'retention.preview', request: () => ({}), cli: () => ['retention', 'preview'] },
  browser: { op: 'browser.partition.list', request: () => ({}), cli: () => ['browser', 'partition', 'list'] },
  repository: { op: 'repository.coverage', request: () => ({}), cli: () => ['repository', 'coverage'] },
  hooks: { op: 'hook.subscription.list', request: () => ({}), cli: () => ['hook', 'subscriptions'] },
  providers: { op: 'provider.capabilities', request: () => ({}), cli: () => ['provider', 'capabilities'] },
  devices: {
    op: 'device.list',
    request: () => ({ family: 'computer' }),
    cli: () => ['device', 'list', '--family', 'computer'],
  },
  placement: { op: 'placement.hosts', request: () => ({}), cli: () => ['placement', 'hosts'] },
  commands: {
    op: 'command.list',
    request: (c) => ({ conversation_id: c.conversation }),
    cli: (c) => ['command', 'list', c.conversation],
  },
  context: {
    op: 'context.plan',
    request: (c) => ({ conversation_id: c.conversation, text: 'plan' }),
    cli: (c) => ['context', 'plan', c.conversation, '--text', 'plan'],
  },
}

/** The SDK's operation catalog. The SDK is an ES module, so it is loaded dynamically. */
async function sdkOperations(): Promise<Record<string, { domain: string; tier: string }>> {
  const sdk = (await import(
    pathToFileURL(binaries.client).href
  )) as typeof import('../../../packages/client/dist/index.js')
  return sdk.operations
}

type Outcome = { ok: true; type: string } | { ok: false; message: string }

async function viaSdk(profile: ScratchProfile, op: Operation, request: Record<string, unknown>): Promise<Outcome> {
  try {
    const reply = (await profile.call(op, request)) as { type: string }
    return { ok: true, type: reply.type }
  } catch (error) {
    const failure = error as { message: string; delivery?: string }
    // A request the contract refuses never reached the daemon; that is a bug in this sample.
    expect(failure.delivery, `${op}: ${failure.message}`).not.toBe('not_sent')
    return { ok: false, message: failure.message }
  }
}

async function viaCli(profile: ScratchProfile, args: string[]): Promise<Outcome> {
  const result = await profile.cli(...args)
  if (result.code === 0) return { ok: true, type: String(result.json?.type) }
  expect(result.json, `${args.join(' ')}: ${result.stderr}`).toMatchObject({ type: 'error' })
  return { ok: false, message: String(result.json?.message) }
}

test('every operation family is reachable through both the SDK and the CLI, with the same result or refusal', async ({
  profile,
  repo,
}) => {
  const operations = await sdkOperations()
  const discovered = await profile.cli('operations')
  expect(discovered.code).toBe(0)
  const listed = (discovered.json as { operations: Array<{ name: string; domain: string; tier: string }> }).operations
  expect(listed.map((item) => item.name).sort()).toEqual(Object.keys(operations).sort())
  for (const item of listed) expect(['query', 'idempotent_command', 'effect_command']).toContain(item.tier)
  const domains = [...new Set(listed.map((item) => item.domain))].sort()
  expect(Object.keys(samples).sort()).toEqual(domains)

  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  const context = {
    workspace: workspaceId,
    conversation: conversationId,
    repository: await repositoryId(profile, repo.path),
  }
  const mismatches: string[] = []
  for (const [domain, sample] of Object.entries(samples)) {
    expect(operations[sample.op].domain, sample.op).toBe(domain)
    const sdk = await viaSdk(profile, sample.op, sample.request(context))
    const named = await viaCli(profile, sample.cli(context))
    const generic = await viaCli(profile, ['request', sample.op, JSON.stringify(sample.request(context))])
    // `ade request` returns the operation's reply unchanged. A named command may
    // reshape a success for people, but it succeeds or refuses exactly when the SDK does.
    if (JSON.stringify(generic) !== JSON.stringify(sdk)) {
      mismatches.push(`${domain} request ${sample.op}: ${JSON.stringify(generic)} vs SDK ${JSON.stringify(sdk)}`)
    }
    if (named.ok !== sdk.ok || (!named.ok && !sdk.ok && named.message !== sdk.message)) {
      mismatches.push(
        `${domain} ${sample.cli(context).join(' ')}: ${JSON.stringify(named)} vs SDK ${JSON.stringify(sdk)}`,
      )
    }
  }
  expect(mismatches).toEqual([])
})

test('an effect command sent by the CLI and retried by the SDK is admitted once, and a changed retry conflicts (F101)', async ({
  profile,
}) => {
  const { conversationId } = await startConversation(profile, 'codex')
  const requestId = 'e2e-parity-send'
  const first = await profile.cli('conversation', 'send', conversationId, prompts.turn, '--request-id', requestId)
  expect(first.code).toBe(0)
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)

  // The same identity and payload from the other surface is the same operation.
  await profile.call('agent.send', { conversation_id: conversationId, request_id: requestId, text: prompts.turn })
  const turns = (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(turns).toHaveLength(1)
  // A changed payload under the same identity is refused on both surfaces.
  await expect(
    profile.call('agent.send', { conversation_id: conversationId, request_id: requestId, text: 'changed' }),
  ).rejects.toThrow()
  const changed = await profile.cli('conversation', 'send', conversationId, 'changed', '--request-id', requestId)
  expect(changed.code).not.toBe(0)
  expect(changed.json).toMatchObject({ type: 'error' })
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(1)
})

test('the CLI controls work another client created and reports stable exit codes (F102)', async ({ profile }) => {
  // Work created through the SDK, the way the desktop creates it.
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.cli('conversation', 'inspect', conversationId)).json)
    .toMatchObject({ conversation: { status: 'running' } })
  const cancelled = await profile.cli('conversation', 'cancel', conversationId)
  expect(cancelled.code).toBe(0)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('interrupted')

  const unknown = await profile.cli('conversation', 'inspect', 'conversation_missing')
  expect(unknown).toMatchObject({ code: 7, json: { type: 'error', code: 'daemon' } })
  const usage = await profile.cli('conversation', 'send')
  expect(usage).toMatchObject({ code: 2, json: { type: 'error', code: 'usage' } })
  const invalid = await profile.cli('request', 'conversation.get', '{}')
  expect(invalid).toMatchObject({ code: 2, json: { type: 'error', code: 'invalid_request', delivery: 'not_sent' } })
  const unknownOp = await profile.cli('request', 'conversation.explode', '{}')
  expect(unknownOp).toMatchObject({ code: 2, json: { code: 'usage' } })
  const noSocket = await profile.cliWith({ env: {} }, '--socket', `${profile.root}/missing.sock`, 'status')
  expect(noSocket.code).not.toBe(0)
})

test('a headless SDK consumer reads the catalog, follows changes made elsewhere and calls operations (F103)', async ({
  profile,
}) => {
  const feed = await subscribeFeed(profile)
  try {
    await feed.connected()
    const state = feed.client.getState()
    expect(state).toMatchObject({ status: 'connected', bootId: profile.hello.boot_id })
    const decoded: string[] = []
    const unsubscribe = feed.client.subscribeDailyUseFeed((frame) => {
      decoded.push(frame.type)
    })

    // A conversation created by the CLI reaches the consumer's projection.
    const workspace = (await profile.cli('workspace', 'open', profile.defaultWorkspaceRoot)).json as {
      workspace: { id: string }
    }
    const created = await profile.cli('conversation', 'create', workspace.workspace.id, 'codex', 'From the CLI')
    expect(created.code).toBe(0)
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id
    await expect
      .poll(() => feed.client.getState().catalog?.conversations.some((item) => item.id === conversationId))
      .toBe(true)
    expect(decoded.length).toBeGreaterThan(0)

    // The consumer issues typed commands through the same client.
    const reply = await feed.client.call('conversation.get', { conversation_id: conversationId })
    expect(reply.conversation.title).toBe('From the CLI')
    await feed.client.sendPrompt(conversationId, 'e2e-headless-send', prompts.turn)
    await waitForMessage(profile, conversationId, turnReply.codex)
    await expect
      .poll(() => feed.client.getState().catalog?.conversations.find((item) => item.id === conversationId)?.status)
      .toMatch(/^(idle|ready)$/)
    // Revisions arrive in order; a gap would have failed the stream.
    expect(feed.client.getState().status).toBe('connected')
    unsubscribe()
  } finally {
    feed.stop()
  }
})
