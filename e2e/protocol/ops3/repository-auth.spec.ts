// F062: clone and publish go through the user's configured Git remote and
// authentication flow. ADE runs the system `git` with the profile's own Git
// configuration: here `core.sshCommand` names a scratch SSH client that serves
// `ssh://` remotes from local bare repositories and refuses one host, as a
// failed key would. ADE stores no credential, refuses a URL that carries a
// password, and reports a refused authentication as not pushed, with Git's
// reason.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type AdeHarness, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

/** A scratch SSH client, set as the profile's core.sshCommand, that logs every call. */
async function configureSsh(ade: AdeHarness, profile: ScratchProfile, repo: ScratchRepo) {
  const bin = join(ade.root, 'ssh-bin')
  await mkdir(bin, { recursive: true })
  const log = join(bin, 'calls.log')
  const client = join(bin, 'fixture-ssh')
  // Git runs `<sshCommand> [options] HOST COMMAND`; the command is the last argument.
  await writeFile(
    client,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
for last; do :; done
for arg; do case "$arg" in denied-host) echo 'Permission denied (publickey).' >&2; exit 255;; esac; done
exec /bin/sh -c "$last"
`,
  )
  await chmod(client, 0o755)
  await repo.git('config', '--file', join(profile.home, '.gitconfig'), 'core.sshCommand', client)
  return { log }
}

async function emptyBare(ade: AdeHarness, repo: ScratchRepo, name: string): Promise<string> {
  const path = join(ade.root, 'remotes', `${name}.git`)
  await mkdir(path, { recursive: true })
  await repo.git('init', '--quiet', '--bare', '--initial-branch=main', path)
  return path
}

async function plainFolder(ade: AdeHarness, name: string): Promise<string> {
  const folder = join(ade.root, 'folders', name)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'index.txt'), 'first file\n')
  return folder
}

async function branch(repo: ScratchRepo, bare: string): Promise<string> {
  return repo.git('--git-dir', bare, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main')
}

test('F062: publish and clone use the configured SSH client, and a refused key is reported as not pushed', async ({
  ade,
  profile,
  repo,
}) => {
  const { log } = await configureSsh(ade, profile, repo)
  const coverage = await profile.call('repository.coverage', {})
  expect(coverage.transports.find((entry) => entry.transport === 'ssh')?.supported).toBe(true)

  const bare = await emptyBare(ade, repo, 'over-ssh')
  const url = `ssh://fixture-host${bare}`
  const folder = await plainFolder(ade, 'ssh-publish')
  const published = await profile.call('repository.publish', {
    operation_id: 'publish-ssh',
    path: folder,
    url,
    create_initial_commit: true,
    commit_message: 'Initial import',
  })
  expect(published).toMatchObject({ outcome: 'published', pushed: true })
  expect(await branch(repo, bare)).toBe(published.commit)
  // The push went through the user's SSH client to the named host.
  expect(await readFile(log, 'utf8')).toMatch(/fixture-host .*git-receive-pack/)

  // Clone the same remote over SSH into a new project.
  const destination = join(ade.root, 'clones', 'over-ssh')
  await mkdir(join(ade.root, 'clones'), { recursive: true })
  const cloned = await profile.call('repository.clone', { operation_id: 'clone-ssh', url, destination })
  expect(cloned).toMatchObject({ outcome: 'registered', head: published.commit, branch: 'main' })
  expect(await readFile(join(destination, 'index.txt'), 'utf8')).toBe('first file\n')
  expect(await readFile(log, 'utf8')).toMatch(/fixture-host .*git-upload-pack/)

  // A host that refuses the key: the publish settles as not pushed at the
  // push step, the remote keeps nothing, and the reply says why.
  const refusedBare = await emptyBare(ade, repo, 'refused')
  const refusedFolder = await plainFolder(ade, 'ssh-refused')
  const refused = await profile.call('repository.publish', {
    operation_id: 'publish-denied',
    path: refusedFolder,
    url: `ssh://denied-host${refusedBare}`,
    create_initial_commit: true,
    commit_message: 'Initial import',
  })
  expect(refused).toMatchObject({ outcome: 'not_pushed', pushed: false, failed_step: 'push' })
  // Git's own account of the refusal is reported, so the user can fix the key.
  expect(refused.failure).toContain('Permission denied (publickey)')
  expect(await branch(repo, refusedBare)).toBe('')
  // The refusal is the recorded outcome: a replay returns it and does not try again.
  const calls = (await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('denied-host')).length
  expect(
    await profile.call('repository.publish', {
      operation_id: 'publish-denied',
      path: refusedFolder,
      url: `ssh://denied-host${refusedBare}`,
      create_initial_commit: true,
      commit_message: 'Initial import',
    }),
  ).toEqual(refused)
  expect((await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('denied-host')).length).toBe(calls)
})

test('F062: a URL carrying a password is refused before Git runs, and the password is never echoed', async ({
  ade,
  profile,
  repo: _repo,
}) => {
  const folder = await plainFolder(ade, 'with-password')
  for (const url of [
    'https://fixture-user:hunter2-secret@example.invalid/repo.git',
    'ssh://fixture-user:hunter2-secret@example.invalid/repo.git',
  ]) {
    const clone = await rawReply(profile, {
      op: 'repository.clone',
      operation_id: `clone-${url.length}`,
      url,
      destination: join(ade.root, 'clones', 'never'),
    })
    expect(clone).toMatchObject({ type: 'error', message: expect.stringContaining('credential helper') })
    expect(JSON.stringify(clone)).not.toContain('hunter2-secret')
    const publish = await rawReply(profile, {
      op: 'repository.publish',
      operation_id: `publish-${url.length}`,
      path: folder,
      url,
      create_initial_commit: true,
    })
    expect(publish.type).toBe('error')
    expect(JSON.stringify(publish)).not.toContain('hunter2-secret')
  }
  // Nothing was initialised or cloned.
  await expect(readFile(join(folder, '.git', 'HEAD'))).rejects.toThrow()
  await expect(readFile(join(ade.root, 'clones', 'never'))).rejects.toThrow()
})
