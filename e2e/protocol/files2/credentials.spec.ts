// F078 under D08: the declared coverage says HTTPS remotes authenticate
// through the user's Git credential helpers and that ADE never prompts. This
// proves that for clone, push, fetch and pull against a forge that demands
// Basic authentication, and shows a rejected or missing credential failing
// with Git's message, never prompting, and never stored by ADE.
//
// The forge serves plain HTTP on 127.0.0.1 behind its HTTPS URL (see
// git-http.ts): TLS itself is not exercised, because Git's TLS on macOS uses
// the Security framework, which E2E must never call.
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test as base, type ScratchProfile } from '../fixtures'
import { bareRemote, profileGitConfig, remoteHead } from '../fixtures/git-remotes'
import { git, operationId, status } from '../files-git/steps'
import { credentialHelper, effectiveHelpers, HttpForge, type CredentialHelper } from './git-http'

const url = 'https://forge.example/acme/app.git'
const token = `e2e-token-${process.pid}-${Date.now()}`

type Setup = { profile: ScratchProfile; forge: HttpForge; helper: CredentialHelper; secretFile: string }

const test = base.extend<{ setup: (options?: { helper?: boolean }) => Promise<Setup> }>({
  setup: async ({ ade }, use) => {
    const forges: HttpForge[] = []
    await use(async (options = {}) => {
      const profile = await ade.profile()
      const dir = join(ade.root, `forge-${forges.length}`)
      await mkdir(dir, { recursive: true })
      const forge = await HttpForge.start(join(dir, 'repos'), profile.env, { user: 'ada', password: token })
      forges.push(forge)
      const secretFile = join(dir, 'secret.json')
      await writeFile(secretFile, JSON.stringify({ user: 'ada', password: token }))
      const helper = await credentialHelper(dir, secretFile)
      await profileGitConfig(profile, [
        ...(options.helper === false ? [] : ['[credential]', `\thelper = ${helper.path}`]),
        `[url "${forge.base}"]`, '\tinsteadOf = https://forge.example/',
      ].join('\n'))
      // Machine safety gate: before anything reaches the network, the only
      // helper the daemon's Git would run is the scratch one (or none).
      expect(await effectiveHelpers(profile, ade.root)).toEqual(options.helper === false ? [] : [helper.path])
      return { profile, forge, helper, secretFile }
    })
    for (const forge of forges) await forge.stop()
  },
})

