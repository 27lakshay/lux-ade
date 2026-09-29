// The workspace navigator's backend: projects in the catalog, `workspace.rename`
// and `workspace.remove` ("Remove from ADE"), through the SDK, the CLI and the
// catalog feed. Removal hides a workspace without touching its files, stops
// its terminals and Agents, and reopening its folder restores the same
// identity with its Conversations (F061).
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  expect,
  isRunning,
  primaryShell,
  prompts,
  type ScratchProfile,
  send,
  startConversation,
  test,
  waitForIdle,
} from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'
import { createReady, operationId, register, settled } from '../worktrees/lifecycle'

/** A new plain folder under the test's temp root, by its canonical path. */
async function folder(profile: ScratchProfile, name: string): Promise<string> {
  const path = join(profile.root, 'folders', name)
  await mkdir(path, { recursive: true })
  return realpath(path)
}

/** The error a rejected SDK call raised, with its daemon code and frame details. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; details: Record<string, unknown> },
  )
}

async function catalog(profile: ScratchProfile) {
  return (await profile.call('catalog.get', {})).catalog
}

/** Running shells of `workspaceId` in the runtime. */
async function runningShells(profile: ScratchProfile, workspaceId: string): Promise<string[]> {
  const status = (await profile.call('runtime.status', {})) as unknown as {
    terminals: Array<{ workspace: { id: string; terminal_id: string }; metrics: { shell_running?: boolean } }>
  }
  return status.terminals
    .filter((terminal) => terminal.workspace.id === workspaceId && terminal.metrics.shell_running === true)
    .map((terminal) => terminal.workspace.terminal_id)
}

test('a renamed workspace shows its new name in the catalog feed and keeps it across a daemon restart', async ({
  profile,
}) => {
  const path = await folder(profile, 'rename-me')
  const { workspace } = await profile.call('workspace.open', { path })
  expect(workspace.name).toBe('rename-me')
  const feed = await subscribeFeed(profile)
  await feed.connected()

  const renamed = await profile.call('workspace.rename', { workspace_id: workspace.id, name: '  Payments API  ' })
  expect(renamed.workspace).toMatchObject({ id: workspace.id, name: 'Payments API', root: path })
  await feed.waitFor(
    (frame) =>
      frame.type === 'catalog' &&
      frame.catalog.workspaces.some((item) => item.id === workspace.id && item.name === 'Payments API'),
  )
  feed.stop()
  // Only the name changed: the folder is where it was.
  expect(existsSync(path)).toBe(true)

  // The same rename again converges on the same state.
  const again = await profile.cli('workspace', 'rename', workspace.id, 'Payments API')
  expect(again.code, again.stderr).toBe(0)
  expect(again.json).toMatchObject({ type: 'ack', workspace: { name: 'Payments API' } })

  await profile.restartDaemon('kill')
  const listed = (await catalog(profile)).workspaces.find((item) => item.id === workspace.id)
  expect(listed?.name).toBe('Payments API')
  // Reopening the folder returns the stored name, not the folder's.
  expect((await profile.call('workspace.open', { path })).workspace.name).toBe('Payments API')
})

test('rename refuses an empty, overlong or multi-line name and an unknown workspace', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: await folder(profile, 'named') })
  for (const name of ['', '   ', 'x'.repeat(101), 'two\nlines']) {
    const refused = await refusal(profile.call('workspace.rename', { workspace_id: workspace.id, name }))
    expect(refused.code, JSON.stringify(name)).toBe('invalid_workspace_name')
  }
  // Exactly 100 characters, counted as characters, is accepted.
  const limit = 'é'.repeat(100)
  expect((await profile.call('workspace.rename', { workspace_id: workspace.id, name: limit })).workspace.name).toBe(
    limit,
  )
  const missing = await refusal(profile.call('workspace.rename', { workspace_id: 'workspace_missing', name: 'x' }))
  expect(missing.code).toBe('workspace_not_found')
  const cli = await profile.cli('workspace', 'rename', workspace.id, ' ')
  expect(cli.code).toBe(20)
  expect(cli.json).toMatchObject({ code: 'invalid_workspace_name' })
  expect((await catalog(profile)).workspaces.find((item) => item.id === workspace.id)?.name).toBe(limit)
})

