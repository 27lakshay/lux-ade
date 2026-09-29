// F138 retention and cleanup (decision D15; architecture section 10). The
// daemon previews what its retention policy would remove under a generation
// and applies only that generation. Referenced and in-flight uploads, live
// service output, a process's current log and anything it cannot observe are
// never candidates. Items are aged by moving file times into the past; the
// policy itself is fixed and reported.
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, isRunning, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import {
  age,
  DAY_MS,
  diagnosticLogDirectory,
  names,
  plantDiagnosticLog,
  plantOrphanServiceLog,
  serviceLogDirectory,
  startService,
} from './steps'

type Preview = Awaited<ReturnType<typeof preview>>

async function preview(profile: ScratchProfile) {
  return profile.call('retention.preview', {})
}

async function apply(profile: ScratchProfile, generation: string) {
  return profile.call('retention.apply', { generation })
}

function ids(reply: Preview, kind?: string): string[] {
  return reply.candidates
    .filter((candidate) => !kind || candidate.kind === kind)
    .map((candidate) => candidate.id)
    .sort()
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

async function writeSkill(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Retention fixture.\n---\n\n${body}\n`)
}

let operation = 0
const nextOperation = (label: string) => `e2e-retention-${label}-${process.pid}-${++operation}`

test('preview selects only unowned, idle and aged items; apply removes exactly that generation and replays after a crash', async ({
  ade,
  profile,
  repo,
}) => {
  // A live service whose durable log is older than the idle limit: owned, so never a candidate.
  const live = await startService(profile, repo.path, 'web')
  for (const file of await names(serviceLogDirectory(profile))) {
    if (live.logKeys.some((key) => file.startsWith(key))) await age(join(serviceLogDirectory(profile), file), 10)
  }
  const shellPid = (live.started.metrics as { shell_pid: number }).shell_pid

  // An upload nothing references yet, and one a sent message references.
  const { conversationId } = await startConversation(profile, 'codex')
  const unreferenced = await profile.call('attachment.put', {
    conversation_id: conversationId,
    request_id: 'upload-unreferenced',
    name: 'notes.txt',
    data: Buffer.from('in-flight upload\n').toString('base64'),
  })
  const referenced = await profile.call('attachment.put', {
    conversation_id: conversationId,
    request_id: 'upload-referenced',
    name: 'spec.txt',
    data: Buffer.from('referenced upload\n').toString('base64'),
  })
  await profile.call('agent.send', {
    conversation_id: conversationId,
    request_id: 'send-with-attachment',
    text: 'hello',
    attachments: [referenced.attachment],
  })
  await waitForIdle(profile, conversationId)
  const drafted = await profile.call('attachment.put', {
    conversation_id: conversationId,
    request_id: 'upload-drafted',
    name: 'draft.txt',
    data: Buffer.from('drafted upload\n').toString('base64'),
  })
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'retention-window',
    revision: 1,
    text: 'draft with a file',
    attachments: [drafted.attachment],
  })

  // An installed skill bundle, replaced once. The replacement leaves the old
  // files unreferenced, so they are a candidate; the installed ones are not.
  const source = join(ade.root, 'skills', 'notes')
  await writeSkill(source, 'notes', 'First version.')
  const first = await profile.call('skill.install', { operation_id: nextOperation('install'), source_path: source })
  await writeSkill(source, 'notes', 'Second version.')
  const second = await profile.call('skill.install', {
    operation_id: nextOperation('replace'),
    source_path: source,
    replace_content_hash: first.skill.content_hash,
  })
  expect(second.changed).toBe(true)

  // Service logs: an orphan past the idle limit, an orphan written recently,
  // a file the runtime would never write, and a key whose file is a link.
  const idleOrphan = await plantOrphanServiceLog(profile, 8, 'idle orphan output\n')
  const recentOrphan = await plantOrphanServiceLog(profile, 2)
  const stray = join(serviceLogDirectory(profile), 'notes.txt')
  await writeFile(stray, 'not a runtime log\n')
  await age(stray, 30)
  const linkTarget = join(ade.root, 'link-target.txt')
  await writeFile(linkTarget, 'outside\n')
  const linkedKey = 'a'.repeat(64)
  await symlink(linkTarget, join(serviceLogDirectory(profile), `${linkedKey}.0`))

  // Diagnostic logs: a rotated file past the age limit, the same process's
  // newest file (kept however old), and a young rotated file.
  const oldLog = await plantDiagnosticLog(profile, 'planted', '2026-01-01', 40)
  const newestLog = await plantDiagnosticLog(profile, 'planted', '2026-01-02', 40)
  const youngLog = await plantDiagnosticLog(profile, 'young', '2026-09-01', 5)
  await plantDiagnosticLog(profile, 'young', '2026-09-02', 1)

  const planned = await preview(profile)
  expect(planned.policy).toMatchObject({
    attachment_grace_ms: DAY_MS,
    service_log_idle_ms: 7 * DAY_MS,
    diagnostic_log_max_age_ms: 30 * DAY_MS,
    receipt_retention_ms: 30 * DAY_MS,
    candidate_limit: 500,
  })
  expect(planned.withheld).toEqual([])
  expect(planned.truncated).toBe(false)
  expect(planned.generation).toMatch(/^[0-9a-f]{64}$/)
  expect(ids(planned, 'service_log')).toEqual([idleOrphan])
  expect(ids(planned, 'diagnostic_log')).toEqual([oldLog])
  expect(ids(planned, 'skill_blob')).toEqual([first.skill.content_hash])
  expect(ids(planned, 'attachment')).toEqual([])
  expect(planned.candidates).toHaveLength(3)
  for (const candidate of planned.candidates) {
    expect(candidate.bytes).toBeGreaterThan(0)
    expect(candidate.reason.length).toBeGreaterThan(0)
  }
  expect(planned.candidates.find((candidate) => candidate.kind === 'service_log')!.bytes).toBe(
    Buffer.byteLength('idle orphan output\n'),
  )
  expect(planned.reclaimable_bytes).toBe(planned.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0))
  expect(planned.receipts.map((store) => store.store)).toContain('sessions')
  expect(planned.observed_logs.map((log) => log.name).sort()).toEqual(['daemon.log', 'runtime.log'])

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
  expect(applied.results.map((result) => [result.kind, result.id, result.outcome]).sort()).toEqual(
    planned.candidates.map((candidate) => [candidate.kind, candidate.id, 'removed']).sort(),
  )

  // Exactly the candidates are gone.
  expect(await exists(join(serviceLogDirectory(profile), `${idleOrphan}.0`))).toBe(false)
  expect(await exists(join(diagnosticLogDirectory(profile), oldLog))).toBe(false)
  const skill = await profile.call('skill.inspect', { name: 'notes' })
  expect(skill.manifest.content_hash).toBe(second.skill.content_hash)
  expect(skill.manifest.files.map((file) => file.path)).toEqual(['SKILL.md'])
  // Everything else is intact.
  expect(await exists(join(serviceLogDirectory(profile), `${recentOrphan}.0`))).toBe(true)
  expect(await readFile(stray, 'utf8')).toBe('not a runtime log\n')
  expect((await lstat(join(serviceLogDirectory(profile), `${linkedKey}.0`))).isSymbolicLink()).toBe(true)
  expect(await readFile(linkTarget, 'utf8')).toBe('outside\n')
  expect(await exists(join(diagnosticLogDirectory(profile), newestLog))).toBe(true)
  expect(await exists(join(diagnosticLogDirectory(profile), youngLog))).toBe(true)
  for (const key of live.logKeys) {
    expect((await names(serviceLogDirectory(profile))).some((file) => file.startsWith(key))).toBe(true)
  }
  expect(await isRunning(shellPid)).toBe(true)
  for (const upload of [unreferenced, referenced, drafted]) {
    const inspected = await profile.call('attachment.inspect', {
      conversation_id: conversationId,
      attachment_id: upload.attachment.id,
    })
    expect(inspected.attachment.id).toBe(upload.attachment.id)
  }

  // A repeat after a daemon crash replays the stored result and removes nothing more.
  await profile.restartDaemon('kill')
  const replayed = await apply(profile, planned.generation)
  expect(replayed).toEqual({ ...applied, replayed: true })
  const cliReplay = await profile.cli('retention', 'apply', planned.generation)
  expect(cliReplay.code).toBe(0)
  expect(cliReplay.json).toMatchObject({ type: 'retention_apply', replayed: true, complete: true })

  const after = await preview(profile)
  expect(after.candidates).toEqual([])
  expect(after.generation).not.toBe(planned.generation)
  expect(after.reclaimable_bytes).toBe(0)
  await profile.call('service.stop', { workspace_id: live.workspace.id, name: 'web' })
})

test('a candidate set that changed after the preview is refused and nothing is removed', async ({ profile }) => {
  const first = await plantOrphanServiceLog(profile, 9, 'first\n')
  const planned = await preview(profile)
  expect(ids(planned)).toEqual([first])

  // The file was written again (it is still idle by its time, but its identity moved).
  const path = join(serviceLogDirectory(profile), `${first}.0`)
  await writeFile(path, 'first, rewritten\n')
  await age(path, 9)
  await expect(apply(profile, planned.generation)).rejects.toThrow(/changed since the preview; preview again/)
  expect(await readFile(path, 'utf8')).toBe('first, rewritten\n')

  // A new candidate appearing is a change too.
  const second = await preview(profile)
  const late = await plantOrphanServiceLog(profile, 9)
  await expect(apply(profile, second.generation)).rejects.toThrow(/preview again/)
  expect(await exists(join(serviceLogDirectory(profile), `${late}.0`))).toBe(true)

  // Unknown and empty generations are refused, by the SDK, the raw protocol and the CLI.
  await expect(apply(profile, 'f'.repeat(64))).rejects.toThrow(/preview again/)
  await expect(profile.rpc({ op: 'retention.apply', generation: '' })).rejects.toThrow(/generation/i)
  await expect(profile.rpc({ op: 'retention.apply' })).rejects.toThrow(/generation/i)
  const cli = await profile.cli('retention', 'apply', 'f'.repeat(64))
  expect(cli.code).not.toBe(0)
  expect(await exists(path)).toBe(true)

  // Two racing applies of one fresh generation remove each item once.
  const current = await preview(profile)
  expect(ids(current)).toEqual([first, late].sort())
  const racing = await Promise.allSettled([apply(profile, current.generation), apply(profile, current.generation)])
  const fulfilled = racing.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  expect(fulfilled.length).toBeGreaterThan(0)
  for (const result of fulfilled) expect(result).toMatchObject({ complete: true, generation: current.generation })
  expect(fulfilled.filter((result) => !result.replayed)).toHaveLength(1)
  for (const result of racing) {
    if (result.status === 'rejected') expect(String(result.reason)).toMatch(/preview again/)
  }
  expect(await exists(path)).toBe(false)
  expect(await exists(join(serviceLogDirectory(profile), `${late}.0`))).toBe(false)
})

test('a removal that fails is reported per item, is not stored, and succeeds on a retry of the same set', async ({
  profile,
}) => {
  const key = await plantOrphanServiceLog(profile, 8, 'stuck\n')
  const directory = serviceLogDirectory(profile)
  const planned = await preview(profile)
  expect(ids(planned)).toEqual([key])

  await chmod(directory, 0o500)
  let failed
  try {
    failed = await apply(profile, planned.generation)
  } finally {
    await chmod(directory, 0o700)
  }
  expect(failed).toMatchObject({ complete: false, replayed: false, removed_bytes: 0 })
  expect(failed.results).toEqual([
    expect.objectContaining({
      kind: 'service_log',
      id: key,
      outcome: 'failed',
      bytes: 0,
      error: expect.stringMatching(/Could not remove/),
    }),
  ])
  expect(await exists(join(directory, `${key}.0`))).toBe(true)

  // Nothing was removed, so the set and its name are unchanged; the failed
  // result was not stored, so the retry runs again rather than replaying it.
  expect((await preview(profile)).generation).toBe(planned.generation)
  const retried = await apply(profile, planned.generation)
  expect(retried).toMatchObject({ complete: true, replayed: false, removed_bytes: Buffer.byteLength('stuck\n') })
  expect(await exists(join(directory, `${key}.0`))).toBe(false)
})

test('without the runtime terminal list no service log is judged, and the preview says why', async ({ profile }) => {
  const orphan = await plantOrphanServiceLog(profile, 8)
  const oldLog = await plantDiagnosticLog(profile, 'planted', '2026-01-01', 40)
  await plantDiagnosticLog(profile, 'planted', '2026-01-02', 1)

  await profile.killRuntime()
  const blind = await preview(profile)
  expect(blind.withheld).toEqual([
    expect.objectContaining({ kind: 'service_log', reason: expect.stringMatching(/no service log is judged unowned/) }),
  ])
  expect(ids(blind, 'service_log')).toEqual([])
  // Other kinds are still evaluated.
  expect(ids(blind, 'diagnostic_log')).toEqual([oldLog])
  const applied = await apply(profile, blind.generation)
  expect(applied.complete).toBe(true)
  expect(await exists(join(serviceLogDirectory(profile), `${orphan}.0`))).toBe(true)

  // A new runtime answers again, and the orphan is judged.
  await profile.restartDaemon()
  const sighted = await preview(profile)
  expect(sighted.withheld).toEqual([])
  expect(ids(sighted, 'service_log')).toEqual([orphan])
})

test('the scheduled receipt prune records its outcome for every store', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_TIMING_POLICY: 'short' } })
  test.setTimeout(180_000)
  // Create receipts in the sessions store so the prune has a table to read.
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)
  const before = await preview(profile)
  for (const store of before.receipts) expect(store).toMatchObject({ last_pruned_at: null, last_error: null })

  // The explicit debug preset first runs after 5 seconds, on a 100 ms tick.
  await expect
    .poll(
      async () => (await preview(profile)).receipts.find((store) => store.store === 'sessions')?.last_pruned_at ?? null,
      { timeout: 150_000, intervals: [2_000] },
    )
    .not.toBeNull()
  const after = await preview(profile)
  for (const store of after.receipts) {
    if (store.last_pruned_at === null) continue
    // Nothing is 30 days old in a fresh profile, so nothing expired, and nothing failed.
    expect(store).toMatchObject({ last_expired: 0, last_error: null, past_retention: 0 })
  }
  // The same state is visible in diagnostics.
  const status = await profile.call('diagnostics.status', {})
  expect(status.retention.receipts_past_retention).toBe(0)
  expect(dirname(serviceLogDirectory(profile))).toBe(profile.dataDirectory)
})
