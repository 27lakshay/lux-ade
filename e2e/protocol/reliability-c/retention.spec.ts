// R015: retention never loses referenced work. Retention runs while a backup
// is taken, while uploads are being finalized and referenced, and while an
// agent turn, a terminal and a service run. It removes only the unreferenced,
// idle items of the generation it previewed. Unresolved resource claims are
// covered by e2e/protocol/ops/diagnostics.spec.ts (a quarantined service
// keeps its log).
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  cancelActiveSubmission,
  conversationStatus,
  expect,
  isRunning,
  primaryShell,
  prompts,
  type ScratchProfile,
  send,
  startConversation,
  test,
} from '../fixtures'
import { control, nextProfileDataDirectory } from '../fixtures/control'
import { configureService, nodeService, waitForReadiness, writeServicePrograms } from '../fixtures/services'
import { exists } from './steps'

const DAY_MS = 24 * 60 * 60 * 1000

function serviceLogs(profile: ScratchProfile): string {
  return join(profile.dataDirectory, 'service-logs')
}

async function logNames(profile: ScratchProfile): Promise<string[]> {
  return (await readdir(serviceLogs(profile)).catch(() => [] as string[])).sort()
}

async function age(path: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * DAY_MS)
  await utimes(path, when, when)
}

/** Record an upload as `days` old, as if it had waited that long without a reference. */
function ageUpload(profile: ScratchProfile, attachmentId: string, days: number): void {
  const db = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('UPDATE attachments SET created_at=? WHERE id=?').run(Date.now() - days * DAY_MS, attachmentId)
  } finally {
    db.close()
  }
}

let uploads = 0
async function upload(profile: ScratchProfile, conversationId: string, text: string) {
  return (
    await profile.call('attachment.put', {
      conversation_id: conversationId,
      request_id: `retention-upload-${++uploads}`,
      name: `upload-${uploads}.txt`,
      data: Buffer.from(text).toString('base64'),
    })
  ).attachment
}

async function stillThere(profile: ScratchProfile, conversationId: string, attachmentId: string): Promise<boolean> {
  return profile.call('attachment.inspect', { conversation_id: conversationId, attachment_id: attachmentId }).then(
    () => true,
    () => false,
  )
}

