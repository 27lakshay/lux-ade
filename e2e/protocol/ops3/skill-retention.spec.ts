// F138 retention for skill bundle files. `skill.remove` and a replacing
// `skill.install` drop only the catalog row; the bundle files they leave
// unreferenced are retention candidates under the preview's generation.
// `retention.apply` removes exactly those, never files an installed skill
// references, and never anything on disk: external and placed skills are
// references to provider paths, not files ADE owns.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { treeSnapshot } from '../fixtures/tree'

let operation = 0
const nextOperation = (label: string) => `e2e-skill-retention-${label}-${process.pid}-${++operation}`

async function writeSkill(
  directory: string,
  name: string,
  body: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const files = { 'SKILL.md': `---\nname: ${name}\ndescription: Retention fixture.\n---\n\n${body}\n`, ...extra }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), content)
  }
}

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

async function install(
  profile: ScratchProfile,
  source: string,
  replace?: string,
): Promise<{ hash: string; bytes: number }> {
  const reply = await call(profile, 'skill.install', {
    operation_id: nextOperation('install'),
    source_path: source,
    ...(replace ? { replace_content_hash: replace } : {}),
  })
  return { hash: reply.skill.content_hash, bytes: reply.skill.total_bytes }
}

async function remove(profile: ScratchProfile, name: string, hash: string): Promise<any> {
  return call(profile, 'skill.remove', { operation_id: nextOperation('remove'), name, expected_content_hash: hash })
}

async function preview(profile: ScratchProfile) {
  return profile.call('retention.preview', {})
}

async function apply(profile: ScratchProfile, generation: string) {
  return profile.call('retention.apply', { generation })
}

type Preview = Awaited<ReturnType<typeof preview>>

function skillBlobs(reply: Preview): string[] {
  return reply.candidates
    .filter((candidate) => candidate.kind === 'skill_blob')
    .map((candidate) => candidate.id)
    .sort()
}

test('uninstalled and replaced bundle files are previewed by generation, and apply removes exactly those', async ({
  ade,
  profile,
}) => {
  const home = profile.home

  // Installed and kept: never a candidate.
  const keepSource = join(ade.root, 'sources', 'keep')
  await writeSkill(keepSource, 'keep', 'Stays installed.', { 'notes/extra.md': 'kept bytes\n' })
  const keep = await install(profile, keepSource)

  // Replaced once: the first version's files lose their last reference.
  const notesSource = join(ade.root, 'sources', 'notes')
  await writeSkill(notesSource, 'notes', 'First version.')
  const notesV1 = await install(profile, notesSource)
  await writeSkill(notesSource, 'notes', 'Second version, a little longer.')
  const notesV2 = await install(profile, notesSource, notesV1.hash)

  // Installed, placed into Claude's global root, then uninstalled: the
  // placed copy is released and stays on disk; the catalog files are orphaned.
  const goneSource = join(ade.root, 'sources', 'gone')
  await writeSkill(goneSource, 'gone', 'Uninstalled.', { 'scripts/run.sh': '#!/bin/sh\necho gone\n' })
  const gone = await install(profile, goneSource)
  const placed = await call(profile, 'skill.place', {
    operation_id: nextOperation('place'),
    name: 'gone',
    expected_content_hash: gone.hash,
    provider: 'claude',
    scope: 'global',
  })
  expect(placed).toMatchObject({ outcome: 'created', path: join(home, '.claude/skills/gone') })

  // An external skill adopted and then released, and one only discovered.
  await writeSkill(join(home, '.claude/skills/pdf'), 'pdf', 'Reads PDFs.', { 'reference.md': 'external bytes\n' })
  await writeSkill(join(home, '.codex/skills/lint'), 'lint', 'Lints code.')
  const discovered = await call(profile, 'skill.discover', {})
  const pdf = discovered.references.find(
    (reference: any) => reference.provider === 'claude' && reference.entry === 'pdf',
  )
  expect(
    discovered.references.some((reference: any) => reference.provider === 'codex' && reference.entry === 'lint'),
  ).toBe(true)
  const adopted = await call(profile, 'skill.adopt', {
    operation_id: nextOperation('adopt'),
    path: pdf.path,
    expected_content_hash: pdf.content_hash,
  })
  const pdfBytes: number = adopted.skill.total_bytes

  const released = await remove(profile, 'gone', gone.hash)
  expect(released.released_paths).toEqual([placed.path])
  expect((await remove(profile, 'pdf', pdf.content_hash)).released_paths).toEqual([pdf.path])
  expect((await call(profile, 'skill.list', {})).skills.map((skill: any) => skill.name).sort()).toEqual([
    'keep',
    'notes',
  ])

  const external = {
    claude: await treeSnapshot(join(home, '.claude')),
    codex: await treeSnapshot(join(home, '.codex')),
    pdf: await readFile(join(pdf.path, 'reference.md'), 'utf8'),
    placed: await readFile(join(placed.path, 'scripts/run.sh'), 'utf8'),
  }

  // The preview lists exactly the three orphaned bundles, each with its size.
  const planned = await preview(profile)
  expect(planned.withheld).toEqual([])
  expect(skillBlobs(planned)).toEqual([notesV1.hash, gone.hash, pdf.content_hash].sort())
  expect(planned.candidates.every((candidate) => candidate.kind === 'skill_blob')).toBe(true)
  const sizes = Object.fromEntries(planned.candidates.map((candidate) => [candidate.id, candidate.bytes]))
  expect(sizes).toEqual({ [notesV1.hash]: notesV1.bytes, [gone.hash]: gone.bytes, [pdf.content_hash]: pdfBytes })
  for (const candidate of planned.candidates) {
    expect(candidate).toMatchObject({ scope: null, reason: 'no installed skill references it' })
    // When the files lost their last reference.
    expect(candidate.last_activity_at).toBeGreaterThan(0)
    expect(candidate.bytes).toBeGreaterThan(0)
  }
  expect(skillBlobs(planned)).not.toContain(keep.hash)
  expect(skillBlobs(planned)).not.toContain(notesV2.hash)
  expect(planned.reclaimable_bytes).toBe(notesV1.bytes + gone.bytes + pdfBytes)

  // The name is stable while nothing changes, and the CLI sees the same set.
  expect((await preview(profile)).generation).toBe(planned.generation)
  const cli = await profile.cli('retention', 'preview')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'retention_preview', generation: planned.generation })

  const applied = await apply(profile, planned.generation)
  expect(applied).toMatchObject({
    generation: planned.generation,
    replayed: false,
    complete: true,
    removed_bytes: planned.reclaimable_bytes,
  })
  expect(applied.results.map((result) => [result.kind, result.id, result.outcome, result.bytes]).sort()).toEqual(
    planned.candidates.map((candidate) => [candidate.kind, candidate.id, 'removed', candidate.bytes]).sort(),
  )

  // The orphaned files are gone; the installed bundles still verify in full.
  const after = await preview(profile)
  expect(after.candidates).toEqual([])
  const kept = await call(profile, 'skill.inspect', { name: 'keep' })
  expect(kept.manifest.content_hash).toBe(keep.hash)
  expect(kept.manifest.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'notes/extra.md'])
  expect((await call(profile, 'skill.inspect', { name: 'notes' })).manifest.content_hash).toBe(notesV2.hash)

  // External, adopted-then-released and placed files were never touched.
  expect(await treeSnapshot(join(home, '.claude'))).toEqual(external.claude)
  expect(await treeSnapshot(join(home, '.codex'))).toEqual(external.codex)
  expect(await readFile(join(pdf.path, 'reference.md'), 'utf8')).toBe(external.pdf)
  expect(await readFile(join(placed.path, 'scripts/run.sh'), 'utf8')).toBe(external.placed)

  // A repeat after a daemon crash replays and removes nothing more.
  await profile.restartDaemon('kill')
  expect(await apply(profile, planned.generation)).toEqual({ ...applied, replayed: true })

  // A removed bundle installs again from its source, complete.
  expect((await install(profile, goneSource)).hash).toBe(gone.hash)
  const reinstalled = await call(profile, 'skill.inspect', { name: 'gone' })
  expect(reinstalled.manifest.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
  expect((await preview(profile)).candidates).toEqual([])
})

