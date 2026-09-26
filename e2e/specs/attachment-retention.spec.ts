import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0wwAAAABJRU5ErkJggg=='
const execFileAsync = promisify(execFile)

type Attachment = { id: string; name: string; media_type: string; size: number }
type Preview = { attachment_id: string; generation: string; state: string; payload_bytes: number;
  estimated_reusable_payload_bytes: number; protected_by: string[]; reclaimable: boolean }

test('explicit attachment reclaim preserves durable references and unsaved uploads', async () => {
  const mockDirectory = await mkdtemp(join(tmpdir(), 'ade-retention-codex-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: mockDirectory,
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex' })).conversation as { id: string }
    const put = async (id: string): Promise<Attachment> => (await rpc(daemon.socket, {
      op: 'attachment.put', conversation_id: conversation.id, request_id: id,
      name: `${id}.png`, data: pixel,
    })).attachment as Attachment
    const preview = async (id: string): Promise<Preview> => (await rpc(daemon.socket, {
      op: 'attachment.reclaim.preview', conversation_id: conversation.id, attachment_id: id,
    })).preview as Preview
    const apply = (id: string, generation: string) => rpc(daemon.socket, {
      op: 'attachment.reclaim.apply', conversation_id: conversation.id,
      attachment_id: id, expected_generation: generation,
    })

    const unsaved = await put('retained-unsaved')
    const free = await put('explicit-free')
    expect(await rpc(daemon.socket, { op: 'attachment.reclaim.preview',
      conversation_id: conversation.id, attachment_id: free.id })).toMatchObject({
      scope: 'explicit_single_attachment', automatic_gc_eligible: false,
      client_held_uploads: 'not_enumerated', filesystem_reclaimed_bytes: 0,
    })
    const freePreview = await preview(free.id)
    expect(freePreview).toMatchObject({ reclaimable: true, payload_bytes: free.size,
      estimated_reusable_payload_bytes: free.size, protected_by: [] })
    await expect(apply(free.id, 'stale-generation')).rejects.toThrow(/changed since reclaim preview/)
    const freed = await apply(free.id, freePreview.generation)
    expect(freed).toMatchObject({ type: 'attachment_reclaim', reclaimed_payload_bytes: free.size,
      filesystem_reclaimed_bytes: 0, attachment: { state: 'discarded', payload_bytes: 0 } })
    expect((await apply(free.id, freePreview.generation)).reclaimed_payload_bytes).toBe(0)
    await expect(put(free.id)).rejects.toThrow(/already used or discarded/)
    await expect(rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'cannot-reuse', revision: 1, text: 'Discarded', attachments: [free] }))
      .rejects.toThrow(/Attachment is unavailable/)

    // Another upload can remain only in client memory without automatic collection.
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'retained', revision: 1, text: 'Keep', attachments: [unsaved] })
    const held = await preview(unsaved.id)
    expect(held).toMatchObject({ reclaimable: false, protected_by: ['draft'] })
    await expect(apply(unsaved.id, held.generation)).rejects.toThrow(/still referenced/)
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'retained', revision: 2, text: '', attachments: [] })
    expect((await preview(unsaved.id)).reclaimable).toBe(true)

    const sentAttachment = await put('message-image')
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'message-with-image', text: 'Inspect image', attachments: [sentAttachment] })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: conversation.id })).conversation as { status: string }).toMatchObject({ status: 'ready' })
    const messagePreview = await preview(sentAttachment.id)
    expect(messagePreview.protected_by).toContain('message')
    await expect(apply(sentAttachment.id, messagePreview.generation)).rejects.toThrow(/still referenced/)
    expect((await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id }))
      .messages).toEqual(expect.arrayContaining([expect.objectContaining({ attachments: [sentAttachment] })]))

    const queued = await put('queued-image')
    await rpc(daemon.socket, { op: 'queue.pause', conversation_id: conversation.id, paused: true })
    await rpc(daemon.socket, { op: 'queue.enqueue', conversation_id: conversation.id,
      request_id: 'queued-image-prompt', text: 'Use image later', attachments: [queued] })
    const queuedPreview = await preview(queued.id)
    expect(queuedPreview.protected_by).toContain('queued_prompt')
    await expect(apply(queued.id, queuedPreview.generation)).rejects.toThrow(/still referenced/)
    await rpc(daemon.socket, { op: 'queue.cancel', conversation_id: conversation.id,
      request_id: 'queued-image-prompt' })
    expect((await preview(queued.id)).reclaimable).toBe(true)
    expect((await apply(queued.id, queuedPreview.generation)).reclaimed_payload_bytes).toBe(queued.size)

    await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'busy-for-rejected-intent', text: 'approval' })
    const intentAttachment = await put('intent-image')
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'intent-window', revision: 1, text: 'Send later', attachments: [intentAttachment] })
    await rpc(daemon.socket, { op: 'draft.send.prepare', conversation_id: conversation.id,
      window_id: 'intent-window', request_id: 'intent-send', revision: 1,
      draft_text: 'Send later', text: 'Send later', attachments: [intentAttachment] })
    const intentPreview = await preview(intentAttachment.id)
    expect(intentPreview.protected_by).toEqual(expect.arrayContaining(['draft', 'send_intent']))
    await expect(apply(intentAttachment.id, intentPreview.generation)).rejects.toThrow(/still referenced/)
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
      request_id: 'intent-send', text: 'Send later', attachments: [intentAttachment] }))
      .rejects.toThrow(/active turn/)
    await rpc(daemon.socket, { op: 'draft.send.abort', conversation_id: conversation.id,
      window_id: 'intent-window', request_id: 'intent-send' })
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'intent-window', revision: 2, text: '', attachments: [] })
    expect((await preview(intentAttachment.id)).reclaimable).toBe(true)
    expect((await apply(intentAttachment.id, intentPreview.generation)).reclaimed_payload_bytes)
      .toBe(intentAttachment.size)

  } finally {
    await daemon.stop()
    await rm(mockDirectory, { recursive: true, force: true })
  }
})

