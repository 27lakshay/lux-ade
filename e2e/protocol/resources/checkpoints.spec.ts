// File checkpoints (F070; workspaces spec rule 7): create, list, preview and
// restore through the SDK, the CLI and the raw protocol against a real daemon,
// including refusal to overwrite unsaved changes, a stale preview, an ignored
// file in the way, duplicate requests and a daemon crash.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

const binary = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f, 0x80, 0x0a, 0x00])

/** A working tree with every kind of change a checkpoint must capture or disclose. */
async function mixedTree(repo: ScratchRepo) {
  await repo.commit('Track files and ignore logs', { '.gitignore': '*.log\n', 'staged.txt': 'base\n' })
  await repo.write('staged.txt', 'staged change\n')
  await repo.git('add', 'staged.txt')
  await repo.dirty('README.md', '# Scratch repository\n\nUnsaved edit one.\n')
  await repo.write('untracked.txt', 'untracked\n')
  await repo.write('ignored.log', 'ignored\n')
  await writeFile(join(repo.path, 'image.bin'), binary)
}

/** What the user's own Git state looks like: none of it may change when a checkpoint is created. */
async function userState(repo: ScratchRepo) {
  return {
    head: await repo.head(),
    branch: await repo.git('symbolic-ref', '--short', 'HEAD'),
    status: await repo.status(),
    index: await repo.git('diff', '--cached'),
    stash: await repo.git('stash', 'list'),
    refs: await repo.git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/stash'),
  }
}

async function openWorkspace(profile: ScratchProfile, repo: ScratchRepo): Promise<string> {
  return (await profile.call('workspace.open', { path: repo.path })).workspace.id
}

test('a checkpoint records the tree and index, discloses its coverage and leaves the user\'s Git state alone', async ({ profile, repo }) => {
  await mixedTree(repo)
  const workspaceId = await openWorkspace(profile, repo)
  const before = await userState(repo)

  const created = await profile.cli('checkpoint', 'create', workspaceId, '--request-id', 'cp-create-1', '--label', 'before refactor')
  expect(created.code, created.stderr).toBe(0)
  const checkpoint = (created.json as { checkpoint: { checkpoint_id: string; commit: string; kind: string; label: string;
    ref_name: string; coverage: { untracked_files: number; ignored_entries: number; not_covered: string[] } } }).checkpoint
  expect(checkpoint).toMatchObject({ kind: 'manual', label: 'before refactor' })
  expect(checkpoint.ref_name).toBe(`refs/ade/checkpoints/${workspaceId}/${checkpoint.checkpoint_id}`)
  expect(checkpoint.coverage.untracked_files).toBe(2)
  expect(checkpoint.coverage.ignored_entries).toBeGreaterThanOrEqual(1)
  expect(checkpoint.coverage.not_covered).toEqual(expect.arrayContaining(['ignored files',
    'running processes, terminals and services']))

  // The user's branch, index, stash and refs are untouched.
  expect(await userState(repo)).toEqual(before)
  expect(await repo.git('rev-parse', checkpoint.ref_name)).toBe(checkpoint.commit)
  // The snapshot holds the binary file byte for byte and leaves the ignored one out.
  const shown = await repo.git('ls-tree', '-r', '--name-only', checkpoint.commit)
  expect(shown.split('\n').sort()).toEqual(['.gitignore', 'README.md', 'image.bin', 'staged.txt', 'untracked.txt'])

  // A duplicate request replays the stored reply; the same ID with other parameters conflicts.
  const replay = await profile.call('checkpoint.create', { operation_id: 'cp-create-1', workspace_id: workspaceId,
    label: 'before refactor' })
  expect(replay.checkpoint.checkpoint_id).toBe(checkpoint.checkpoint_id)
  const reused = await rawReply(profile, { op: 'checkpoint.create', operation_id: 'cp-create-1', workspace_id: workspaceId,
    label: 'something else' })
  expect(reused.type).toBe('error')
  expect(reused.message).toContain('different parameters')

  const listed = await profile.call('checkpoint.list', { workspace_id: workspaceId })
  expect(listed.checkpoints.map((entry) => entry.checkpoint_id)).toEqual([checkpoint.checkpoint_id])
  expect(listed.problems).toEqual([])

  // Checkpoints live in Git, so they outlive a daemon crash.
  await profile.restartDaemon('kill')
  const afterCrash = await profile.call('checkpoint.list', { workspace_id: workspaceId })
  expect(afterCrash.checkpoints.map((entry) => entry.checkpoint_id)).toEqual([checkpoint.checkpoint_id])
})

