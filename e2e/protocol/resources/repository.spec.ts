// Repository clone and publish (F062, D08) against local bare repositories
// over file:// URLs, through the SDK, the CLI and the raw protocol. The fault
// cases are a destination that already exists, a duplicate or reused
// operation ID, a push whose Git process is killed, and a daemon killed while
// its push is in flight: both pushes must settle as unknown, never as "not
// pushed", and never push again under the same ID.
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type AdeHarness, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { processTable } from '../fixtures/processes'
import { rawReply } from '../fixtures/raw-reply'
import { exists } from './steps'

/** A bare repository cloned from `source`, and its file:// URL. */
async function bareFrom(ade: AdeHarness, source: ScratchRepo, name: string) {
  const path = join(ade.root, 'remotes', `${name}.git`)
  await mkdir(join(ade.root, 'remotes'), { recursive: true })
  await source.git('clone', '--quiet', '--bare', source.path, path)
  return { path, url: pathToFileURL(path).href }
}

/** An empty bare repository, and its file:// URL. */
async function emptyBare(ade: AdeHarness, source: ScratchRepo, name: string) {
  const path = join(ade.root, 'remotes', `${name}.git`)
  await mkdir(path, { recursive: true })
  await source.git('init', '--quiet', '--bare', '--initial-branch=main', path)
  return { path, url: pathToFileURL(path).href }
}

/** The commit a bare repository's branch points at, or '' when it has none. */
async function remoteBranch(repo: ScratchRepo, bare: string, branch: string): Promise<string> {
  return repo.git('--git-dir', bare, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`)
}

/** A plain folder with files and no Git repository, ready to publish. */
async function plainFolder(ade: AdeHarness, name: string): Promise<string> {
  const folder = join(ade.root, 'folders', name)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'index.txt'), 'first file\n')
  return folder
}

/**
 * Make `bare` hold every push inside its pre-receive hook, after the pack has
 * arrived, until `release` exists. The hook writes `started` when it begins.
 */
async function holdPushes(ade: AdeHarness, bare: string) {
  const started = join(ade.root, 'push-started')
  const release = join(ade.root, 'push-release')
  const hook = join(bare, 'hooks', 'pre-receive')
  await writeFile(hook, `#!/bin/sh\ncat >/dev/null\n: > '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`)
  await chmod(hook, 0o755)
  return { started, release }
}

/** The `git push` the daemon runs for a publish, found among its children. */
async function daemonPush(profile: ScratchProfile): Promise<number> {
  const daemon = profile.hello.pid
  const rows = await processTable()
  const push = rows.find((row) => row.ppid === daemon && /\bgit\b.*\bpush --porcelain\b/.test(row.command))
  if (!push) throw new Error(`No git push under daemon ${daemon}`)
  return push.pid
}

test('clone from a local bare repository registers the project and never writes over an existing path', async ({ ade, profile, repo }) => {
  const head = await repo.commit('Second commit', { 'src/main.txt': 'hello\n' })
  const remote = await bareFrom(ade, repo, 'origin')

  const coverage = await profile.call('repository.coverage', {})
  expect(coverage.forge_apis).toBe(false)
  expect(coverage.transports.find((entry) => entry.transport === 'file')?.supported).toBe(true)
  expect(coverage.transports.find((entry) => entry.transport === 'local_path')?.supported).toBe(false)

  const destination = join(ade.root, 'clones', 'project')
  await mkdir(join(ade.root, 'clones'), { recursive: true })
  const cloned = await profile.cli('repository', 'clone', remote.url, destination, '--request-id', 'clone-1')
  expect(cloned.code, cloned.stderr).toBe(0)
  const reply = cloned.json as { outcome: string; head: string; branch: string; workspace: { id: string; root: string } }
  expect(reply).toMatchObject({ outcome: 'registered', head, branch: 'main' })
  expect(await readFile(join(destination, 'src', 'main.txt'), 'utf8')).toBe('hello\n')
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.workspaces.map((workspace) => workspace.id)).toContain(reply.workspace.id)

  // A duplicate request replays the stored result without cloning again; the
  // same ID with other parameters is refused.
  const replay = await profile.call('repository.clone', { operation_id: 'clone-1', url: remote.url, destination })
  expect(replay.workspace?.id).toBe(reply.workspace.id)
  const reused = await rawReply(profile, { op: 'repository.clone', operation_id: 'clone-1', url: remote.url,
    destination: join(ade.root, 'clones', 'other') })
  expect(reused.type).toBe('error')
  expect(reused.message).toContain('different parameters')
  expect(await exists(join(ade.root, 'clones', 'other'))).toBe(false)

  // An existing destination is refused and left exactly as it was.
  const occupied = join(ade.root, 'clones', 'occupied')
  await mkdir(occupied)
  await writeFile(join(occupied, 'keep.txt'), 'mine\n')
  const refused = await rawReply(profile, { op: 'repository.clone', operation_id: 'clone-occupied', url: remote.url,
    destination: occupied })
  expect(refused.type).toBe('error')
  expect(await readdir(occupied)).toEqual(['keep.txt'])

  // A bare local path and a missing remote are refused and leave nothing behind.
  const bareRefused = await rawReply(profile, { op: 'repository.clone', operation_id: 'clone-bare-path', url: remote.path,
    destination: join(ade.root, 'clones', 'bare-path') })
  expect(bareRefused.type).toBe('error')
  const missing = await rawReply(profile, { op: 'repository.clone', operation_id: 'clone-missing',
    url: pathToFileURL(join(ade.root, 'remotes', 'missing.git')).href, destination: join(ade.root, 'clones', 'missing') })
  expect(missing.type).toBe('error')
  expect(await exists(join(ade.root, 'clones', 'missing'))).toBe(false)
})