test('remove hides the workspace, stops its terminals and Agent, keeps its files, and reopening restores it', async ({
  profile,
}) => {
  const path = await folder(profile, 'project')
  await writeFile(join(path, 'notes.md'), 'kept\n')
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', path)
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  const { workspace } = await profile.call('workspace.open', { path })
  const shellId = await primaryShell(profile, workspace.id)
  const { terminal_id: extraId } = await profile.call('terminal.create', {
    workspace_id: workspaceId,
    operation_id: operationId('extra'),
  })
  const primary = TerminalStream.open(profile, workspaceId, shellId)
  const extra = TerminalStream.open(profile, workspaceId, extraId)
  await primary.snapshot()
  await extra.snapshot()
  const shells = await Promise.all(
    [shellId, extraId].map(async (id) => (await terminalMetrics(profile, workspaceId, id))!.shell_pid),
  )
  expect((await runningShells(profile, workspaceId)).sort()).toEqual([shellId, extraId].sort())

  const id = operationId('remove')
  const removed = await profile.cli('--operation-id', id, 'workspace', 'remove', workspaceId)
  expect(removed.code, removed.stderr).toBe(0)
  expect(removed.json).toEqual({ type: 'workspace_removed', workspace_id: workspaceId })

  // Gone from the catalog with its Conversation; its files are untouched.
  const after = await catalog(profile)
  expect(after.workspaces.map((item) => item.id)).not.toContain(workspaceId)
  expect(after.conversations.map((item) => item.id)).not.toContain(conversationId)
  expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('kept\n')
  // No shell and no provider process keeps running for it.
  expect(await runningShells(profile, workspaceId)).toEqual([])
  for (const pid of shells) expect(await isRunning(pid as number), `shell ${pid}`).toBe(false)
  const status = await profile.call('runtime.status', {})
  expect(JSON.stringify(status.agents)).not.toContain(conversationId)
  // It refuses new work until it is reopened.
  const refused = await refusal(
    profile.call('terminal.create', { workspace_id: workspaceId, operation_id: operationId('late') }),
  )
  expect(refused.code).toBe('workspace_removed')

  // A retry under the same ID replays; a new removal succeeds with no effect.
  const replay = await profile.cli('--operation-id', id, 'workspace', 'remove', workspaceId)
  expect(replay.json).toEqual(removed.json)
  const twice = await profile.call('workspace.remove', { workspace_id: workspaceId })
  expect(twice).toEqual({ type: 'workspace_removed', workspace_id: workspaceId })
  const missing = await refusal(profile.call('workspace.remove', { workspace_id: 'workspace_missing' }))
  expect(missing.code).toBe('workspace_not_found')

  // The removal survives a restart, and opening the folder restores the same
  // identity with its Conversation and a fresh primary terminal.
  await profile.restartDaemon('graceful')
  expect((await catalog(profile)).workspaces.map((item) => item.id)).not.toContain(workspaceId)
  const reopened = await profile.call('workspace.open', { path })
  expect(reopened.workspace.id).toBe(workspaceId)
  const restored = await catalog(profile)
  const reopenedShells = restored.terminals.filter((terminal) => terminal.workspace_id === workspaceId)
  expect(reopenedShells).toHaveLength(1)
  expect(reopenedShells[0]).toMatchObject({ primary: true })
  expect(reopenedShells[0]!.id).not.toBe(shellId)
  expect(restored.workspaces.map((item) => item.id)).toContain(workspaceId)
  expect(restored.conversations.find((item) => item.id === conversationId)).toMatchObject({
    workspace_id: workspaceId,
  })
  const history = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(history.messages.length).toBeGreaterThan(0)
  primary.close()
  extra.close()
})

