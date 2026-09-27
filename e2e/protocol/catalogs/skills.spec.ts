// F132: the profile skill catalog. Complete bundles are installed with a
// pinned content hash and a receipt; provider-owned skill directories are
// discovered and adopted without the daemon writing, moving or deleting them.
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { treeSnapshot } from '../fixtures/tree'

let operation = 0
const nextOperation = (label: string) => `e2e-skill-${label}-${process.pid}-${++operation}`

async function writeSkill(directory: string, name: string, description: string,
  extra: Record<string, string> = {}): Promise<void> {
  const files = { 'SKILL.md': `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse carefully.\n`, ...extra }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), content)
  }
}

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

test('installs a pinned bundle once, replays it by operation ID, and replaces it only under the installed hash', async ({ ade, profile }) => {
  const source = join(ade.root, 'sources', 'release-notes')
  await writeSkill(source, 'release-notes', 'Drafts release notes.', { 'templates/entry.md': '- {{change}}\n', '.git/HEAD': 'ref: x\n' })

  const installId = nextOperation('install')
  const first = await call(profile, 'skill.install', { operation_id: installId, source_path: source })
  expect(first.changed).toBe(true)
  const hash: string = first.skill.content_hash
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(first.skill).toMatchObject({ name: 'release-notes', description: 'Drafts release notes.', file_count: 2,
    provenance: { kind: 'local_directory', source_path: source, pinned_content_hash: hash, excluded: ['.git'] } })

  // The same operation ID replays the stored result, even after a daemon crash.
  await profile.restartDaemon('kill')
  const replay = await call(profile, 'skill.install', { operation_id: installId, source_path: source })
  expect(replay).toEqual(first)
  // Reusing the operation ID for other parameters is a conflict.
  await expect(call(profile, 'skill.install', { operation_id: installId, source_path: source, expected_content_hash: hash }))
    .rejects.toThrow(/already used for different parameters/)
  // A new operation for identical content changes nothing.
  const unchanged = await call(profile, 'skill.install', { operation_id: nextOperation('same'), source_path: source, expected_content_hash: hash })
  expect(unchanged).toMatchObject({ changed: false, replaced_content_hash: null })

  // The pin refuses a source that changed after it was reviewed.
  await writeFile(join(source, 'templates/entry.md'), '- {{change}} ({{author}})\n')
  await expect(call(profile, 'skill.install', { operation_id: nextOperation('pin'), source_path: source, expected_content_hash: hash }))
    .rejects.toThrow(/not the pinned/)
  // A different bundle of the same name is not replaced silently.
  await expect(call(profile, 'skill.install', { operation_id: nextOperation('clobber'), source_path: source }))
    .rejects.toThrow(/pass its hash to replace it/)
  const replaced = await call(profile, 'skill.install', { operation_id: nextOperation('replace'), source_path: source, replace_content_hash: hash })
  expect(replaced).toMatchObject({ changed: true, replaced_content_hash: hash })
  const newHash: string = replaced.skill.content_hash
  expect(newHash).not.toBe(hash)

  // The catalog holds the complete bundle: it stays inspectable with the source gone.
  await rm(source, { recursive: true, force: true })
  const inspected = await call(profile, 'skill.inspect', { name: 'release-notes' })
  expect(inspected.manifest.content_hash).toBe(newHash)
  expect(inspected.manifest.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'templates/entry.md'])
  expect(inspected.projection.map((entry: any) => entry.provider)).toEqual(expect.arrayContaining(['claude', 'codex']))
  for (const entry of inspected.projection) expect(entry).toMatchObject({ observed: 'absent', decision: 'create' })

  await expect(call(profile, 'skill.remove', { operation_id: nextOperation('stale-remove'), name: 'release-notes', expected_content_hash: hash }))
    .rejects.toThrow()
  const removed = await call(profile, 'skill.remove', { operation_id: nextOperation('remove'), name: 'release-notes', expected_content_hash: newHash })
  expect(removed).toMatchObject({ name: 'release-notes', content_hash: newHash, released_paths: [] })
  expect((await call(profile, 'skill.list', {})).skills).toEqual([])
})