/** Every file under `dir`, read as bytes; for checking a secret never landed there. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if ((await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) found.push(path)
  }
  return found
}

test('HTTPS clone, push, fetch and pull authenticate through the credential helper and ADE stores no secret', async ({ ade, setup }) => {
  const { profile, forge, helper } = await setup()
  const seed = await ade.repo({ name: 'seed', initialFiles: { 'README.md': '# Forge app\n' } })
  const bare = await bareRemote(seed, join(forge.root, 'acme', 'app.git'), {})

  await mkdir(join(ade.root, 'clones'), { recursive: true })
  const cloned = await profile.call('repository.clone', { operation_id: operationId('clone'), url,
    destination: join(ade.root, 'clones', 'app') }, { timeoutMs: 60_000 })
  expect(cloned).toMatchObject({ outcome: 'registered', url, head: await seed.head(), branch: 'main' })
  const workspace_id = cloned.workspace!.id
  expect(await seed.git('-C', cloned.destination, 'remote', 'get-url', 'origin')).toBe(url)

  // The forge first refused the anonymous request, then served the helper's credentials.
  expect(forge.requests.some((request) => request.status === 401)).toBe(true)
  expect(forge.requests.filter((request) => request.status === 200).every((request) => request.user === 'ada')).toBe(true)
  expect(forge.requests.some((request) => request.service === 'git-upload-pack' && request.status === 200)).toBe(true)
  const afterClone = await helper.calls()
  expect(afterClone.map((call) => call.action)).toEqual(['get', 'store'])
  expect(afterClone[0]).toMatchObject({ protocol: 'http', host: `127.0.0.1:${forge.port}` })

  // Commit and push through ADE; the push authenticates the same way.
  await writeFile(join(cloned.destination, 'feature.txt'), 'feature\n')
  let state = await status(profile, workspace_id)
  expect(await git(profile, 'review.stage', { workspace_id, path: 'feature.txt', revision: state.revision })).toMatchObject({ status: 'succeeded' })
  state = await status(profile, workspace_id)
  const commit = await git(profile, 'review.commit', { workspace_id, message: 'Add feature', index_token: state.index_token })
  const pushed = await git(profile, 'review.push', { workspace_id, index_token: (await status(profile, workspace_id)).index_token })
  expect(pushed).toMatchObject({ status: 'succeeded', result: { remote: 'origin', remote_ref: 'refs/heads/main', verified: true } })
  expect(await remoteHead(seed, bare)).toBe(commit.result!.head)
  expect(forge.requests.some((request) => request.service === 'git-receive-pack' && request.status === 200
    && request.user === 'ada')).toBe(true)

  // A teammate pushes straight to the forge's repository; fetch and pull authenticate and bring it in.
  const teammate = join(ade.root, 'teammate')
  await seed.git('clone', '--quiet', bare, teammate)
  await writeFile(join(teammate, 'teammate.txt'), 'teammate\n')
  await seed.git('-C', teammate, 'add', 'teammate.txt')
  await seed.git('-C', teammate, '-c', 'user.name=Teammate', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'Teammate')
  await seed.git('-C', teammate, 'push', '--quiet', 'origin', 'HEAD:main')
  const theirs = await seed.git('-C', teammate, 'rev-parse', 'HEAD')
  expect(await git(profile, 'review.fetch', { workspace_id })).toMatchObject({ status: 'succeeded',
    result: { remote: 'origin', updated: ['refs/remotes/origin/main'] } })
  expect(await git(profile, 'review.pull', { workspace_id, index_token: (await status(profile, workspace_id)).index_token }))
    .toMatchObject({ status: 'succeeded', result: { head: theirs, fast_forward: true } })
  expect(existsSync(join(cloned.destination, 'teammate.txt'))).toBe(true)
  const calls = await helper.calls()
  expect(calls.filter((call) => call.action === 'get').length).toBeGreaterThanOrEqual(4)
  expect(calls.every((call) => call.username === undefined || call.username === 'ada')).toBe(true)

  // The token lives only with the helper: not in the clone, not in the remote URL, not in ADE's data or logs.
  expect(await filesContaining(cloned.destination, token)).toEqual([])
  expect(await filesContaining(profile.dataDirectory, token)).toEqual([])
  expect(await filesContaining(profile.logsDirectory, token)).toEqual([])
  expect(JSON.stringify(cloned)).not.toContain(token)
})

test('a rejected or missing credential fails with Git\'s message, prompts for nothing and keeps nothing', async ({ ade, setup }) => {
  const { profile, forge, helper, secretFile } = await setup()
  const seed = await ade.repo({ name: 'seed' })
  await bareRemote(seed, join(forge.root, 'acme', 'app.git'), {})
  await mkdir(join(ade.root, 'clones'), { recursive: true })
  const cloned = await profile.call('repository.clone', { operation_id: operationId('clone'), url,
    destination: join(ade.root, 'clones', 'app') }, { timeoutMs: 60_000 })
  const workspace_id = cloned.workspace!.id

  // The forge rotates the token; the helper still holds the old one.
  forge.credentials = { user: 'ada', password: `${token}-rotated` }
  const rejected = await git(profile, 'review.fetch', { workspace_id })
  expect(rejected).toMatchObject({ status: 'failed', error: expect.stringMatching(/git fetch failed: .*Authentication failed/) })
  expect(rejected.error).not.toContain(token)
  // Git told the helper to forget the rejected credential.
  expect((await helper.calls()).at(-1)).toMatchObject({ action: 'erase', username: 'ada' })

  // With the new token in the helper, the same fetch succeeds.
  await writeFile(secretFile, JSON.stringify({ user: 'ada', password: `${token}-rotated` }))
  expect(await git(profile, 'review.fetch', { workspace_id })).toMatchObject({ status: 'succeeded' })

  // A profile whose Git has no credential helper fails the clone at once instead of prompting.
  const bare = await setup({ helper: false })
  await bareRemote(seed, join(bare.forge.root, 'acme', 'app.git'), {})
  const destination = join(ade.root, 'clones', 'no-helper')
  await expect(bare.profile.call('repository.clone', { operation_id: operationId('clone'), url, destination },
    { timeoutMs: 60_000 })).rejects.toThrow(/could not read Username|terminal prompts disabled/)
  expect(existsSync(destination)).toBe(false)
  expect(bare.forge.requests.every((request) => request.status === 401)).toBe(true)
})