test('a racing install or removal after the preview is protected: the stale generation is refused and nothing is removed', async ({
  ade,
  profile,
}) => {
  const source = join(ade.root, 'sources', 'race')
  await writeSkill(source, 'race', 'Races retention.', { 'data/table.csv': 'a,b\n1,2\n' })
  const race = await install(profile, source)
  await remove(profile, 'race', race.hash)

  // Reinstalling the same content after the preview references the files again.
  const stale = await preview(profile)
  expect(skillBlobs(stale)).toEqual([race.hash])
  expect((await install(profile, source)).hash).toBe(race.hash)
  await expect(apply(profile, stale.generation)).rejects.toThrow(/changed since the preview; preview again/)
  const inspected = await call(profile, 'skill.inspect', { name: 'race' })
  expect(inspected.manifest.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'data/table.csv'])
  expect(skillBlobs(await preview(profile))).toEqual([])

  // A removal after the preview adds a candidate the caller did not see.
  const otherSource = join(ade.root, 'sources', 'other')
  await writeSkill(otherSource, 'other', 'Removed late.')
  const other = await install(profile, otherSource)
  const before = await preview(profile)
  expect(skillBlobs(before)).toEqual([])
  await remove(profile, 'other', other.hash)
  await expect(apply(profile, before.generation)).rejects.toThrow(/preview again/)
  const now = await preview(profile)
  expect(skillBlobs(now)).toEqual([other.hash])
  expect(now.candidates.find((candidate) => candidate.id === other.hash)!.bytes).toBe(other.bytes)

  // An install racing the apply itself: whichever lands first, the installed
  // bundle stays complete and the apply never removes files it references.
  // Each release is a new item: the same content orphaned again never
  // reproduces an earlier generation, so an apply never replays a stale result.
  const generations = new Set<string>()
  for (let round = 0; round < 4; round++) {
    await remove(profile, 'race', race.hash)
    const planned = await preview(profile)
    expect(skillBlobs(planned)).toContain(race.hash)
    expect(generations.has(planned.generation)).toBe(false)
    generations.add(planned.generation)
    const [applied, installed] = await Promise.allSettled([
      apply(profile, planned.generation),
      install(profile, source),
    ])
    expect(installed.status).toBe('fulfilled')
    if (applied.status === 'fulfilled') {
      // The apply ran first: it removed the files, and the install wrote them again.
      expect(applied.value).toMatchObject({ complete: true, replayed: false })
      expect(applied.value.results.map((result) => result.id).sort()).toEqual(skillBlobs(planned))
    } else {
      expect(String(applied.reason)).toMatch(/preview again/)
      // The install ran first; the refused apply removed nothing else either.
      expect(skillBlobs(await preview(profile))).toEqual(skillBlobs(planned).filter((hash) => hash !== race.hash))
    }
    const current = await call(profile, 'skill.inspect', { name: 'race' })
    expect(current.manifest.content_hash).toBe(race.hash)
    expect(current.manifest.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'data/table.csv'])
    expect(skillBlobs(await preview(profile))).not.toContain(race.hash)
  }
})
