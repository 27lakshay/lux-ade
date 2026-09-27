// F078 under D08: repositories whose remotes use different hosts and URL
// forms are cloned, fetched, pulled and pushed through ordinary Git only.
// Hosts are stand-ins on this machine: an HTTPS forge URL reaches its bare
// repository through Git's own `url.insteadOf`, and SSH and scp-like URLs
// through a `core.sshCommand` that serves `git upload-pack`/`receive-pack`.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { bareRemote, forgeSsh, profileGitConfig, remoteHead } from '../fixtures/git-remotes'
import { git, operationId, status } from './steps'

type Forge = {
  name: string
  transport: 'https' | 'ssh' | 'scp_like' | 'file'
  /** The URL a person would paste, and the bare repository behind it. */
  url: (root: string) => string
  bare: (root: string) => string
  ssh: boolean
}

const forges: Forge[] = [
  {
    name: 'an HTTPS forge',
    transport: 'https',
    ssh: false,
    url: () => 'https://github.example/acme/app.git',
    bare: (root) => join(root, 'forges', 'github.example', 'acme', 'app.git'),
  },
  {
    name: 'an SSH URL on a nested-group forge',
    transport: 'ssh',
    ssh: true,
    url: () => 'ssh://git@gitlab.example/group/sub/app.git',
    bare: (root) => join(root, 'forges', 'gitlab.example', 'group', 'sub', 'app.git'),
  },
  {
    name: 'an scp-like URL on a self-hosted server',
    transport: 'scp_like',
    ssh: true,
    url: () => 'git@git.internal.example:team/app.git',
    bare: (root) => join(root, 'forges', 'git.internal.example', 'team', 'app.git'),
  },
  {
    name: 'a file URL on this machine',
    transport: 'file',
    ssh: false,
    url: (root) => `file://${join(root, 'forges', 'local', 'app.git')}`,
    bare: (root) => join(root, 'forges', 'local', 'app.git'),
  },
]

async function forgeProfile(ade: { root: string; profile(): Promise<ScratchProfile> }) {
  const profile = await ade.profile()
  const ssh = await forgeSsh(join(ade.root, 'ssh-bin'), join(ade.root, 'forges'))
  await profileGitConfig(
    profile,
    [
      '[core]',
      `\tsshCommand = ${ssh.command}`,
      `[url "file://${join(ade.root, 'forges', 'github.example')}/"]`,
      '\tinsteadOf = https://github.example/',
    ].join('\n'),
  )
  return { profile, ssh }
}

/** Commit on another clone of the bare repository and push it, as a teammate would. */
async function teammatePush(seed: ScratchRepo, bare: string, dir: string, file: string): Promise<string> {
  if (!existsSync(dir)) {
    await seed.git('clone', '--quiet', bare, dir)
    await seed.git('-C', dir, 'config', 'user.name', 'Teammate')
    await seed.git('-C', dir, 'config', 'user.email', 'teammate@example.invalid')
  }
  await seed.git('-C', dir, 'pull', '--quiet', '--ff-only')
  await writeFile(join(dir, file), `${file}\n`)
  await seed.git('-C', dir, 'add', file)
  await seed.git('-C', dir, 'commit', '--quiet', '-m', `Teammate adds ${file}`)
  await seed.git('-C', dir, 'push', '--quiet', 'origin', 'HEAD:main')
  return seed.git('-C', dir, 'rev-parse', 'HEAD')
}

test('the coverage declaration names the ordinary Git transports and calls no forge API', async ({ profile }) => {
  const coverage = await profile.call('repository.coverage', {})
  const supported = Object.fromEntries(coverage.transports.map((row) => [row.transport, row.supported]))
  expect(supported).toEqual({
    https: true,
    ssh: true,
    scp_like: true,
    file: true,
    http: false,
    git_daemon: false,
    remote_helper: false,
    local_path: false,
  })
  expect(coverage.forge_apis).toBe(false)
  expect(coverage.credentials).toMatch(/credential helpers, SSH agent and keys.*never prompts/)
  expect(coverage.excluded).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/Pull or merge request management and issue integration/),
      expect.stringMatching(/Force push/),
    ]),
  )
  for (const form of forges) expect(supported[form.transport], form.transport).toBe(true)
  const cli = await profile.cli('repository', 'coverage')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ forge_apis: false })
})

