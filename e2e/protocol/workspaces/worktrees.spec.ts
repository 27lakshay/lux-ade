// `workspace.create_worktree` and `workspace.delete_worktree` (daemon authority
// ticket 03): one daemon operation each for what a client used to chain
// itself. Creation makes the tree through the lifecycle and opens it as a
// named, ADE-owned workspace; deletion checks every blocker first, removes the
// workspace from ADE, then the tree, and recovers a crash between the two.
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type ScratchProfile } from '../fixtures'
import { binaries } from '../fixtures/environment'
import { subscribeFeed } from '../fixtures/feed'
import { operationId, register } from '../worktrees/lifecycle'

type ClientModule = typeof import('../../../packages/client/dist/index.js')

async function catalog(profile: ScratchProfile) {
  return (await profile.call('catalog.get', {})).catalog
}

/** Sends the operation again under its ID until it leaves `running`, and returns its state. */
async function finished<T extends { status: string }>(send: () => Promise<T>): Promise<T> {
  let state: T | undefined
  await expect.poll(async () => (state = await send()).status, { timeout: 60_000 }).not.toBe('running')
  return state!
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

async function worktreeOf(profile: ScratchProfile, projectId: string, name: string) {
  const id = operationId('create')
  const state = await finished(() =>
    profile.call('workspace.create_worktree', { operation_id: id, project_id: projectId, name }),
  )
  expect(state, JSON.stringify(state)).toMatchObject({ status: 'succeeded' })
  return { id, workspaceId: state.workspace_id!, path: state.worktree_path! }
}

test('create_worktree makes the tree, opens it as a named ADE-owned workspace and replays', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const id = operationId('create')
  const created = await profile.cli(
    '--operation-id',
    id,
    'workspace',
    'create-worktree',
    main.project_id,
    'Payments API',
    '--wait',
  )
  expect(created.code, created.stderr).toBe(0)
  expect(created.json).toMatchObject({
    type: 'workspace_worktree_operation',
    operation_id: id,
    kind: 'create_worktree',
    status: 'succeeded',
    project_id: main.project_id,
    error: null,
  })
  const reply = created.json as { workspace_id: string; worktree_path: string }
  expect(existsSync(reply.worktree_path)).toBe(true)

  // The workspace is in the catalog under the name as typed, in the project.
  const listed = (await catalog(profile)).workspaces.find((workspace) => workspace.id === reply.workspace_id)
  const listing = await profile.call('worktree.get', { project_id: main.project_id })
  const tree = listing.worktrees.find((item) => item.path === reply.worktree_path)
  expect(tree?.ade_owned).toBe(true)
  expect(listed).toMatchObject({
    name: 'Payments API',
    root: reply.worktree_path,
    project_id: main.project_id,
    kind: 'linked_worktree',
    ade_owned: true,
    branch: tree?.branch,
  })

  // The lifecycle step is readable under the project ID and this operation ID.
  const lifecycle = await profile.call('worktree.operation', { project_id: main.project_id, operation_id: id })
  expect(lifecycle.operation).toMatchObject({ status: 'succeeded', worktree_path: reply.worktree_path })

  // A retry replays the state; the same ID for another request conflicts.
  const replay = await profile.call('workspace.create_worktree', {
    operation_id: id,
    project_id: main.project_id,
    name: 'Payments API',
  })
  expect(replay).toEqual(created.json)
  const conflict = await refusal(
    profile.call('workspace.create_worktree', { operation_id: id, project_id: main.project_id, name: 'Other' }),
  )
  expect(conflict.code).toBe('conflict')
  expect(listing.worktrees).toHaveLength(2)
})

