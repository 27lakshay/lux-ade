// R011 attachment retention: an explicit reclaim frees only an upload nothing
// durable references (draft, message, queued prompt, send intent), serializes
// against a draft save, survives a store upgrade from schema 10, and runs
// safely while a backup copies the store. Ported from the legacy
// e2e/specs/attachment-retention spec; the backups use ade-control.
import { createHash } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { control, nextProfileDataDirectory, spawnControl } from '../fixtures/control'

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0wwAAAABJRU5ErkJggg=='

type Attachment = { id: string; name: string; media_type: string; size: number }

function attachments(profile: ScratchProfile, conversation_id: string) {
  const put = async (request_id: string): Promise<Attachment> =>
    (await profile.call('attachment.put', { conversation_id, request_id, name: `${request_id}.png`, data: pixel }))
      .attachment as Attachment
  const preview = async (attachment_id: string) =>
    (await profile.call('attachment.reclaim.preview', { conversation_id, attachment_id })).preview
  const apply = (attachment_id: string, expected_generation: string) =>
    profile.call('attachment.reclaim.apply', { conversation_id, attachment_id, expected_generation })
  const saveDraft = (window_id: string, revision: number, text: string, saved: Attachment[]) =>
    profile.call('draft.save', { conversation_id, window_id, revision, text, attachments: saved })
  return { put, preview, apply, saveDraft }
}

test('explicit attachment reclaim preserves durable references and unsaved uploads', async ({ profile }) => {
  const { conversationId: conversation_id } = await startConversation(profile, 'codex')
  const { put, preview, apply, saveDraft } = attachments(profile, conversation_id)

  const unsaved = await put('retained-unsaved')
  const free = await put('explicit-free')
  expect(await profile.call('attachment.reclaim.preview', { conversation_id, attachment_id: free.id })).toMatchObject({
    scope: 'explicit_single_attachment',
    automatic_gc_eligible: false,
    client_held_uploads: 'not_enumerated',
    filesystem_reclaimed_bytes: 0,
  })
  const freePreview = await preview(free.id)
  expect(freePreview).toMatchObject({
    reclaimable: true,
    payload_bytes: free.size,
    estimated_reusable_payload_bytes: free.size,
    protected_by: [],
  })
  await expect(apply(free.id, 'stale-generation')).rejects.toThrow(/changed since reclaim preview/)
  expect(await apply(free.id, freePreview.generation)).toMatchObject({
    type: 'attachment_reclaim',
    reclaimed_payload_bytes: free.size,
    filesystem_reclaimed_bytes: 0,
    attachment: { state: 'discarded', payload_bytes: 0 },
  })
  expect((await apply(free.id, freePreview.generation)).reclaimed_payload_bytes).toBe(0)
  await expect(put(free.id)).rejects.toThrow(/already used or discarded/)
  await expect(saveDraft('cannot-reuse', 1, 'Discarded', [free])).rejects.toThrow(/Attachment is unavailable/)

  // An upload held only by a draft is protected until the draft drops it.
  await saveDraft('retained', 1, 'Keep', [unsaved])
  const held = await preview(unsaved.id)
  expect(held).toMatchObject({ reclaimable: false, protected_by: ['draft'] })
  await expect(apply(unsaved.id, held.generation)).rejects.toThrow(/still referenced/)
  await saveDraft('retained', 2, '', [])
  expect((await preview(unsaved.id)).reclaimable).toBe(true)

  // A sent message protects its attachment.
  const sentAttachment = await put('message-image')
  await profile.call('agent.send', {
    conversation_id,
    request_id: 'message-with-image',
    text: 'Inspect image',
    attachments: [sentAttachment],
  })
  await waitForIdle(profile, conversation_id)
  const messagePreview = await preview(sentAttachment.id)
  expect(messagePreview.protected_by).toContain('message')
  await expect(apply(sentAttachment.id, messagePreview.generation)).rejects.toThrow(/still referenced/)
  expect((await profile.call('conversation.get', { conversation_id })).messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ attachments: [sentAttachment] })]),
  )

  // A queued prompt protects its attachment until it is cancelled.
  const queued = await put('queued-image')
  await profile.call('queue.pause', { conversation_id, paused: true })
  await profile.call('queue.enqueue', {
    conversation_id,
    request_id: 'queued-image-prompt',
    text: 'Use image later',
    attachments: [queued],
  })
  const queuedPreview = await preview(queued.id)
  expect(queuedPreview.protected_by).toContain('queued_prompt')
  await expect(apply(queued.id, queuedPreview.generation)).rejects.toThrow(/still referenced/)
  await profile.call('queue.cancel', { conversation_id, request_id: 'queued-image-prompt' })
  expect((await preview(queued.id)).reclaimable).toBe(true)
  expect((await apply(queued.id, queuedPreview.generation)).reclaimed_payload_bytes).toBe(queued.size)

  // A prepared send protects its attachment until it is aborted and the draft cleared.
  await profile.call('agent.send', { conversation_id, request_id: 'busy-for-rejected-intent', text: 'approval' })
  const intentAttachment = await put('intent-image')
  await saveDraft('intent-window', 1, 'Send later', [intentAttachment])
  const owner = { conversation_id, window_id: 'intent-window' }
  await profile.call('draft.send.prepare', {
    ...owner,
    request_id: 'intent-send',
    revision: 1,
    draft_text: 'Send later',
    text: 'Send later',
    attachments: [intentAttachment],
  })
  const intentPreview = await preview(intentAttachment.id)
  expect(intentPreview.protected_by).toEqual(expect.arrayContaining(['draft', 'send_intent']))
  await expect(apply(intentAttachment.id, intentPreview.generation)).rejects.toThrow(/still referenced/)
  await expect(
    profile.call('agent.send', {
      conversation_id,
      request_id: 'intent-send',
      text: 'Send later',
      attachments: [intentAttachment],
    }),
  ).rejects.toThrow(/active turn/)
  await profile.call('draft.send.abort', { ...owner, request_id: 'intent-send' })
  await saveDraft('intent-window', 2, '', [])
  expect((await preview(intentAttachment.id)).reclaimable).toBe(true)
  expect((await apply(intentAttachment.id, intentPreview.generation)).reclaimed_payload_bytes).toBe(
    intentAttachment.size,
  )
})