test('retention during a backup, upload finalization and active execution removes only unreferenced idle items', async ({
  ade,
  profile,
  repo,
}) => {
  // Active execution: a held agent turn, a terminal shell and a service with an old log.
  const held = await startConversation(profile, 'codex')
  await send(profile, held.conversationId, prompts.hold)
  await expect.poll(() => conversationStatus(profile, held.conversationId)).toBe('running')
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const shellId = await primaryShell(profile, workspace.id)
  const shell = await profile.cli('terminal', 'inspect', workspace.id, shellId)
  expect(shell.code, shell.stderr).toBe(0)
  const shellPid = (shell.json as { metrics: { shell_pid: number } }).metrics.shell_pid
  const logsBefore = new Set(await logNames(profile))
  const files = await writeServicePrograms(repo.path)
  await configureService(profile, workspace.id, 'web', nodeService(files.server))
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  let liveLogs: string[] = []
  await expect
    .poll(async () => {
      liveLogs = (await logNames(profile)).filter((name) => !logsBefore.has(name))
      return liveLogs.length
    })
    .toBeGreaterThan(0)
  for (const name of await logNames(profile)) await age(join(serviceLogs(profile), name), 10)

  // Two uploads left unreferenced for two days, and an orphaned log idle for eight.
  const idle = await startConversation(profile, 'codex', repo.path)
  const unreferenced = await upload(profile, idle.conversationId, 'never referenced\n')
  const finalized = await upload(profile, idle.conversationId, 'referenced after the preview\n')
  ageUpload(profile, unreferenced.id, 2)
  ageUpload(profile, finalized.id, 2)
  await mkdir(serviceLogs(profile), { recursive: true })
  const orphan = randomBytes(32).toString('hex')
  const orphanLog = join(serviceLogs(profile), `${orphan}.0`)
  await writeFile(orphanLog, 'orphan output\n')
  await age(orphanLog, 8)
  const planted = randomBytes(32).toString('hex')

  // Scheduled retention takes only the orphaned log. Age alone never makes an
  // upload a candidate; only an explicit reclaim frees one.
  const first = await profile.call('retention.preview', {})
  expect(first.candidates.map((candidate) => `${candidate.kind}:${candidate.id}`)).toEqual([`service_log:${orphan}`])

  // Blob finalization races an explicit reclaim: the upload is referenced by a
  // draft after its reclaim preview, so the reclaim is refused and the upload stays.
  const reclaimable = await profile.call('attachment.reclaim.preview', {
    conversation_id: idle.conversationId,
    attachment_id: finalized.id,
  })
  expect(reclaimable.preview).toMatchObject({ reclaimable: true, protected_by: [] })
  expect(reclaimable.automatic_gc_eligible).toBe(false)
  await profile.call('draft.save', {
    conversation_id: idle.conversationId,
    window_id: 'retention-window',
    revision: 1,
    text: 'draft with a file',
    attachments: [finalized],
  })
  await expect(
    profile.call('attachment.reclaim.apply', {
      conversation_id: idle.conversationId,
      attachment_id: finalized.id,
      expected_generation: reclaimable.preview.generation,
    }),
  ).rejects.toThrow()
  expect(await stillThere(profile, idle.conversationId, finalized.id)).toBe(true)
  expect(
    (
      await profile.call('attachment.reclaim.preview', {
        conversation_id: idle.conversationId,
        attachment_id: finalized.id,
      })
    ).preview,
  ).toMatchObject({ reclaimable: false, protected_by: ['draft'] })

  // A retention candidate that changes after its preview is refused as well.
  await writeFile(join(serviceLogs(profile), `${planted}.0`), 'late orphan\n')
  await age(join(serviceLogs(profile), `${planted}.0`), 8)
  await expect(profile.call('retention.apply', { generation: first.generation })).rejects.toThrow(/preview again/)
  expect(await exists(orphanLog)).toBe(true)
  const second = await profile.call('retention.preview', {})
  expect(second.candidates.map((candidate) => candidate.id).sort()).toEqual([orphan, planted].sort())

  // Retention and a reclaim run at the same time as a backup of the live
  // profile and five new uploads.
  const unreferencedPreview = await profile.call('attachment.reclaim.preview', {
    conversation_id: idle.conversationId,
    attachment_id: unreferenced.id,
  })
  const bundle = join(ade.root, 'backups', 'during-retention')
  await mkdir(join(ade.root, 'backups'), { recursive: true })
  const [applied, reclaimed, backup, fresh] = await Promise.all([
    profile.call('retention.apply', { generation: second.generation }),
    profile.call('attachment.reclaim.apply', {
      conversation_id: idle.conversationId,
      attachment_id: unreferenced.id,
      expected_generation: unreferencedPreview.preview.generation,
    }),
    control(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle]),
    Promise.all(Array.from({ length: 5 }, (_, index) => upload(profile, idle.conversationId, `in flight ${index}\n`))),
  ])
  expect(applied).toMatchObject({ complete: true, replayed: false })
  expect(applied.results.map((result) => `${result.kind}:${result.id}:${result.outcome}`).sort()).toEqual(
    [`service_log:${orphan}:removed`, `service_log:${planted}:removed`].sort(),
  )
  expect(reclaimed.attachment).toMatchObject({ state: 'discarded' })
  expect(backup.code, backup.stderr).toBe(0)

  // Exactly the previewed items are gone. Referenced and in-flight uploads,
  // live logs and every running process are intact.
  expect(await exists(orphanLog)).toBe(false)
  expect(await stillThere(profile, idle.conversationId, unreferenced.id)).toBe(false)
  expect(await stillThere(profile, idle.conversationId, finalized.id)).toBe(true)
  for (const attachment of fresh) expect(await stillThere(profile, idle.conversationId, attachment.id)).toBe(true)
  for (const name of liveLogs) expect(await exists(join(serviceLogs(profile), name))).toBe(true)
  expect(await conversationStatus(profile, held.conversationId)).toBe('running')
  expect(await isRunning(shellPid)).toBe(true)
  expect((await profile.call('service.list', { workspace_id: workspace.id })).states.web?.state).toBe('running')
  // Nothing new became eligible: the fresh uploads are in their grace window.
  expect((await profile.call('retention.preview', {})).candidates).toEqual([])

  // The backup taken during retention restores the referenced upload and its draft.
  const target = await nextProfileDataDirectory(ade)
  const restored = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', target])
  expect(restored.code, restored.stderr).toBe(0)
  const copy = await ade.profile()
  expect(copy.dataDirectory).toBe(target)
  expect(await stillThere(copy, idle.conversationId, finalized.id)).toBe(true)
  const draft = await copy.call('draft.get', { conversation_id: idle.conversationId, window_id: 'retention-window' })
  expect(JSON.stringify(draft)).toContain(finalized.id)

  await cancelActiveSubmission(profile, held.conversationId)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})
