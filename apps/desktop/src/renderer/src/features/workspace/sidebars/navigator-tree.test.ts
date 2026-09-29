import type { CatalogProject, Conversation, Workspace } from '@ade/client'
import { expect, test } from 'vitest'
import { conversationState, navigatorTree } from './navigator-tree'

const workspace = (id: string, name: string, project_id: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  project_id,
  repository_id: null,
  root: `/code/${name}`,
  terminal_id: `t-${id}`,
  needs_rebind: false,
  worktree_lifecycle_needs_rebind: false,
  kind: 'folder',
  branch: null,
  default: false,
  ade_owned: false,
  ...extra,
})
const conversation = (
  id: string,
  workspace_id: string,
  attention: Conversation['attention'] = 'idle',
): Conversation => ({
  id,
  workspace_id,
  title: id,
  provider: 'codex',
  status: 'idle',
  attention,
})
const project = (id: string, name: string, kind: CatalogProject['kind']): CatalogProject => ({
  id,
  name,
  kind,
  root: `/code/${name}`,
})

test('workspaces group into their projects, named and typed by the catalog', () => {
  const tree = navigatorTree(
    [
      workspace('w1', 'main', 'r1', { kind: 'primary_checkout' }),
      workspace('w2', 'wt-2', 'r1', { kind: 'linked_worktree', ade_owned: true, branch: 'ade/wt-2' }),
      workspace('w3', 'notes', 'f1'),
      workspace('w4', 'app', 'r2', { kind: 'primary_checkout' }),
    ],
    [conversation('c1', 'w2'), conversation('c2', 'w2'), conversation('c3', 'w3')],
    {
      r1: project('r1', 'lux-ade', 'repository'),
      r2: project('r2', 'app', 'repository'),
      f1: project('f1', 'notes', 'folder'),
    },
  )
  expect(tree.map((p) => [p.name, p.repository, p.workspaces.map((w) => w.name)])).toEqual([
    ['app', true, ['app']],
    ['lux-ade', true, ['main', 'wt-2']],
    ['notes', false, ['notes']],
  ])
  const worktree = tree[1]!.workspaces[1]!
  expect(worktree.conversations.map((c) => c.id)).toEqual(['c1', 'c2'])
  expect(worktree).toMatchObject({ branch: 'ade/wt-2', deletableWorktree: true })
  expect(tree[1]!.workspaces[0]!.deletableWorktree).toBe(false)
})

test('a worktree ADE did not make cannot be deleted from the navigator', () => {
  const [project1] = navigatorTree(
    [workspace('w1', 'feature', 'r1', { kind: 'linked_worktree', ade_owned: false })],
    [],
    { r1: project('r1', 'shop', 'repository') },
  )
  expect(project1!.workspaces[0]!.deletableWorktree).toBe(false)
})

test('a conversation’s mark follows the attention the daemon reports', () => {
  expect(
    (['idle', 'running', 'needs_you', 'error'] as const).map((attention) =>
      conversationState(conversation('c', 'w', attention)),
    ),
  ).toEqual(['idle', 'running', 'needsYou', 'error'])
})
