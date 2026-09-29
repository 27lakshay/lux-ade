// Backup-area helpers: seed a live profile with every store a backup covers,
// run `ade-control backup`, restore into the next scratch profile, and doctor
// a bundle the way a damaged or older one would look.
import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  expect,
  send,
  startConversation,
  turnReply,
  waitForIdle,
  waitForMessage,
  type AdeHarness,
  type CliResult,
  type ProfileOptions,
  type ScratchProfile,
} from '../fixtures'
import { control, nextProfileDataDirectory } from '../fixtures/control'

/** A 1x1 PNG. */
export const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0wwAAAABJRU5ErkJggg=='
export const pluginId = 'e2e.backup'
export const skillName = 'backup-notes'

export type Seeded = {
  workspaceId: string
  conversationId: string
  attachmentId: string
  attachmentSha: string
  skillHash: string
  accountId: string
  pluginDigest: string
}

export type Manifest = {
  format_version: number
  scope: string
  entries: Array<{
    path: string
    kind: string
    size: number
    sha256: string
    schema?: number
    files?: Array<{ path: string; size: number; sha256: string; executable: boolean }>
  }>
  excluded: string[]
  coverage: Array<{ store: string; disposition: string; reason: string }>
}

/** Write a UI-only plugin artifact with one boolean setting and an executable helper file. */
export async function writePlugin(directory: string): Promise<string> {
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(
    join(directory, 'ade-plugin.json'),
    JSON.stringify({
      manifest_version: 1,
      id: pluginId,
      name: 'Backup fixture',
      version: '1.0.0',
      api_version: 1,
      data_schema: 1,
      entry_points: { ui: 'dist/ui.js' },
      contributes: { settings: [{ key: 'wrap', title: 'Wrap', kind: 'boolean', default: false }] },
    }),
  )
  await writeFile(join(directory, 'dist/ui.js'), 'export default {}\n')
  await writeFile(join(directory, 'dist/tool.sh'), '#!/bin/sh\necho fixture\n')
  await chmod(join(directory, 'dist/tool.sh'), 0o755)
  return directory
}

/** Write a skill bundle directory named after the skill. */
export async function writeSkill(parent: string): Promise<string> {
  const directory = join(parent, skillName)
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Notes the backup E2E restores.\n---\n\nKeep notes.\n`,
  )
  await writeFile(join(directory, 'references/detail.md'), 'Detail that lives in a blob.\n')
  return directory
}

/**
 * Give `profile` a finished Codex turn, an attachment in a draft, an installed
 * and enabled plugin with a record and a setting, an installed skill and an
 * account whose native home holds a credential file.
 */
export async function seed(ade: AdeHarness, profile: ScratchProfile): Promise<Seeded> {
  const { workspaceId, conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello')
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)

  const { attachment } = await profile.call('attachment.put', {
    conversation_id: conversationId,
    request_id: 'backup-pixel',
    name: 'pixel.png',
    data: pixel,
  })
  const inspected = await profile.call('attachment.inspect', {
    conversation_id: conversationId,
    attachment_id: attachment.id,
  })
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'backup-window',
    revision: 1,
    text: 'draft with a picture',
    attachments: [attachment],
  })

  const pluginSource = await writePlugin(join(ade.root, 'sources/plugin'))
  const installed = await profile.call('plugin.install', {
    operation_id: 'backup-plugin-install',
    source: { kind: 'local', path: pluginSource },
  })
  if (installed.plugin.status !== 'enabled') await profile.call('plugin.enable', { plugin_id: pluginId })
  await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'first',
    value: { text: 'kept by backup' },
    expected_revision: 0,
  })
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'wrap', value: true })

  const skill = await profile.call('skill.install', {
    operation_id: 'backup-skill-install',
    source_path: await writeSkill(join(ade.root, 'sources/skills')),
  })

  const { account } = await profile.call('account.create', { provider: 'codex', name: 'Backup account' })
  await writeFile(join(account.native_home, 'auth.json'), '{"fixture":"credential that must stay out of backup"}')

  return {
    workspaceId,
    conversationId,
    attachmentId: attachment.id,
    attachmentSha: inspected.sha256,
    skillHash: skill.skill.content_hash,
    accountId: account.id,
    pluginDigest: installed.plugin.artifact_digest,
  }
}

export async function createBackup(
  ade: AdeHarness,
  profile: ScratchProfile,
  name = 'bundle',
  env: Record<string, string> = {},
): Promise<{ path: string; result: CliResult }> {
  const path = join(ade.root, 'backups', name)
  await mkdir(join(ade.root, 'backups'), { recursive: true })
  const result = await control(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', path], { env })
  return { path, result }
}

/** Restore `bundle` where the next scratch profile keeps its data, then start that profile. */
export async function restoreIntoNewProfile(
  ade: AdeHarness,
  bundle: string,
  options: ProfileOptions = {},
): Promise<ScratchProfile> {
  const target = await nextProfileDataDirectory(ade)
  const restored = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', target])
  expect(restored.code, restored.stderr).toBe(0)
  const profile = await ade.profile(options)
  expect(profile.dataDirectory).toBe(target)
  return profile
}

/**
 * Back `source` up and restore the bundle where the next scratch profile keeps
 * its data. `before` runs on the restored data directory before that profile
 * starts, for a spec that doctors the store or moves folders first.
 */
export async function backupAndRestore(
  ade: AdeHarness,
  source: ScratchProfile,
  options: ProfileOptions & { before?: (dataDirectory: string) => Promise<void> } = {},
): Promise<ScratchProfile> {
  const { path, result } = await createBackup(ade, source, `bundle-${randomUUID()}`)
  expect(result.code, result.stderr).toBe(0)
  const target = await nextProfileDataDirectory(ade)
  const restored = await control(ade, ['backup', 'restore', '--backup', path, '--data-dir', target])
  expect(restored.code, restored.stderr).toBe(0)
  await options.before?.(target)
  const profile = await ade.profile({ env: options.env })
  expect(profile.dataDirectory).toBe(target)
  return profile
}

export async function readManifest(bundle: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as Manifest
}

/** Copy a bundle so one variant can be damaged without touching the original. */
export async function copyBundle(bundle: string, to: string): Promise<string> {
  await cp(bundle, to, { recursive: true })
  return to
}

/** Change a bundle database (`sessions.sqlite` unless named) and record its new hash and schema in the manifest, as a well-formed bundle would. */
export async function rewriteDatabase(
  bundle: string,
  change: (db: DatabaseSync) => void,
  name = 'sessions.sqlite',
): Promise<void> {
  const path = join(bundle, name)
  const db = new DatabaseSync(path)
  try {
    change(db)
  } finally {
    db.close()
  }
  const bytes = await readFile(path)
  const check = new DatabaseSync(path, { readOnly: true })
  const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  check.close()
  const manifest = await readManifest(bundle)
  const entry = manifest.entries.find((candidate) => candidate.path === name)!
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  entry.size = bytes.length
  entry.schema = version
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
}

/** Every `.ade-stage-*` directory `ade-control` left in `parent`. */
export async function stages(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith('.ade-stage-'))
}

/** Every Codex `turn/start` the profile's mock received, as its prompt text. */
export async function codexTurns(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => String(((call.params as { input?: Array<{ text?: string }> }).input ?? [])[0]?.text))
}