test('remove is refused while a conversation turn runs and lists what blocks it', async ({ profile }) => {
  const path = await folder(profile, 'busy')
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', path)
  await send(profile, conversationId, prompts.hold)
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .toBe('running')

  const refused = await refusal(profile.call('workspace.remove', { workspace_id: workspaceId }))
  expect(refused.code).toBe('workspace_remove_blocked')
  expect(refused.details.blockers).toEqual([
    { kind: 'conversation_running', id: conversationId, label: expect.stringContaining('Conversation') },
  ])
  const cli = await profile.cli('workspace', 'remove', workspaceId)
  expect(cli.code).toBe(21)
  expect(cli.json).toMatchObject({
    code: 'workspace_remove_blocked',
    blockers: [{ kind: 'conversation_running', id: conversationId }],
  })
  expect((await catalog(profile)).workspaces.map((item) => item.id)).toContain(workspaceId)

  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status)
    .not.toMatch(/^(starting|running|waiting|cancelling)$/)
  await profile.call('workspace.remove', { workspace_id: workspaceId })
  expect((await catalog(profile)).workspaces.map((item) => item.id)).not.toContain(workspaceId)
})

test("the daemon's default workspace cannot be removed", async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const refused = await refusal(profile.call('workspace.remove', { workspace_id: workspace.id }))
  expect(refused.code).toBe('workspace_remove_blocked')
  expect(refused.details.blockers).toEqual([expect.objectContaining({ kind: 'default_workspace', id: workspace.id })])
})

test('a removed ADE-made worktree can then be removed by worktree.remove without an active_work blocker', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const tree = await createReady(profile, repositoryId, { name: 'navigator' })
  const { workspace } = await profile.call('workspace.open', { path: tree })
  await profile.call('terminal.restart', { workspace_id: workspace.id })
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers).toContain('active_work')

  await profile.call('workspace.remove', { workspace_id: workspace.id })
  const cleared = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(cleared.trees.find((candidate) => candidate.path === tree)?.blockers).toEqual([])

  const id = operationId('remove-tree')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: id, path: tree })
  const row = await settled(profile, repositoryId, id)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(tree)).toBe(false)
  // The removed workspace's missing folder does not fence the profile.
  const other = await profile.call('workspace.open', { path: await folder(profile, 'after') })
  expect(other.workspace.needs_rebind).toBe(false)
  expect((await profile.call('workspace.rebind.list', {})).workspaces).not.toContainEqual(
    expect.objectContaining({ id: workspace.id }),
  )
})

test('the catalog lists each repository project once, named after its checkout folder, for a main checkout and a linked worktree', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const linked = join(dirname(repo.path), 'shop-feature')
  await repo.git('worktree', 'add', '--quiet', '-b', 'feature', linked)
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const tree = (await profile.call('workspace.open', { path: linked })).workspace
  const plain = (await profile.call('workspace.open', { path: await folder(profile, 'notes') })).workspace

  const repositories = async () => (await catalog(profile)).projects.filter((project) => project.kind === 'repository')
  expect(tree.project_id).toBe(main.project_id)
  expect(plain.project_id).not.toBe(main.project_id)
  expect(await repositories()).toEqual([
    { id: main.project_id, kind: 'repository', root: join(repo.path, '.git'), name: basename(repo.path) },
  ])
  expect(basename(repo.path)).toBe('shop')

  // The SDK's catalog parser keeps the projects.
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const state = feed.client.getState().catalog!
  expect(state.projects).toEqual((await catalog(profile)).projects)
  feed.stop()

  // A repository project leaves the catalog with the last of its workspaces.
  await profile.call('workspace.remove', { workspace_id: main.id })
  expect(await repositories()).toHaveLength(1)
  await profile.call('workspace.remove', { workspace_id: tree.id })
  expect(await repositories()).toEqual([])
})