test('draft save and reclaim serialize so both cannot succeed for one upload', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex' })).conversation as { id: string }
    const attachment = (await rpc(daemon.socket, { op: 'attachment.put', conversation_id: conversation.id,
      request_id: 'raced-upload', name: 'pixel.png', data: pixel })).attachment as Attachment
    const preview = (await rpc(daemon.socket, { op: 'attachment.reclaim.preview',
      conversation_id: conversation.id, attachment_id: attachment.id })).preview as Preview
    const [save, reclaim] = await Promise.allSettled([
      rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
        window_id: 'raced-window', revision: 1, text: 'Keep it', attachments: [attachment] }),
      rpc(daemon.socket, { op: 'attachment.reclaim.apply', conversation_id: conversation.id,
        attachment_id: attachment.id, expected_generation: preview.generation }),
    ])
    expect([save.status, reclaim.status].filter((state) => state === 'fulfilled')).toHaveLength(1)
    const after = (await rpc(daemon.socket, { op: 'attachment.reclaim.preview',
      conversation_id: conversation.id, attachment_id: attachment.id })).preview as Preview
    if (save.status === 'fulfilled') {
      expect(after.protected_by).toContain('draft')
      expect(after.state).toBe('live')
    } else {
      expect(after.state).toBe('discarded')
      expect((await rpc(daemon.socket, { op: 'draft.get', conversation_id: conversation.id,
        window_id: 'raced-window' })).draft).toMatchObject({ text: '' })
    }
  } finally {
    await daemon.stop()
  }
})