test('create_worktree refuses a folder project, an unknown project and an invalid name', async ({ ade, profile }) => {
  const folder = join(profile.root, 'folders', 'notes')
  await mkdir(folder, { recursive: true })
  const notes = (await profile.call('workspace.open', { path: await realpath(folder) })).workspace
  const plain = await refusal(profile.call('workspace.create_worktree', { project_id: notes.project_id, name: 'x' }))
  expect(plain.code).toBe('project_not_repository')
  const missing = await refusal(profile.call('workspace.create_worktree', { project_id: 'repo_missing', name: 'x' }))
  expect(missing.code).toBe('project_not_found')
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const invalid = await refusal(profile.call('workspace.create_worktree', { project_id: main.project_id, name: ' ' }))
  expect(invalid.code).toBe('invalid_workspace_name')
  const cli = await profile.cli('workspace', 'create-worktree', notes.project_id, 'x')
  expect(cli.code).toBe(25)
  // Nothing was created.
  expect((await repo.git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
})

test('delete_worktree refuses a dirty tree, the main checkout and a folder before changing anything', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { workspaceId, path } = await worktreeOf(profile, main.project_id, 'Dirty')
  await writeFile(join(path, 'scratch.txt'), 'uncommitted\n')

  const dirty = await refusal(profile.call('workspace.delete_worktree', { workspace_id: workspaceId }))
  expect(dirty.code).toBe('worktree_delete_blocked')
  expect(dirty.details.blockers).toContainEqual(expect.objectContaining({ kind: 'dirty', id: path }))
  // Nothing changed: the workspace is listed and the tree is there.
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).toContain(workspaceId)
  expect(existsSync(join(path, 'scratch.txt'))).toBe(true)
  const cli = await profile.cli('workspace', 'delete-worktree', workspaceId)
  expect(cli.code).toBe(24)
  expect(cli.json).toMatchObject({
    code: 'worktree_delete_blocked',
    blockers: [expect.objectContaining({ kind: 'dirty' })],
  })

  const primary = await refusal(profile.call('workspace.delete_worktree', { workspace_id: main.id }))
  expect(primary.details.blockers).toEqual([expect.objectContaining({ kind: 'primary_checkout' })])
  const folderPath = join(profile.root, 'folders', 'plain')
  await mkdir(folderPath, { recursive: true })
  const plain = (await profile.call('workspace.open', { path: await realpath(folderPath) })).workspace
  const folder = await refusal(profile.call('workspace.delete_worktree', { workspace_id: plain.id }))
  expect(folder.details.blockers).toEqual([expect.objectContaining({ kind: 'not_a_worktree', id: plain.id })])
  const missing = await refusal(profile.call('workspace.delete_worktree', { workspace_id: 'workspace_missing' }))
  expect(missing.code).toBe('workspace_not_found')

  // Once clean, it is deleted: workspace and tree both go, and a retry replays.
  await rm(join(path, 'scratch.txt'))
  const id = operationId('delete')
  const deleted = await profile.cli('--operation-id', id, 'workspace', 'delete-worktree', workspaceId, '--wait')
  expect(deleted.code, deleted.stderr).toBe(0)
  expect(deleted.json).toMatchObject({ kind: 'delete_worktree', status: 'succeeded', workspace_id: workspaceId })
  expect(existsSync(path)).toBe(false)
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
  const replay = await profile.call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId })
  expect(replay).toEqual(deleted.json)
})

test('a daemon crash between removing the workspace and removing the tree recovers @fault', async ({ ade }) => {
  const pause = join(ade.root, 'pause-delete')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_RECEIPT_PAUSE_DIR: pause } })
  const repo = await ade.repo()
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { workspaceId, path } = await worktreeOf(profile, main.project_id, 'Crash')

  const armed = join(pause, 'workspace.delete_worktree.armed')
  await writeFile(armed, '')
  const id = operationId('delete')
  const pending = profile
    .call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId })
    .catch((error: unknown) => error)
  await expect.poll(() => existsSync(join(pause, 'workspace.delete_worktree.paused')), { timeout: 30_000 }).toBe(true)
  // Paused between the steps: the workspace is removed, the tree is not.
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
  expect(existsSync(path)).toBe(true)

  await rm(armed)
  await profile.restartDaemon('kill')
  await pending
  // The new daemon takes the next step itself; a retry reads the outcome.
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(false)
  const state = await finished(() =>
    profile.call('workspace.delete_worktree', { operation_id: id, workspace_id: workspaceId }),
  )
  expect(state).toMatchObject({ status: 'succeeded', workspace_id: workspaceId, worktree_path: path })
  expect((await catalog(profile)).workspaces.map((workspace) => workspace.id)).not.toContain(workspaceId)
})

test('create_worktree with show_in shows the new workspace in that window once it is ready', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  await profile.call('window.create', { window_id: 'asking', workspace_id: main.id })
  const id = operationId('create')
  const state = await finished(() =>
    profile.call('workspace.create_worktree', {
      operation_id: id,
      project_id: main.project_id,
      name: 'Shown',
      show_in: 'asking',
    }),
  )
  expect(state).toMatchObject({ status: 'succeeded' })
  const window = (await catalog(profile)).windows.find((item) => item.id === 'asking')!
  expect(window.workspace_id).toBe(state.workspace_id)
  expect(window.view.recent_workspaces).toEqual([state.workspace_id, main.id])

  // A window that is gone by then leaves the creation successful.
  const unshown = operationId('create')
  const gone = await finished(() =>
    profile.call('workspace.create_worktree', {
      operation_id: unshown,
      project_id: main.project_id,
      name: 'Unshown',
      show_in: 'window-missing',
    }),
  )
  expect(gone).toMatchObject({ status: 'succeeded' })
})