test('draft save and reclaim serialize so both cannot succeed for one upload', async ({ profile }) => {
  const { conversationId: conversation_id } = await startConversation(profile, 'codex')
  const { put, preview, apply, saveDraft } = attachments(profile, conversation_id)
  const attachment = await put('raced-upload')
  const before = await preview(attachment.id)
  const [save, reclaim] = await Promise.allSettled([
    saveDraft('raced-window', 1, 'Keep it', [attachment]),
    apply(attachment.id, before.generation),
  ])
  expect([save.status, reclaim.status].filter((state) => state === 'fulfilled')).toHaveLength(1)
  const after = await preview(attachment.id)
  if (save.status === 'fulfilled') {
    expect(after.protected_by).toContain('draft')
    expect(after.state).toBe('live')
  } else {
    expect(after.state).toBe('discarded')
    expect((await profile.call('draft.get', { conversation_id, window_id: 'raced-window' })).draft).toMatchObject({
      text: '',
    })
  }
})

test('a real daemon upgrades v10 attachments to live generation-fenced records', async ({ ade, profile }) => {
  const { conversationId: conversation_id } = await startConversation(profile, 'codex')
  const { put, saveDraft } = attachments(profile, conversation_id)
  const attachment = await put('legacy-upload')
  await saveDraft('legacy-window', 1, 'Keep legacy payload', [attachment])
  const bundle = join(ade.root, 'legacy-backup')
  const created = await control(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle])
  expect(created.code, created.stderr).toBe(0)
  const data = await nextProfileDataDirectory(ade)
  const restored = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', data])
  expect(restored.code, restored.stderr).toBe(0)

  // Model a schema-10 store: attachments without generation, state or creation time.
  const database = join(data, 'sessions.sqlite')
  const db = new DatabaseSync(database)
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  db.exec(`ALTER TABLE attachments DROP COLUMN created_at;
    ALTER TABLE attachments DROP COLUMN state;
    ALTER TABLE attachments DROP COLUMN generation;
    DROP TABLE restore_fence;
    DELETE FROM schema_migrations WHERE version>=11;
    PRAGMA user_version=10;`)
  db.close()

  const upgraded = await ade.profile()
  expect(upgraded.dataDirectory).toBe(data)
  expect((await upgraded.call('draft.get', { conversation_id, window_id: 'legacy-window' })).draft).toMatchObject({
    attachments: [attachment],
  })
  const preview = (await upgraded.call('attachment.reclaim.preview', { conversation_id, attachment_id: attachment.id }))
    .preview
  expect(preview).toMatchObject({
    state: 'live',
    payload_bytes: attachment.size,
    protected_by: ['draft'],
    reclaimable: false,
  })
  expect(preview.generation).toMatch(/^[0-9a-f]{32}$/)
  const check = new DatabaseSync(database, { readOnly: true })
  expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(current)
  check.close()
})