test('a real daemon upgrades v10 attachments to live generation-fenced records', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex' })).conversation as { id: string }
    const attachment = (await rpc(daemon.socket, { op: 'attachment.put',
      conversation_id: conversation.id, request_id: 'legacy-upload', name: 'pixel.png',
      data: pixel })).attachment as Attachment
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'legacy-window', revision: 1, text: 'Keep legacy payload',
      attachments: [attachment] })
    const backup = join(daemon.rootDirectory, 'legacy-backup')
    const restored = join(daemon.rootDirectory, 'legacy-profile')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', daemon.dataDirectory, '--out', backup], { timeout: 20_000 })
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore',
      '--backup', backup, '--data-dir', restored], { timeout: 20_000 })
    await execFileAsync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('ALTER TABLE attachments DROP COLUMN created_at')
 db.execute('ALTER TABLE attachments DROP COLUMN state')
 db.execute('ALTER TABLE attachments DROP COLUMN generation')
 db.execute('DROP TABLE restore_fence')
 db.execute('DELETE FROM schema_migrations WHERE version>=11')
 db.execute('PRAGMA user_version=10')`, join(restored, 'sessions.sqlite')])
    const upgraded = await startDaemon({ ADE_DATA_DIR: restored })
    try {
      expect((await rpc(upgraded.socket, { op: 'draft.get', conversation_id: conversation.id,
        window_id: 'legacy-window' })).draft).toMatchObject({ attachments: [attachment] })
      const preview = (await rpc(upgraded.socket, { op: 'attachment.reclaim.preview',
        conversation_id: conversation.id, attachment_id: attachment.id })).preview as Preview
      expect(preview).toMatchObject({ state: 'live', payload_bytes: attachment.size,
        protected_by: ['draft'], reclaimable: false })
      expect(preview.generation).toMatch(/^[0-9a-f]{32}$/)
      const { stdout } = await execFileAsync('python3', ['-c',
        'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("PRAGMA user_version").fetchone()[0])',
        join(restored, 'sessions.sqlite')])
      expect(stdout.trim()).toBe('14')
    } finally {
      await upgraded.stop()
    }
  } finally {
    await daemon.stop()
  }
})

test('a backend snapshot remains valid while attachment reclaim runs', async () => {
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create',
      workspace_id: workspace.id, provider: 'codex' })).conversation as { id: string }
    const put = async (id: string): Promise<Attachment> => (await rpc(daemon.socket, {
      op: 'attachment.put', conversation_id: conversation.id, request_id: id,
      name: `${id}.png`, data: pixel,
    })).attachment as Attachment
    const protectedAttachment = await put('backup-protected')
    const freeAttachment = await put('backup-reclaimable')
    await rpc(daemon.socket, { op: 'draft.save', conversation_id: conversation.id,
      window_id: 'backup-window', revision: 1, text: 'Keep for restore', attachments: [protectedAttachment] })
    const preview = (await rpc(daemon.socket, { op: 'attachment.reclaim.preview',
      conversation_id: conversation.id, attachment_id: freeAttachment.id })).preview as Preview
    const backup = join(daemon.rootDirectory, 'retention-backup')
    const signal = join(daemon.rootDirectory, 'snapshot-open')
    const release = join(daemon.rootDirectory, 'snapshot-release')
    const create = execFileAsync('python3', ['scripts/managed_backup.py', 'create',
      '--data-dir', daemon.dataDirectory, '--out', backup], { timeout: 20_000,
      env: { ...process.env, ADE_E2E_BACKUP_PAUSE_SIGNAL: signal, ADE_E2E_BACKUP_PAUSE_RELEASE: release } })
    let reclaimed: Record<string, unknown>
    try {
      await expect.poll(async () => access(signal).then(() => true, () => false)).toBe(true)
      reclaimed = await rpc(daemon.socket, { op: 'attachment.reclaim.apply', conversation_id: conversation.id,
        attachment_id: freeAttachment.id, expected_generation: preview.generation })
    } finally {
      await writeFile(release, '')
    }
    const snapshot = await create
    expect(JSON.parse(snapshot.stdout)).toMatchObject({ type: 'managed_backup', operation: 'create',
      manifest: { scope: 'backend-snapshot-only', entries: expect.arrayContaining([
        expect.objectContaining({ path: 'sessions.sqlite', schema: 14 }),
      ]) } })
    expect(reclaimed).toMatchObject({ reclaimed_payload_bytes: freeAttachment.size })
    const inspected = await execFileAsync('python3', ['scripts/managed_backup.py', 'inspect', '--backup', backup],
      { timeout: 20_000 })
    expect(JSON.parse(inspected.stdout)).toMatchObject({ type: 'managed_backup', operation: 'inspect' })
    const restored = join(daemon.rootDirectory, 'restored-retention')
    await execFileAsync('python3', ['scripts/managed_backup.py', 'restore', '--backup', backup,
      '--data-dir', restored], { timeout: 20_000 })
    const restoredDaemon = await startDaemon({ ADE_DATA_DIR: restored })
    try {
      expect((await rpc(restoredDaemon.socket, { op: 'draft.get', conversation_id: conversation.id,
        window_id: 'backup-window' })).draft).toMatchObject({ attachments: [protectedAttachment] })
      const restoredFree = (await rpc(restoredDaemon.socket, { op: 'attachment.reclaim.preview',
        conversation_id: conversation.id, attachment_id: freeAttachment.id })).preview as Preview
      expect(['live', 'discarded']).toContain(restoredFree.state)
      expect(restoredFree.payload_bytes).toBe(restoredFree.state === 'live' ? freeAttachment.size : 0)
      const inspectedAttachment = await rpc(restoredDaemon.socket, { op: 'attachment.inspect',
        conversation_id: conversation.id, attachment_id: protectedAttachment.id })
      expect(inspectedAttachment).toMatchObject({ type: 'attachment_inspection',
        attachment: protectedAttachment,
        sha256: createHash('sha256').update(Buffer.from(pixel, 'base64')).digest('hex') })
    } finally {
      await restoredDaemon.stop()
    }
    expect((await rpc(daemon.socket, { op: 'draft.get', conversation_id: conversation.id,
      window_id: 'backup-window' })).draft).toMatchObject({ attachments: [protectedAttachment] })
    expect((await rpc(daemon.socket, { op: 'attachment.reclaim.preview', conversation_id: conversation.id,
      attachment_id: protectedAttachment.id })).preview).toMatchObject({ protected_by: ['draft'] })
  } finally {
    await daemon.stop()
  }
})