test('each step of a worktree operation is on the feed, and the SDK waits for the last one there', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const feed = await subscribeFeed(profile)
  await feed.connected()
  const id = operationId('create')
  // The SDK helper, as Electron main uses it: one send, then the feed.
  const sdk = (await import(pathToFileURL(binaries.client).href)) as ClientModule
  let sends = 0
  const state = await sdk.settleWorktreeOperation(feed.client, id, () => {
    sends++
    return profile.call('workspace.create_worktree', { operation_id: id, project_id: main.project_id, name: 'Fed' })
  })
  expect(state).toMatchObject({ operation_id: id, status: 'succeeded' })
  expect(sends).toBe(1)
  const steps = feed.frames
    .filter((frame) => frame.type === 'workspace_worktree_operation_changed' && frame.operation.operation_id === id)
    .map((frame) => (frame as { operation: { status: string } }).operation.status)
  expect(steps[0]).toBe('running')
  expect(steps.at(-1)).toBe('succeeded')
  feed.stop()
})

/**
 * A socket in front of the daemon's for the CLI. It counts the connections
 * that send `workspace.create_worktree`, holds back the daemon's reply to the
 * first until `release`, and watches the CLI's feed connection.
 */
async function sendCounter(target: string, path: string) {
  const seen = { sends: 0, feedFrames: 0, feedClosed: false }
  let release: (() => void) | null = null
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    const daemon = createConnection({ path: target })
    for (const socket of [client, daemon]) {
      sockets.add(socket)
      socket.on('error', () => {})
    }
    let kind: 'unknown' | 'feed' | 'send' = 'unknown'
    let upstream = ''
    // The daemon's bytes held back from this connection, while it is the held one.
    let held: Buffer[] | null = null
    let ended = false
    client.on('data', (chunk: Buffer) => {
      if (kind === 'unknown') {
        upstream += chunk.toString('utf8')
        if (upstream.includes('"op":"session.subscribe"')) kind = 'feed'
        if (upstream.includes('"op":"workspace.create_worktree"')) {
          kind = 'send'
          seen.sends++
          if (seen.sends === 1) {
            held = []
            release = () => {
              client.write(Buffer.concat(held ?? []))
              held = null
              if (ended) client.end()
            }
          }
        }
      }
      daemon.write(chunk)
    })
    daemon.on('data', (chunk: Buffer) => {
      if (kind === 'feed') seen.feedFrames += chunk.toString('utf8').split('\n').length - 1
      if (held) held.push(chunk)
      else client.write(chunk)
    })
    daemon.on('end', () => {
      ended = true
      if (!held) client.end()
    })
    client.on('close', () => {
      if (kind === 'feed') seen.feedClosed = true
      daemon.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return {
    seen,
    /** Delivers the held reply. */
    release() {
      release?.()
    },
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

test('the CLI waits for a worktree operation on the feed instead of sending it again', async ({ ade, profile }) => {
  const repo = await ade.repo({ name: 'shop' })
  const main = (await profile.call('workspace.open', { path: repo.path })).workspace
  const started = join(ade.root, 'setup-started')
  const release = join(ade.root, 'setup-release')
  // The lifecycle takes the catalog's project ID once it registers the repository.
  expect(await register(profile, repo)).toBe(main.project_id)
  await profile.call('worktree.configure', {
    project_id: main.project_id,
    config: {
      setup: [
        {
          name: 'wait',
          command: ['/bin/sh', '-c', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
          timeout_seconds: 60,
        },
      ],
    },
  })
  const socket = join(dirname(profile.socket), 'cli.sock')
  const counter = await sendCounter(profile.socket, socket)
  const id = operationId('create')
  const run = profile.cli(
    '--socket',
    socket,
    '--operation-id',
    id,
    'workspace',
    'create-worktree',
    main.project_id,
    'Fed',
    '--wait',
  )

  try {
    // The CLI sent the command once and follows the feed while setup runs.
    await expect.poll(() => existsSync(started) && counter.seen.feedFrames > 0, { timeout: 20_000 }).toBe(true)
    await writeFile(release, '')
    // The final state reached it on the feed: it stops following while the
    // reply to its one send is still held back.
    await expect.poll(() => counter.seen.feedClosed, { timeout: 20_000 }).toBe(true)
    expect(counter.seen.sends).toBe(1)
  } finally {
    // Let the setup and the CLI finish even when an expectation failed.
    await writeFile(release, '')
    counter.release()
  }

  const created = await run
  counter.close()
  expect(created.code, created.stderr).toBe(0)
  expect(created.json).toMatchObject({ operation_id: id, status: 'succeeded', project_id: main.project_id })
  expect(counter.seen.sends).toBe(1)
})