test('publish initialises a folder, commits only when asked, adds the remote and pushes without force', async ({ ade, profile, repo }) => {
  const remote = await emptyBare(ade, repo, 'published')
  const folder = await plainFolder(ade, 'publish-me')

  const preview = await profile.call('repository.publish.preview', { path: folder, url: remote.url })
  expect(preview.verdict).toBe('needs_initial_commit')

  // Without an initial commit the publish stops before pushing and says what it did.
  const uncommitted = await rawReply(profile, { op: 'repository.publish', operation_id: 'publish-no-commit',
    path: folder, url: remote.url })
  expect(uncommitted.type === 'error' || (uncommitted as { outcome?: string }).outcome === 'not_pushed',
    JSON.stringify(uncommitted)).toBe(true)
  expect(await remoteBranch(repo, remote.path, 'main')).toBe('')

  const published = await profile.cli('repository', 'publish', folder, remote.url, '--request-id', 'publish-1',
    '--initial-commit', '--message', 'Initial import')
  expect(published.code, published.stderr).toBe(0)
  const reply = published.json as { outcome: string; commit: string; pushed: boolean; initial_commit: string | null }
  expect(reply).toMatchObject({ outcome: 'published', pushed: true })
  expect(await remoteBranch(repo, remote.path, 'main')).toBe(reply.commit)

  // A duplicate request replays; a new ID with nothing new to push is confirmed with no new steps.
  const replay = await profile.call('repository.publish', { operation_id: 'publish-1', path: folder, url: remote.url,
    create_initial_commit: true, commit_message: 'Initial import' })
  expect(replay.commit).toBe(reply.commit)
  const again = await profile.call('repository.publish', { operation_id: 'publish-2', path: folder, url: remote.url })
  expect(again).toMatchObject({ outcome: 'published', initialized: false, initial_commit: null, remote_added: false,
    commit: reply.commit })

  // An existing remote is never repointed, and a diverged remote branch is never force-pushed.
  const other = await emptyBare(ade, repo, 'other')
  const repointed = await rawReply(profile, { op: 'repository.publish', operation_id: 'publish-other', path: folder,
    url: other.url })
  expect(repointed.type).toBe('error')
  expect(await remoteBranch(repo, other.path, 'main')).toBe('')

  const diverged = join(ade.root, 'diverged')
  await repo.git('clone', '--quiet', remote.path, diverged)
  await repo.git('-C', diverged, '-c', 'user.name=Other', '-c', 'user.email=o@example.invalid', 'commit', '--quiet',
    '--allow-empty', '-m', 'Remote-only commit')
  await repo.git('-C', diverged, 'push', '--quiet', 'origin', 'main')
  const remoteOnly = await remoteBranch(repo, remote.path, 'main')
  await writeFile(join(folder, 'index.txt'), 'local change\n')
  await repo.git('-C', folder, 'commit', '--quiet', '-am', 'Local-only commit')
  const rejected = await profile.call('repository.publish', { operation_id: 'publish-diverged', path: folder, url: remote.url })
  expect(rejected).toMatchObject({ outcome: 'not_pushed', pushed: false, failed_step: 'push' })
  expect(await remoteBranch(repo, remote.path, 'main')).toBe(remoteOnly)
})

