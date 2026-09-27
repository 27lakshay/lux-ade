// Error propagation through the SDK and the CLI (F102 stable errors and exit
// codes, F103 SDK). A daemon refusal keeps its own code and recovery hint all
// the way to the caller: `DaemonRequestError.code` and `.recovery` in the SDK,
// the JSON error body and a documented exit code in the CLI. Each refusal is a
// real one from a running daemon, and each is followed by the recovery it names.
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, test } from '../fixtures'
import { startHostProfiles } from '../fixtures/host-profiles'
import { rawReply } from '../fixtures/raw-reply'
import { adopt, cliError, externalTree, occupy, sdkError, waitForClaim } from './steps'

test('a host_resource_conflict keeps its code and recovery through the SDK and the CLI, across a retry and a restart',
  async ({ ade, repo }) => {
    const { profiles: [worker, remover] } = await startHostProfiles(ade, 2)
    const tree = await externalTree(ade, repo, 'shared')
    const repositoryId = await adopt(remover, repo.path, tree)
    const { workspace, shellPid } = await occupy(worker, tree)
    await waitForClaim(remover, tree)
    const remove = (operationId: string) => ({ repository_id: repositoryId, operation_id: operationId,
      path: tree, confirm_path: tree })

    // The daemon's own frame is the reference the SDK and CLI must match.
    const frame = await rawReply(remover, { op: 'worktree.remove', ...remove('remove-raw') })
    expect(frame).toMatchObject({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources' })

    const refused = await sdkError(remover.call('worktree.remove', remove('remove-sdk')))
    expect(refused).toMatchObject({ code: 'host_resource_conflict', recovery: 'inspect_host_resources',
      replied: true, message: frame.message })
    expect(['rejected', 'unknown']).toContain(refused.delivery)

    // A duplicate of the same request gets the same answer: the refusal left no receipt behind.
    const again = await sdkError(remover.call('worktree.remove', remove('remove-sdk')))
    expect(again).toMatchObject({ code: 'host_resource_conflict', recovery: 'inspect_host_resources',
      delivery: refused.delivery })

    const cli = await remover.cli('request', 'worktree.remove', JSON.stringify(remove('remove-cli')))
    expect(cli.code).toBe(14)
    expect(cliError(cli)).toEqual({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources',
      message: frame.message, delivery: refused.delivery })

    // A crashed and restarted remover still reports the conflict with its code: nothing was cached client side.
    await remover.restartDaemon('kill')
    const afterRestart = await sdkError(remover.call('worktree.remove', remove('remove-sdk')))
    expect(afterRestart).toMatchObject({ code: 'host_resource_conflict', recovery: 'inspect_host_resources' })
    expect((await remover.cli('request', 'worktree.remove', JSON.stringify(remove('remove-cli')))).code).toBe(14)
    expect(await isRunning(shellPid)).toBe(true)

    // Following the recovery hint: inspect names the claim; once it goes, the same request is admitted.
    const claims = (await remover.call('resources.inspect', { path: tree, resource: 'checkout' })).claims
    expect(claims).toHaveLength(1)
    expect(frame.message).toContain(claims[0].id)
    await worker.call('terminal.stop', { workspace_id: workspace.id, terminal_id: workspace.terminal_id })
    await expect.poll(async () => (await remover.call('resources.inspect', { path: tree, resource: 'checkout' }))
      .claims.length).toBe(0)
    expect((await remover.call('worktree.remove', remove('remove-sdk'))).type).toBe('worktree_state')
  })

test('a needs_rebind keeps its code and recovery through the SDK and the CLI until the workspace is rebound',
  async ({ ade, profile }) => {
    const folder = join(ade.root, 'moved')
    await mkdir(folder)
    const { workspace } = await profile.call('workspace.open', { path: folder })
    expect((await profile.call('file.list', { workspace_id: workspace.id })).type).toBeTruthy()

    // The saved folder is replaced by another directory at the same path.
    await rm(folder, { recursive: true })
    await mkdir(folder)

    const frame = await rawReply(profile, { op: 'file.list', workspace_id: workspace.id })
    expect(frame).toMatchObject({ type: 'error', code: 'needs_rebind', recovery: 'rebind_workspace' })

    const refused = await sdkError(profile.call('file.list', { workspace_id: workspace.id }))
    expect(refused).toMatchObject({ code: 'needs_rebind', recovery: 'rebind_workspace', replied: true,
      message: frame.message })

    const cli = await profile.cli('file', 'list', workspace.id)
    expect(cli.code).toBe(13)
    expect(cliError(cli)).toMatchObject({ code: 'needs_rebind', recovery: 'rebind_workspace', message: frame.message })

    // The refusal survives a daemon restart unchanged.
    await profile.restartDaemon()
    expect(await sdkError(profile.call('file.list', { workspace_id: workspace.id })))
      .toMatchObject({ code: 'needs_rebind', recovery: 'rebind_workspace' })

    // Following the recovery hint clears it.
    await profile.call('workspace.rebind', { workspace_id: workspace.id, path: folder })
    expect((await profile.call('file.list', { workspace_id: workspace.id })).type).toBeTruthy()
    const listed = await profile.cli('file', 'list', workspace.id)
    expect(listed.code, listed.stderr).toBe(0)
  })

test('a lifecycle refusal keeps its lifecycle code and recovery through the SDK and the CLI', async ({ ade, profile }) => {
  const plain = join(ade.root, 'not-a-repository')
  await mkdir(plain)

  const frame = await rawReply(profile, { op: 'worktree.repository', path: plain })
  expect(frame).toMatchObject({ type: 'error', code: 'lifecycle_command_failed', recovery: 'inspect_repository' })

  const refused = await sdkError(profile.call('worktree.repository', { path: plain }))
  expect(refused).toMatchObject({ code: 'lifecycle_command_failed', recovery: 'inspect_repository', replied: true,
    message: frame.message })

  const cli = await profile.cli('request', 'worktree.repository', JSON.stringify({ path: plain }))
  expect(cli.code).toBe(16)
  expect(cliError(cli)).toMatchObject({ code: 'lifecycle_command_failed', recovery: 'inspect_repository',
    message: frame.message })

  // The daemon message never carries Git's own output.
  expect(frame.message).not.toContain('fatal')
})

test('a daemon error with no code stays daemon, and local failures keep their own codes', async ({ profile }) => {
  const frame = await rawReply(profile, { op: 'file.list', workspace_id: 'workspace-missing' })
  expect(frame.type).toBe('error')
  expect(frame.code).toBeUndefined()

  const refused = await sdkError(profile.call('file.list', { workspace_id: 'workspace-missing' }))
  expect(refused).toMatchObject({ code: 'daemon', replied: true, message: frame.message })
  expect(refused.recovery).toBeUndefined()
  const cli = await profile.cli('file', 'list', 'workspace-missing')
  expect(cli.code).toBe(7)
  expect(cliError(cli)).not.toHaveProperty('recovery')

  // A request refused before sending never reaches the daemon.
  const invalid = await sdkError(profile.call('file.list', { workspace_id: 42 } as never))
  expect(invalid).toMatchObject({ code: 'invalid_request', delivery: 'not_sent', replied: false })
  expect((await profile.cli('request', 'file.list', JSON.stringify({ workspace_id: 42 }))).code).toBe(2)

  // A dead daemon is unavailable, not a refusal.
  await profile.killDaemon()
  const gone = await sdkError(profile.call('file.list', { workspace_id: 'workspace-missing' }))
  expect(gone).toMatchObject({ code: 'unavailable', delivery: 'not_sent', replied: false })
  const offline = await profile.cli('file', 'list', 'workspace-missing')
  expect(offline.code).toBe(3)
  expect(cliError(offline)).toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
})

test('a host_resources_unavailable keeps its code and recovery through the SDK and the CLI', async ({ ade, repo }) => {
  const { profilesHome, profiles: [holder, remover] } = await startHostProfiles(ade, 2)
  const tree = await externalTree(ade, repo, 'registry')
  const repositoryId = await adopt(remover, repo.path, tree)
  await occupy(holder, tree)
  await waitForClaim(remover, tree)
  const registry = join(profilesHome, 'host-resources.sqlite3')
  expect((await remover.call('resources.inspect', {})).registry.path).toBe(registry)

  // The registry goes missing while another profile still holds a claim in it.
  await rename(registry, `${registry}.lost`)
  await remover.restartDaemon()
  const request = { repository_id: repositoryId, operation_id: 'remove-blocked', path: tree, confirm_path: tree }
  const frame = await rawReply(remover, { op: 'worktree.remove', ...request })
  expect(frame).toMatchObject({ type: 'error', code: 'host_resources_unavailable', recovery: 'recover_host_resources' })

  expect(await sdkError(remover.call('worktree.remove', request))).toMatchObject({ code: 'host_resources_unavailable',
    recovery: 'recover_host_resources', replied: true, message: frame.message })
  const cli = await remover.cli('request', 'worktree.remove', JSON.stringify(request))
  expect(cli.code).toBe(15)
  expect(cliError(cli)).toMatchObject({ code: 'host_resources_unavailable', recovery: 'recover_host_resources',
    message: frame.message })
})