test('a backend snapshot remains valid while attachment reclaim runs', async ({ ade, profile }) => {
  const { conversationId: conversation_id } = await startConversation(profile, 'codex')
  const { put, preview, apply, saveDraft } = attachments(profile, conversation_id)
  const protectedAttachment = await put('backup-protected')
  const freeAttachment = await put('backup-reclaimable')
  await saveDraft('backup-window', 1, 'Keep for restore', [protectedAttachment])
  const freePreview = await preview(freeAttachment.id)

  // Hold the backup's online copy of the store open while the reclaim runs.
  const bundle = join(ade.root, 'retention-backup')
  const signal = join(ade.root, 'snapshot-open')
  const release = join(ade.root, 'snapshot-release')
  const running = await spawnControl(ade, ['backup', 'create', '--data-dir', profile.dataDirectory, '--out', bundle], {
    env: {
      ADE_E2E_BACKUP_PAUSE_ENABLED: '1',
      ADE_E2E_BACKUP_PAUSE_SIGNAL: signal,
      ADE_E2E_BACKUP_PAUSE_RELEASE: release,
    },
  })
  let reclaimed: Awaited<ReturnType<typeof apply>>
  try {
    await expect
      .poll(() =>
        access(signal).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    reclaimed = await apply(freeAttachment.id, freePreview.generation)
  } finally {
    await writeFile(release, '')
  }
  const snapshot = await running.done
  expect(snapshot.code, snapshot.stderr).toBe(0)
  expect(snapshot.json).toMatchObject({
    type: 'backup',
    manifest: {
      scope: 'backend-snapshot-only',
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'sessions.sqlite', schema: expect.any(Number) }),
      ]),
    },
  })
  expect(reclaimed).toMatchObject({ reclaimed_payload_bytes: freeAttachment.size })
  const inspected = await control(ade, ['backup', 'inspect', '--backup', bundle])
  expect(inspected.code, inspected.stderr).toBe(0)

  const data = await nextProfileDataDirectory(ade)
  const restoredData = await control(ade, ['backup', 'restore', '--backup', bundle, '--data-dir', data])
  expect(restoredData.code, restoredData.stderr).toBe(0)
  const restored = await ade.profile()
  expect((await restored.call('draft.get', { conversation_id, window_id: 'backup-window' })).draft).toMatchObject({
    attachments: [protectedAttachment],
  })
  // The snapshot holds the free upload either before or after the reclaim, never half of it.
  const restoredFree = (
    await restored.call('attachment.reclaim.preview', { conversation_id, attachment_id: freeAttachment.id })
  ).preview
  expect(['live', 'discarded']).toContain(restoredFree.state)
  expect(restoredFree.payload_bytes).toBe(restoredFree.state === 'live' ? freeAttachment.size : 0)
  expect(
    await restored.call('attachment.inspect', { conversation_id, attachment_id: protectedAttachment.id }),
  ).toMatchObject({
    type: 'attachment_inspection',
    attachment: protectedAttachment,
    sha256: createHash('sha256').update(Buffer.from(pixel, 'base64')).digest('hex'),
  })

  // The source keeps its protected upload.
  expect((await profile.call('draft.get', { conversation_id, window_id: 'backup-window' })).draft).toMatchObject({
    attachments: [protectedAttachment],
  })
  expect((await preview(protectedAttachment.id)).protected_by).toEqual(['draft'])
})