test('restore refuses to overwrite unsaved changes without confirmation or after they changed, then restores exactly', async ({ profile, repo }) => {
  await mixedTree(repo)
  const workspaceId = await openWorkspace(profile, repo)
  const { checkpoint } = await profile.call('checkpoint.create', { operation_id: 'cp-restore-1', workspace_id: workspaceId })
  const checkpointStatus = await repo.status()
  const checkpointIndex = await repo.git('diff', '--cached')

  // New unsaved work after the checkpoint.
  await repo.dirty('README.md', '# Scratch repository\n\nUnsaved edit two.\n')
  await rm(join(repo.path, 'untracked.txt'))
  await repo.write('later.txt', 'written after the checkpoint\n')
  await repo.git('reset', '--quiet', '--', 'staged.txt')

  const preview = await profile.call('checkpoint.restore.preview', { workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id })
  expect(preview.verdict).toBe('needs_confirmation')
  expect(preview.uncommitted_overwritten).toEqual(expect.arrayContaining(['README.md', 'later.txt']))
  expect(preview.changes.map((change) => change.path)).toEqual(expect.arrayContaining(['README.md', 'untracked.txt']))
  expect(preview.head_changed).toBe(false)

  // Without confirmation: refused, nothing written.
  const unconfirmed = await rawReply(profile, { op: 'checkpoint.restore', operation_id: 'restore-unconfirmed',
    workspace_id: workspaceId, checkpoint_id: checkpoint.checkpoint_id, expected_state: preview.state_token })
  expect(unconfirmed.type).toBe('error')
  expect(unconfirmed.message).toContain('confirm_overwrite')
  expect(await repo.read('README.md')).toContain('Unsaved edit two')

  // The tree changes after the preview: the preview is stale and the restore refuses, even confirmed.
  await repo.dirty('README.md', '# Scratch repository\n\nUnsaved edit three.\n')
  const stale = await rawReply(profile, { op: 'checkpoint.restore', operation_id: 'restore-stale',
    workspace_id: workspaceId, checkpoint_id: checkpoint.checkpoint_id, expected_state: preview.state_token,
    confirm_overwrite: true })
  expect(stale.type).toBe('error')
  expect(await repo.read('README.md')).toContain('Unsaved edit three')

  const fresh = await profile.call('checkpoint.restore.preview', { workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id })
  expect(fresh.state_token).not.toBe(preview.state_token)
  const restored = await profile.cli('checkpoint', 'restore', workspaceId, checkpoint.checkpoint_id, fresh.state_token,
    '--request-id', 'restore-confirmed', '--confirm-overwrite')
  expect(restored.code, restored.stderr).toBe(0)
  const reply = restored.json as { outcome: string; verified: boolean; problems: string[];
    safety_checkpoint: { checkpoint_id: string; kind: string } | null }
  expect(reply).toMatchObject({ outcome: 'restored', verified: true, problems: [] })
  expect(reply.safety_checkpoint?.kind).toBe('safety')

  // The tree and index match the checkpoint; the ignored file was never touched.
  expect(await repo.status()).toEqual(checkpointStatus)
  expect(await repo.git('diff', '--cached')).toBe(checkpointIndex)
  expect(await repo.read('README.md')).toContain('Unsaved edit one')
  expect(await readFile(join(repo.path, 'image.bin'))).toEqual(binary)
  expect(await repo.read('ignored.log')).toBe('ignored\n')

  // A duplicate restore replays its reply and writes nothing again.
  await repo.dirty('README.md', '# Scratch repository\n\nEdited after the restore.\n')
  const replay = await profile.call('checkpoint.restore', { operation_id: 'restore-confirmed', workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id, expected_state: fresh.state_token, confirm_overwrite: true })
  expect(replay.safety_checkpoint?.checkpoint_id).toBe(reply.safety_checkpoint?.checkpoint_id)
  expect(await repo.read('README.md')).toContain('Edited after the restore')

  // Nothing was lost: the safety checkpoint brings the replaced work back.
  const listed = await profile.call('checkpoint.list', { workspace_id: workspaceId })
  expect(listed.checkpoints.map((entry) => entry.kind).sort()).toEqual(['manual', 'safety'])
  const back = await profile.call('checkpoint.restore.preview', { workspace_id: workspaceId,
    checkpoint_id: reply.safety_checkpoint!.checkpoint_id })
  await profile.call('checkpoint.restore', { operation_id: 'restore-safety', workspace_id: workspaceId,
    checkpoint_id: reply.safety_checkpoint!.checkpoint_id, expected_state: back.state_token, confirm_overwrite: true })
  expect(await repo.read('README.md')).toContain('Unsaved edit three')
  expect(await repo.read('later.txt')).toBe('written after the checkpoint\n')
})

