// R020, headless part: the installed CLI drives daily-use turns on a profile
// it cold-starts, with PATH=/usr/bin:/bin and a scratch HOME. The provider
// fixtures stand in for the user's Codex CLI and the Claude SDK only; the
// workers and relay code, and the Node and Bun that run them, are the bundle's.
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { prompts, send, startConversation, turnReply, waitForMessage, type MockProvider } from '../fixtures'
import { mockDirectory } from '../fixtures/providers'
import { ProfileHost, type ManagedProfile } from '../fixtures/managed-profiles'
import { bundle, bundleMissing, expect, packagedLauncher, relocateBundle, test } from '../fixtures/packaged'
import { processTable } from '../fixtures/processes'

test.beforeAll(() => {
  if (bundleMissing) throw new Error(bundleMissing)
})

function field(result: { stdout: string }, pattern: RegExp): string {
  const match = pattern.exec(result.stdout)
  if (!match) throw new Error(`No match for ${pattern} in ${result.stdout.slice(0, 400)}`)
  return match[1]
}

async function launches(profile: ManagedProfile, provider: MockProvider): Promise<Array<Record<string, unknown>>> {
  const log = await readFile(join(mockDirectory(profile.root, provider), 'launch.jsonl'), 'utf8').catch(() => '')
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function turn(profile: ManagedProfile, workspaceId: string, provider: MockProvider): Promise<void> {
  const created = await profile.cli('conversation', 'create', workspaceId, provider)
  expect(created.code, created.stderr).toBe(0)
  const conversationId = field(created, /"id":"(conversation[^"]*)"/)
  const sent = await profile.cli(
    'conversation',
    'send',
    conversationId,
    prompts.turn,
    '--request-id',
    `packaged-${provider}`,
  )
  expect(sent.code, sent.stderr).toBe(0)
  await expect
    .poll(async () => (await profile.cli('conversation', 'inspect', conversationId)).stdout, { timeout: 20_000 })
    .toContain(turnReply[provider])
}

test('the installed CLI cold-starts a profile and runs Codex and Claude turns through bundled Bun and Node', async ({
  host,
  ade,
}) => {
  const work = await host.create('Daily')
  const project = join(ade.root, 'project')
  await mkdir(project)

  const status = await work.cli('status')
  expect(status.code, status.stderr).toBe(0)
  expect(status.json).toMatchObject({ type: 'hello' })

  const opened = await work.cli('workspace', 'open', project)
  expect(opened.code, opened.stderr).toBe(0)
  const workspaceId = field(opened, /"id":"(workspace[^"]*)"/)
  const listed = await work.cli('workspace', 'list')
  expect(listed.stdout).toContain(JSON.stringify(await realpath(project)).slice(1, -1))

  await turn(work, workspaceId, 'codex')
  await turn(work, workspaceId, 'claude')
  expect((await work.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect((await work.mockCalls('claude')).filter((call) => call.method === 'send')).toHaveLength(1)

  // Codex ran behind the bundle's shared-server relay, under the bundle's Bun.
  const codex = await launches(work, 'codex')
  expect(codex).toHaveLength(1)
  expect(String(codex[0].parent)).toBe(`${bundle.bun} ${join(bundle.resources, 'providers/codex/shared-server.mjs')}`)
  // Claude's worker ran under the bundle's Electron as Node.
  const claude = await launches(work, 'claude')
  expect(claude).toHaveLength(1)
  expect(claude[0]).toMatchObject({ execPath: bundle.electron, electronRunAsNode: '1' })
})

test("a daemon cold-started by bundled ade-control alone runs Claude and Codex turns under the bundle's Node and Bun", async ({
  host,
  ade,
}) => {
  const work = await host.create('Direct')
  const project = join(ade.root, 'project')
  await mkdir(project)
  // No CLI: ade-control is the only launcher, as for a remote bootstrap or a login item.
  const started = await host.control(['profiles', 'start', work.id], work.env)
  expect(started.code, started.stderr).toBe(0)
  await host.track()

  const { conversationId } = await startConversation(work.asScratch(), 'claude', project)
  await send(work.asScratch(), conversationId, prompts.turn)
  await waitForMessage(work.asScratch(), conversationId, turnReply.claude)
  const claude = await launches(work, 'claude')
  expect(claude).toHaveLength(1)
  expect(claude[0]).toMatchObject({ execPath: bundle.electron, electronRunAsNode: '1' })

  const codex = await startConversation(work.asScratch(), 'codex', project)
  await send(work.asScratch(), codex.conversationId, prompts.turn)
  await waitForMessage(work.asScratch(), codex.conversationId, turnReply.codex)
  expect(String((await launches(work, 'codex'))[0]?.parent)).toBe(
    `${bundle.bun} ${join(bundle.resources, 'providers/codex/shared-server.mjs')}`,
  )
})

test("a terminal on the installed profile runs a login shell without the bundle's Node switch", async ({
  host,
  ade,
}) => {
  const work = await host.create('Shell')
  const project = join(ade.root, 'project')
  await mkdir(project)
  const opened = await work.cli('workspace', 'open', project)
  expect(opened.code, opened.stderr).toBe(0)
  const workspaceId = field(opened, /"id":"(workspace[^"]*)"/)
  const created = await work.cli('terminal', 'create', workspaceId, '--operation-id', 'packaged-shell')
  expect(created.code, created.stderr).toBe(0)
  const terminalId = field(created, /"terminal_id":"([^"]+)"/)
  const output = join(ade.root, 'terminal-env.txt')
  const sent = await work.cli(
    'terminal',
    'send',
    workspaceId,
    terminalId,
    `env > '${output}.partial' && mv '${output}.partial' '${output}'`,
  )
  expect(sent.code, sent.stderr).toBe(0)
  await expect.poll(() => readFile(output, 'utf8').catch(() => ''), { timeout: 20_000 }).toContain('PATH=')
  const env = Object.fromEntries(
    (await readFile(output, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  expect(env.HOME).toBe(host.userHome)
  // ELECTRON_RUN_AS_NODE turns every Electron app the user starts from this shell into Node.
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})

test('a bundle moved to a folder with spaces runs its own executables and resources', async ({ ade }, testInfo) => {
  const moved = await relocateBundle(join(ade.root, 'Moved Apps', 'Lux ADE.app'))
  const movedHost = await ProfileHost.create(ade, await packagedLauncher(join(ade.root, 'moved-fixtures'), moved))
  try {
    const work = await movedHost.create('Moved')
    const project = join(ade.root, 'project')
    await mkdir(project)
    const status = await work.cli('status')
    expect(status.code, status.stderr).toBe(0)
    const hello = status.json as { pid: number; runtime_pid: number }
    const table = new Map((await processTable()).map((row) => [row.pid, row]))
    expect(table.get(hello.pid)!.command.startsWith(moved.daemon)).toBe(true)
    expect(table.get(hello.runtime_pid)!.command.startsWith(moved.runtime)).toBe(true)

    const opened = await work.cli('workspace', 'open', project)
    expect(opened.code, opened.stderr).toBe(0)
    const workspaceId = field(opened, /"id":"(workspace[^"]*)"/)
    await turn(work, workspaceId, 'codex')
    await turn(work, workspaceId, 'claude')
    expect(String((await launches(work, 'codex'))[0]?.parent)).toBe(
      `${moved.bun} ${join(moved.resources, 'providers/codex/shared-server.mjs')}`,
    )
    expect((await launches(work, 'claude'))[0]).toMatchObject({
      execPath: await realpath(moved.electron),
      electronRunAsNode: '1',
    })
  } finally {
    await movedHost.teardown(testInfo)
  }
})
