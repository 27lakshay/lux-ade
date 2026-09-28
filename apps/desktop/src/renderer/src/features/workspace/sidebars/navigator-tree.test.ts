import type { Conversation, Workspace } from '@ade/client'
import { expect, test } from 'vitest'
import { conversationState, navigatorTree } from './navigator-tree'

const workspace = (id: string, name: string, repository_id: string | null): Workspace => ({
  id,
  name,
  repository_id,
  root: `/code/${name}`,
  terminal_id: `t-${id}`,
  needs_rebind: false,
  worktree_lifecycle_needs_rebind: false,
})
const conversation = (id: string, workspace_id: string, status = 'idle'): Conversation => ({
  id,
  workspace_id,
  title: id,
  provider: 'codex',
  status,
})

test('workspaces group into projects by repository; plain folders are projects of their own', () => {
  const tree = navigatorTree(
    [
      workspace('w1', 'main', 'r1'),
      workspace('w2', 'wt-2', 'r1'),
      workspace('w3', 'notes', null),
      workspace('w4', 'app', 'r2'),
    ],
    [conversation('c1', 'w2'), conversation('c2', 'w2'), conversation('c3', 'w3')],
    { r1: 'lux-ade' },
  )
  expect(tree.map((project) => [project.name, project.workspaces.map((w) => w.name)])).toEqual([
    ['app', ['app']],
    ['lux-ade', ['main', 'wt-2']],
    ['notes', ['notes']],
  ])
  expect(tree[1]!.workspaces[1]!.conversations.map((c) => c.id)).toEqual(['c1', 'c2'])
  expect(tree[2]!.id).toBe('w3')
  expect(tree.map((project) => project.repository)).toEqual([true, true, false])
})

test('names sort naturally and without regard to case', () => {
  const tree = navigatorTree(
    [workspace('a', 'wt-10', 'r'), workspace('b', 'wt-2', 'r'), workspace('c', 'Main', 'r')],
    [],
  )
  expect(tree[0]!.workspaces.map((w) => w.name)).toEqual(['Main', 'wt-2', 'wt-10'])
})

test('conversation statuses map to the one status mark', () => {
  expect(['running', 'responding', 'waiting', 'error', 'ready', 'interrupted'].map(conversationState)).toEqual([
    'running',
    'running',
    'needsYou',
    'error',
    'idle',
    'idle',
  ])
})