test('restore refuses to overwrite an ignored file in its way and leaves it intact', async ({ profile, repo }) => {
  const workspaceId = await openWorkspace(profile, repo)
  await repo.write('cache/data.txt', 'checkpointed\n')
  const { checkpoint } = await profile.call('checkpoint.create', { operation_id: 'cp-ignored', workspace_id: workspaceId })

  await rm(join(repo.path, 'cache'), { recursive: true })
  await mkdir(join(repo.path, '.git', 'info'), { recursive: true })
  await writeFile(join(repo.path, '.git', 'info', 'exclude'), 'cache/\n')
  await repo.write('cache/data.txt', 'ignored local data\n')

  const preview = await profile.call('checkpoint.restore.preview', { workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id })
  expect(preview.verdict).toBe('blocked')
  expect(preview.ignored_overwritten).toEqual(['cache/data.txt'])
  const refused = await rawReply(profile, { op: 'checkpoint.restore', operation_id: 'restore-ignored',
    workspace_id: workspaceId, checkpoint_id: checkpoint.checkpoint_id, expected_state: preview.state_token,
    confirm_overwrite: true })
  expect(refused.type).toBe('error')
  expect(await repo.read('cache/data.txt')).toBe('ignored local data\n')
})

test('delete needs the commit the caller saw and replays a duplicate request', async ({ profile, repo }) => {
  const workspaceId = await openWorkspace(profile, repo)
  await repo.dirty()
  const { checkpoint } = await profile.call('checkpoint.create', { operation_id: 'cp-delete', workspace_id: workspaceId })

  const wrong = await rawReply(profile, { op: 'checkpoint.delete', operation_id: 'delete-wrong', workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id, expected_commit: await repo.head() })
  expect(wrong.type).toBe('error')
  expect((await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints).toHaveLength(1)

  const deleted = await profile.cli('checkpoint', 'delete', workspaceId, checkpoint.checkpoint_id, checkpoint.commit,
    '--request-id', 'delete-right')
  expect(deleted.code, deleted.stderr).toBe(0)
  expect((await profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints).toEqual([])
  const replay = await profile.call('checkpoint.delete', { operation_id: 'delete-right', workspace_id: workspaceId,
    checkpoint_id: checkpoint.checkpoint_id, expected_commit: checkpoint.commit })
  expect(replay.ref_name).toBe(checkpoint.ref_name)
})