for (const forge of forges) {
  test(`clone, commit, push, fetch and pull work for ${forge.name} through ordinary Git`, async ({ ade }) => {
    const { profile, ssh } = await forgeProfile(ade)
    const seed = await ade.repo({ name: 'seed', initialFiles: { 'README.md': `# ${forge.name}\n` } })
    const bare = await bareRemote(seed, forge.bare(ade.root), {})
    const url = forge.url(ade.root)

    const destination = join(ade.root, 'clones', 'app')
    await mkdir(join(ade.root, 'clones'), { recursive: true })
    const cloned = await profile.call('repository.clone', { operation_id: operationId('clone'), url, destination })
    expect(cloned).toMatchObject({ outcome: 'registered', url, head: await seed.head(), branch: 'main' })
    const workspace_id = cloned.workspace!.id
    // ADE keeps the URL the person gave; Git resolves it.
    expect(await seed.git('-C', cloned.destination, 'remote', 'get-url', 'origin')).toBe(url)

    // Commit through ADE and push to the forge.
    await writeFile(join(cloned.destination, 'feature.txt'), 'feature\n')
    let state = await status(profile, workspace_id)
    expect(
      await git(profile, 'review.stage', { workspace_id, path: 'feature.txt', revision: state.revision }),
    ).toMatchObject({ status: 'succeeded' })
    state = await status(profile, workspace_id)
    const commit = await git(profile, 'review.commit', {
      workspace_id,
      message: 'Add feature',
      index_token: state.index_token,
    })
    const pushed = await git(profile, 'review.push', {
      workspace_id,
      index_token: (await status(profile, workspace_id)).index_token,
    })
    expect(pushed).toMatchObject({
      status: 'succeeded',
      result: { remote: 'origin', remote_ref: 'refs/heads/main', verified: true },
    })
    expect(await remoteHead(seed, bare)).toBe(commit.result!.head)

    // A teammate pushes; fetch and pull bring it in.
    const theirs = await teammatePush(seed, bare, join(ade.root, 'teammate'), 'teammate.txt')
    expect(await git(profile, 'review.fetch', { workspace_id })).toMatchObject({
      status: 'succeeded',
      result: { remote: 'origin', updated: ['refs/remotes/origin/main'] },
    })
    expect(
      await git(profile, 'review.pull', {
        workspace_id,
        index_token: (await status(profile, workspace_id)).index_token,
      }),
    ).toMatchObject({ status: 'succeeded', result: { head: theirs, fast_forward: true } })
    expect(existsSync(join(cloned.destination, 'teammate.txt'))).toBe(true)

    // SSH forms really went over the SSH command, for both directions.
    const calls = (await ssh.calls()).filter((call) => call.exit === undefined)
    if (forge.ssh) {
      const host = forge.bare(ade.root).split('/forges/')[1].split('/')[0]
      expect(calls.filter((call) => call.host === host).map((call) => call.program)).toEqual(
        expect.arrayContaining(['git-upload-pack', 'git-receive-pack']),
      )
    } else {
      expect(calls).toEqual([])
    }
  })
}

test("refused transports never reach Git, and a disabled or unauthorised remote fails with Git's message", async ({
  ade,
}) => {
  const { profile } = await forgeProfile(ade)
  const seed = await ade.repo({ name: 'seed' })
  const bare = await bareRemote(seed, join(ade.root, 'forges', 'local', 'app.git'), {})
  const marker = join(ade.root, 'ext-ran')
  await mkdir(join(ade.root, 'clones'), { recursive: true })

  for (const [url, pattern] of [
    ['http://github.example/acme/app.git', /Unencrypted http/],
    ['git://github.example/acme/app.git', /unauthenticated git/],
    ['ext::false', /remote helpers/],
    [bare, /Local paths are not accepted/],
    ['https://user:secret@github.example/acme/app.git', /contains a password/],
  ] as const) {
    const destination = join(ade.root, 'clones', `refused-${Math.random().toString(16).slice(2)}`)
    await expect(
      profile.call('repository.clone', { operation_id: operationId('clone'), url, destination }),
      url,
    ).rejects.toThrow(pattern)
    expect(existsSync(destination), url).toBe(false)
  }

  // Fetch runs with remote helpers disabled even when a repository names one.
  const repo = await ade.repo({ name: 'work' })
  await repo.git('remote', 'add', 'helper', `ext::sh -c touch% ${marker}`)
  await repo.git('remote', 'add', 'stranger', 'git@unknown.example:team/app.git')
  await repo.git('remote', 'add', 'origin', `file://${bare}`)
  const workspace_id = (await profile.call('workspace.open', { path: repo.path })).workspace.id
  const helper = await git(profile, 'review.fetch', { workspace_id, remote: 'helper' })
  expect(helper).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/git fetch failed: .*(not allowed|ext)/i),
  })
  expect(existsSync(marker)).toBe(false)
  // An SSH host that refuses the key fails; nothing prompts or hangs.
  const refused = await git(profile, 'review.fetch', { workspace_id, remote: 'stranger' })
  expect(refused).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/Permission denied \(publickey\)|Could not read from remote/),
  })
  expect(await git(profile, 'review.fetch', { workspace_id, remote: 'origin' })).toMatchObject({ status: 'succeeded' })
})
