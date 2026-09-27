// R014 and F050: a damaged, incomplete or unsupported bundle is refused by
// inspect and by restore, and restore leaves no target and no stage behind.
import { appendFile, access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures'
import { control } from '../fixtures/control'
import { copyBundle, createBackup, readManifest, rewriteDatabase, seed, stages, type Manifest } from './helpers'

type Damage = { name: string; message: RegExp; damage: (bundle: string) => Promise<void> }

async function editManifest(bundle: string, change: (manifest: Manifest) => void): Promise<void> {
  const manifest = await readManifest(bundle)
  change(manifest)
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
}

async function artifactFile(bundle: string, suffix: string): Promise<string> {
  const manifest = await readManifest(bundle)
  const entry = manifest.entries.find((candidate) => candidate.path === 'sessions.plugins/artifacts')!
  return join(bundle, 'sessions.plugins/artifacts', entry.files!.find((file) => file.path.endsWith(suffix))!.path)
}

function sql(statements: string): (db: DatabaseSync) => void {
  return (db) => db.exec(statements)
}

const damages: Damage[] = [
  {
    name: 'a flipped byte in the profile database',
    message: /Backup file failed verification: sessions\.sqlite/,
    damage: async (bundle) => {
      const path = join(bundle, 'sessions.sqlite')
      const bytes = await readFile(path)
      bytes[bytes.length - 1] ^= 0xff
      await writeFile(path, bytes)
    },
  },
  {
    name: 'an unknown format',
    message: /Unsupported backend backup format or scope/,
    damage: (bundle) =>
      editManifest(bundle, (manifest) => {
        manifest.format_version = 99
      }),
  },
  {
    name: 'a manifest that is not JSON',
    message: /./,
    damage: (bundle) => writeFile(join(bundle, 'manifest.json'), '{"format_version":'),
  },
  {
    name: 'no manifest, as an interrupted stage has',
    message: /./,
    damage: (bundle) => rm(join(bundle, 'manifest.json')),
  },
  {
    name: 'coverage that claims an excluded store',
    message: /Backup coverage does not match this format/,
    damage: (bundle) =>
      editManifest(bundle, (manifest) => {
        manifest.coverage.find((item) => item.store === 'host-resources.sqlite3')!.disposition = 'backed_up'
      }),
  },
  {
    name: 'an entry outside the known stores',
    message: /Unknown backup path/,
    damage: (bundle) =>
      editManifest(bundle, (manifest) => {
        manifest.entries[0].path = '../sessions.sqlite'
      }),
  },
  {
    name: 'a plugin registry without its artifacts',
    message: /only half of the plugin registry/,
    damage: (bundle) =>
      editManifest(bundle, (manifest) => {
        manifest.entries = manifest.entries.filter((entry) => entry.path !== 'sessions.plugins/artifacts')
      }),
  },
  {
    name: 'a changed plugin artifact file',
    message: /Backup file failed verification/,
    damage: async (bundle) => appendFile(await artifactFile(bundle, 'dist/ui.js'), '// changed\n'),
  },
  {
    name: 'an extra file in the plugin artifacts',
    message: /does not match its manifest/,
    damage: async (bundle) => writeFile(join(await artifactFile(bundle, 'dist/ui.js'), '..', 'extra.js'), ''),
  },
  {
    name: 'a future profile schema',
    message: /Unsupported sessions\.sqlite schema version 99/,
    damage: (bundle) => rewriteDatabase(bundle, sql('PRAGMA user_version=99;')),
  },
  {
    name: 'a profile schema from before the execution fence',
    message: /Restore requires a schema-12 backup/,
    damage: (bundle) => rewriteDatabase(bundle, sql('PRAGMA user_version=11;')),
  },
  {
    name: 'an incomplete attachment payload',
    message: /Attachment payload is incomplete/,
    damage: (bundle) =>
      rewriteDatabase(bundle, sql("UPDATE attachments SET data=substr(data,1,8) WHERE state='live';")),
  },
  {
    name: 'a damaged skill blob',
    message: /Skill backup-notes blob/,
    damage: (bundle) => rewriteDatabase(bundle, sql("UPDATE skill_blobs SET data=CAST(X'00' || data AS BLOB);")),
  },
]

test('refuses every damaged or unsupported bundle before it creates a restore target', async ({ ade, profile }) => {
  test.setTimeout(120_000)
  await seed(ade, profile)
  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  const intact = await control(ade, ['backup', 'inspect', '--backup', bundle])
  expect(intact.code, intact.stderr).toBe(0)

  const parent = join(ade.root, 'targets')
  await mkdir(parent)
  for (const [index, { name, message, damage }] of damages.entries()) {
    await test.step(name, async () => {
      const damaged = await copyBundle(bundle, join(ade.root, 'damaged', String(index)))
      await damage(damaged)
      const inspected = await control(ade, ['backup', 'inspect', '--backup', damaged])
      expect(inspected.code, name).not.toBe(0)
      expect(inspected.json?.type).toBe('error')
      expect(String(inspected.json?.message)).toMatch(message)
      const target = join(parent, `t${index}`)
      const restored = await control(ade, ['backup', 'restore', '--backup', damaged, '--data-dir', target])
      expect(restored.code, name).not.toBe(0)
      expect(String(restored.json?.message)).toMatch(message)
      await expect(access(target)).rejects.toThrow()
      expect(await readdir(parent)).toEqual([])
    })
  }

  // An existing target is never replaced, whatever it holds.
  const occupied = join(parent, 'occupied')
  await mkdir(occupied)
  await writeFile(join(occupied, 'sentinel'), 'keep')
  const refused = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', occupied])
  expect(refused.code).not.toBe(0)
  expect(String(refused.json?.message)).toContain('Restore target already exists')
  expect(await readdir(occupied)).toEqual(['sentinel'])
  expect(await stages(parent)).toEqual([])
})