test('a push whose Git process is killed settles as unknown and never pushes again', async ({ ade, profile, repo }) => {
  const remote = await emptyBare(ade, repo, 'held')
  const { started, release } = await holdPushes(ade, remote.path)
  const folder = await plainFolder(ade, 'killed-push')
  const request = { op: 'repository.publish', operation_id: 'publish-killed', path: folder, url: remote.url,
    create_initial_commit: true }

  const pending = rawReply(profile, request, 60_000)
  try {
    await expect.poll(() => exists(started), { timeout: 20_000 }).toBe(true)
    await ade.ledger.sweep()
    // While the push runs, the folder carries a host-wide shared-use claim.
    const claims = (await profile.call('resources.inspect', { path: folder })).claims
    expect(claims.map((claim) => [claim.purpose, claim.state])).toEqual([['use', 'active']])

    process.kill(await daemonPush(profile), 'SIGKILL')
    const reply = await pending
    expect(reply.type, JSON.stringify(reply)).toBe('error')
    expect(reply.message).toContain('outcome is unknown')
    expect(reply.message).not.toContain('not pushed')
  } finally {
    await writeFile(release, '')
  }

  // A duplicate request never runs the push again: it reports the same unknown outcome.
  await writeFile(join(folder, 'index.txt'), 'changed after the kill\n')
  const replay = await rawReply(profile, request)
  expect(replay.type).toBe('error')
  expect(replay.message).toContain('outcome is unknown')
  const pushes = (await processTable()).filter((row) => row.ppid === profile.hello.pid && / push /.test(row.command))
  expect(pushes).toEqual([])
})

test('a daemon killed during a push settles the publish as unknown after restart', async ({ ade, profile, repo }) => {
  const remote = await emptyBare(ade, repo, 'crashed')
  const { started, release } = await holdPushes(ade, remote.path)
  const folder = await plainFolder(ade, 'crashed-push')
  const request = { op: 'repository.publish', operation_id: 'publish-crashed', path: folder, url: remote.url,
    create_initial_commit: true }

  const pending = rawReply(profile, request, 60_000).catch((error: unknown) => error)
  try {
    await expect.poll(() => exists(started), { timeout: 20_000 }).toBe(true)
    await profile.killDaemon()
    expect(await pending).toBeInstanceOf(Error)
  } finally {
    await writeFile(release, '')
  }
  await profile.restartDaemon()

  // The receipt was left in its pushing phase: replay reconciles it as unknown and does not push again.
  const replay = await rawReply(profile, request)
  expect(replay.type, JSON.stringify(replay)).toBe('error')
  expect(replay.message).toContain('outcome is unknown')
  const second = await rawReply(profile, request)
  expect(second.message).toBe(replay.message)
})

// An unknown outcome is typed: the frame carries `code: outcome_unknown`, so
// the SDK and CLI report it (exit 9) apart from a failure without parsing text.
test('an unknown publish outcome carries the typed outcome_unknown code', async ({ ade, profile, repo }) => {
  const remote = await emptyBare(ade, repo, 'typed')
  const { started, release } = await holdPushes(ade, remote.path)
  const folder = await plainFolder(ade, 'typed-push')
  const request = { op: 'repository.publish', operation_id: 'publish-typed', path: folder, url: remote.url,
    create_initial_commit: true }
  const pending = rawReply(profile, request, 60_000).catch((error: unknown) => error)
  try {
    await expect.poll(() => exists(started), { timeout: 20_000 }).toBe(true)
    await profile.killDaemon()
    await pending
  } finally {
    await writeFile(release, '')
  }
  await profile.restartDaemon()
  expect(await rawReply(profile, request)).toMatchObject({ type: 'error', code: 'outcome_unknown' })
  const cli = await profile.cli('request', 'repository.publish', JSON.stringify({ operation_id: 'publish-typed',
    path: folder, url: remote.url, create_initial_commit: true }))
  expect(cli.json).toMatchObject({ code: 'outcome_unknown' })
  expect(cli.code).toBe(9)
  const sdk = await profile.call('repository.publish', { operation_id: 'publish-typed', path: folder, url: remote.url,
    create_initial_commit: true }).catch((error: unknown) => error as { code?: string; recovery?: string })
  expect(sdk).toMatchObject({ code: 'outcome_unknown', recovery: 'inspect_before_retry' })
})