test('concurrent duplicate requests: one operation ID applies once and racing adoptions own a path once', async ({ ade, profile }) => {
  const source = join(ade.root, 'sources', 'racer')
  await writeSkill(source, 'racer', 'Runs in parallel.')
  const installId = nextOperation('race')
  const installs = await Promise.all(Array.from({ length: 6 }, () =>
    call(profile, 'skill.install', { operation_id: installId, source_path: source })))
  for (const reply of installs) expect(reply).toEqual(installs[0])
  expect(installs[0].changed).toBe(true)

  const path = join(profile.home, '.claude/skills/shared')
  await writeSkill(path, 'shared', 'Adopted twice.')
  const reference = (await call(profile, 'skill.discover', {})).references.find((entry: any) => entry.entry === 'shared')
  const adoptions = await Promise.allSettled(Array.from({ length: 4 }, () => call(profile, 'skill.adopt',
    { operation_id: nextOperation('adopt-race'), path, expected_content_hash: reference.content_hash })))
  expect(adoptions.filter((outcome) => outcome.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
  const listed = await call(profile, 'skill.list', {})
  const shared = listed.skills.filter((skill: any) => skill.name === 'shared')
  expect(shared).toHaveLength(1)
  expect(shared[0].adopted_paths).toEqual([path])
})

test('refuses bundles that are incomplete or misnamed', async ({ ade, profile }) => {
  const missing = join(ade.root, 'sources', 'no-skill-file')
  await mkdir(missing, { recursive: true })
  await writeFile(join(missing, 'README.md'), 'no SKILL.md here\n')
  await expect(call(profile, 'skill.install', { operation_id: nextOperation('missing'), source_path: missing })).rejects.toThrow()

  const misnamed = join(ade.root, 'sources', 'folder-name')
  await writeSkill(misnamed, 'other-name', 'Named differently.')
  await expect(call(profile, 'skill.install', { operation_id: nextOperation('misnamed'), source_path: misnamed }))
    .rejects.toThrow(/does not match its directory/)

  await expect(call(profile, 'skill.install', { operation_id: nextOperation('relative'), source_path: 'relative/path' }))
    .rejects.toThrow(/absolute path/)
  expect((await call(profile, 'skill.list', {})).skills).toEqual([])
})

test('discovers, adopts and releases provider skills without touching their files', async ({ profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const home = profile.home
  await writeSkill(join(home, '.claude/skills/pdf'), 'pdf', 'Reads PDFs.', { 'scripts/extract.sh': '#!/bin/sh\necho pdf\n' })
  await writeSkill(join(home, '.agents/skills/lint'), 'lint', 'Runs the linter.')
  await mkdir(join(home, '.claude/skills/broken'), { recursive: true })
  await writeFile(join(home, '.claude/skills/broken/SKILL.md'), 'no frontmatter\n')
  await writeSkill(join(home, 'elsewhere/linked'), 'linked', 'Lives elsewhere.')
  await symlink(join(home, 'elsewhere/linked'), join(home, '.claude/skills/linked'))
  await writeSkill(join(repo.path, '.claude/skills/deploy'), 'deploy', 'Deploys this repository.')

  const before = { home: await treeSnapshot(home), repo: await treeSnapshot(join(repo.path, '.claude')) }

  const global = await call(profile, 'skill.discover', {})
  const byEntry = (discovery: any) => Object.fromEntries(discovery.references.map((reference: any) =>
    [`${reference.provider}:${reference.entry}`, reference]))
  const found = byEntry(global)
  expect(found['claude:pdf']).toMatchObject({ scope: 'global', status: 'valid', name: 'pdf', adopted_by: null,
    path: join(home, '.claude/skills/pdf') })
  expect(found['codex:lint']).toMatchObject({ status: 'valid', name: 'lint' })
  expect(found['claude:broken']).toMatchObject({ status: 'invalid' })
  expect(found['claude:linked'].symlink_target).toBeTruthy()
  expect(global.roots.find((root: any) => root.provider === 'claude' && root.scope === 'global'))
    .toMatchObject({ status: 'present' })
  expect(global.roots.some((root: any) => root.status === 'missing')).toBe(true)

  const scoped = byEntry(await call(profile, 'skill.discover', { workspace_id: workspace.id }))
  expect(scoped['claude:deploy']).toMatchObject({ scope: 'workspace', workspace_id: workspace.id, status: 'valid' })

  // Discovery is recorded: the list carries the references.
  expect((await call(profile, 'skill.list', {})).references.length).toBeGreaterThanOrEqual(3)

  // Adoption needs the hash discovery reported and a plain directory in a provider root.
  const pdf = found['claude:pdf']
  await expect(call(profile, 'skill.adopt', { operation_id: nextOperation('stale'), path: pdf.path,
    expected_content_hash: '0'.repeat(64) })).rejects.toThrow()
  await expect(call(profile, 'skill.adopt', { operation_id: nextOperation('symlink'), path: found['claude:linked'].path,
    expected_content_hash: found['claude:linked'].content_hash ?? '0'.repeat(64) })).rejects.toThrow()
  await expect(call(profile, 'skill.adopt', { operation_id: nextOperation('outside'), path: join(home, 'elsewhere/linked'),
    expected_content_hash: '0'.repeat(64) })).rejects.toThrow(/provider skill root/)

  const adopted = await call(profile, 'skill.adopt', { operation_id: nextOperation('adopt'), path: pdf.path,
    expected_content_hash: pdf.content_hash })
  expect(adopted.skill).toMatchObject({ name: 'pdf', content_hash: pdf.content_hash, adopted_paths: [pdf.path],
    provenance: { kind: 'adopted', source_path: pdf.path } })
  const inspection = await call(profile, 'skill.inspect', { name: 'pdf' })
  expect(inspection.projection.find((entry: any) => entry.path === pdf.path))
    .toMatchObject({ provider: 'claude', observed: 'adopted_unchanged' })

  const removed = await call(profile, 'skill.remove', { operation_id: nextOperation('release'), name: 'pdf',
    expected_content_hash: pdf.content_hash })
  expect(removed.released_paths).toEqual([pdf.path])

  // Nothing the providers own was written, moved or deleted.
  expect(await treeSnapshot(home)).toEqual(before.home)
  expect(await treeSnapshot(join(repo.path, '.claude'))).toEqual(before.repo)
})

test('an adopted skill edited outside ADE is reported as drifted, not rewritten', async ({ profile }) => {
  const path = join(profile.home, '.claude/skills/notes')
  await writeSkill(path, 'notes', 'Keeps notes.')
  const reference = (await call(profile, 'skill.discover', {})).references.find((entry: any) => entry.entry === 'notes')
  await call(profile, 'skill.adopt', { operation_id: nextOperation('adopt'), path, expected_content_hash: reference.content_hash })

  await writeFile(join(path, 'SKILL.md'), '---\nname: notes\ndescription: Keeps better notes.\n---\n')
  const edited = await treeSnapshot(path)
  const inspection = await call(profile, 'skill.inspect', { name: 'notes' })
  expect(inspection.projection.find((entry: any) => entry.path === path)).toMatchObject({ observed: 'adopted_drifted' })
  expect(inspection.manifest.content_hash).toBe(reference.content_hash)
  expect(await treeSnapshot(path)).toEqual(edited)
})

// F132 asks for skills invoked through adapter rules. Placement into provider
// paths and adapter invocation are not built, so no provider sees an
// installed bundle; remote installation is out of scope for v1 so far.
test.fixme('an installed bundle is placed for a provider and invoked through its adapter', async ({ ade, profile }) => {
  const source = join(ade.root, 'sources', 'greet')
  await writeSkill(source, 'greet', 'Greets.')
  await call(profile, 'skill.install', { operation_id: nextOperation('install'), source_path: source })
  const inspection = await call(profile, 'skill.inspect', { name: 'greet' })
  expect(inspection.projection.some((entry: any) => entry.observed === 'external_identical')).toBe(true)
})
