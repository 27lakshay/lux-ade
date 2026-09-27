// F032: attachments and media. Supported media reaches each provider in its
// native form; unsupported types and sizes are refused before anything is
// recorded or dispatched; attachment references survive a daemon crash; a
// missing or reclaimed file is reported, never silently dropped.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { onePixelPng } from '../fixtures/browser-owner'
import { claudeContents, codexInputs, pngOfSize, snapshot, waitForPrompts } from './helpers'

/** Import a file from the test's temp root as an attachment of `conversationId`. */
async function importFile(
  profile: ScratchProfile,
  conversationId: string,
  requestId: string,
  name: string,
  bytes: Buffer | string,
) {
  const path = join(profile.root, `${requestId}-${name}`)
  await writeFile(path, bytes)
  return (await profile.call('attachment.import', { conversation_id: conversationId, request_id: requestId, path }))
    .attachment
}

test('F032: an image and a text file reach Codex and Claude in their native forms, and the references survive a daemon crash', async ({
  profile,
}) => {
  const codex = (await startConversation(profile, 'codex')).conversationId
  const claude = (await startConversation(profile, 'claude')).conversationId
  const notes = 'build fails on line 3\n'

  const codexFiles = [
    await importFile(profile, codex, 'cx-image', 'shot.png', onePixelPng),
    await importFile(profile, codex, 'cx-notes', 'notes.txt', notes),
  ]
  expect(codexFiles.map((file) => [file.name, file.media_type, file.size])).toEqual([
    ['cx-image-shot.png', 'image/png', onePixelPng.length],
    ['cx-notes-notes.txt', 'text/plain', notes.length],
  ])
  // The SDK path takes base64; both paths store the same kind of attachment.
  const claudeFiles = [
    (
      await profile.call('attachment.put', {
        conversation_id: claude,
        request_id: 'cl-image',
        name: 'shot.png',
        data: onePixelPng.toString('base64'),
      })
    ).attachment,
    (
      await profile.call('attachment.put', {
        conversation_id: claude,
        request_id: 'cl-notes',
        name: 'notes.txt',
        data: Buffer.from(notes).toString('base64'),
      })
    ).attachment,
  ]

  for (const [conversation, files, image, text] of [
    [codex, codexFiles, 'Codex UserInput image with a data URL', 'Codex UserInput text item'],
    [claude, claudeFiles, 'Anthropic image content block, base64 source', 'text content block'],
  ] as const) {
    const plan = await profile.call('context.plan', {
      conversation_id: conversation,
      text: 'look',
      attachments: [...files],
    })
    expect(plan).toMatchObject({
      admissible: true,
      rejections: [],
      support: { known: true, image_form: image, text_form: text },
    })
    expect(plan.parts).toEqual([
      { attachment_id: files[0].id, form: 'native_image', text_prefix: null },
      { attachment_id: files[1].id, form: 'text_block', text_prefix: `Attached file ${files[1].name}:\n` },
    ])
    await profile.call('agent.send', {
      conversation_id: conversation,
      request_id: `send-${conversation}`,
      text: 'look',
      attachments: [...files],
    })
  }

  const [codexInput] = await waitForPrompts(profile, 'codex', 1)
  expect(codexInput).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', url: `data:image/png;base64,${onePixelPng.toString('base64')}` },
    { type: 'text', text: `Attached file ${codexFiles[1].name}:\n${notes}` },
  ])
  const [claudeContent] = await waitForPrompts(profile, 'claude', 1)
  expect(claudeContent).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: onePixelPng.toString('base64') } },
    { type: 'text', text: `Attached file ${claudeFiles[1].name}:\n${notes}` },
  ])
  await waitForIdle(profile, codex)
  await waitForIdle(profile, claude)

  // The accepted messages keep their attachment references across a daemon crash.
  await profile.restartDaemon('kill')
  for (const [conversation, files] of [
    [codex, codexFiles],
    [claude, claudeFiles],
  ] as const) {
    const message = (await snapshot(profile, conversation)).messages.find(
      (entry) => entry.id === `send-${conversation}`,
    )
    expect(message).toMatchObject({ role: 'user', attachments: [...files] })
    for (const file of files) {
      expect(
        (await profile.call('attachment.inspect', { conversation_id: conversation, attachment_id: file.id }))
          .attachment,
      ).toEqual(file)
    }
  }
})

test('F032: unsupported types and sizes are refused before anything is recorded or dispatched', async ({ profile }) => {
  const claude = (await startConversation(profile, 'claude')).conversationId
  const codex = (await startConversation(profile, 'codex')).conversationId

  // A PDF, a binary file and an empty file are not attachable at all.
  await expect(
    profile.call('attachment.put', {
      conversation_id: claude,
      request_id: 'pdf',
      name: 'spec.pdf',
      data: Buffer.from('%PDF-1.7\n\u0000binary').toString('base64'),
    }),
  ).rejects.toThrow(/Supported attachments: PNG, JPEG, GIF, WebP/)
  await expect(importFile(profile, claude, 'empty', 'empty.txt', '')).rejects.toThrow(/between 1 byte and 8 MiB/)
  // Over the 8 MiB attachment limit.
  await expect(importFile(profile, claude, 'huge', 'huge.png', pngOfSize(8 * 1024 * 1024 + 1))).rejects.toThrow(
    /between 1 byte and 8 MiB/,
  )
  // Text over 1 MiB is not a text attachment.
  await expect(importFile(profile, claude, 'long', 'long.txt', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(
    /UTF-8 text files up to 1 MiB/,
  )

  // A 7.6 MB PNG is within ADE's limit and Codex's, but over Claude's 10 MB base64 per-image limit.
  const size = 7_600_000
  const large = await importFile(profile, claude, 'large', 'large.png', pngOfSize(size))
  const plan = await profile.call('context.plan', { conversation_id: claude, text: 'look', attachments: [large] })
  expect(plan).toMatchObject({
    admissible: false,
    parts: [],
    rejections: [
      {
        attachment_id: large.id,
        code: 'image_too_large',
        message: `${large.name} is ${size} bytes; claude accepts images up to 7500000 bytes`,
      },
    ],
  })
  // The Conversation itself works: a plain prompt goes through first.
  await send(profile, claude, 'look', 'send-plain')
  await waitForIdle(profile, claude)
  await expect(
    profile.call('agent.send', {
      conversation_id: claude,
      request_id: 'send-large-image',
      text: 'look',
      attachments: [large],
    }),
  ).rejects.toThrow(/Attachment refused before sending: .*accepts images up to 7500000 bytes/)
  await expect(
    profile.call('queue.enqueue', {
      conversation_id: claude,
      request_id: 'queue-large-image',
      text: 'look',
      attachments: [large],
    }),
  ).rejects.toThrow(/Attachment refused before sending/)
  // Nothing was recorded or dispatched for the refused prompt; the same ID stays free.
  const state = await snapshot(profile, claude)
  expect(state.messages.some((message) => message.id === 'send-large-image')).toBe(false)
  expect(state.queued).toEqual([])
  expect(await claudeContents(profile)).toEqual(['look'])

  const codexLarge = await importFile(profile, codex, 'codex-large', 'large.png', pngOfSize(size))
  expect((await profile.call('context.plan', { conversation_id: codex, attachments: [codexLarge] })).admissible).toBe(
    true,
  )
  await profile.call('agent.send', {
    conversation_id: codex,
    request_id: 'send-codex-large',
    text: prompts.turn,
    attachments: [codexLarge],
  })
  const [input] = (await waitForPrompts(profile, 'codex', 1)) as Array<Array<Record<string, string>>>
  expect(input[1].url.length).toBe('data:image/png;base64,'.length + Math.ceil(size / 3) * 4)

  // More than eight attachments in one prompt is refused before dispatch.
  const many = []
  for (let index = 0; index < 9; index += 1)
    many.push(await importFile(profile, codex, `many-${index}`, 'n.txt', `note ${index}\n`))
  await waitForIdle(profile, codex)
  await expect(
    profile.call('agent.send', { conversation_id: codex, request_id: 'send-many', text: 'x', attachments: many }),
  ).rejects.toThrow('Limit of 8 attachments per prompt')
  expect(await codexInputs(profile)).toHaveLength(1)
})

test('F032: missing files and reclaimed attachments are reported and never sent', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await expect(
    profile.call('attachment.import', {
      conversation_id: conversationId,
      request_id: 'gone',
      path: join(profile.root, 'no-such-file.png'),
    }),
  ).rejects.toThrow(/No such file or directory/)
  await expect(
    profile.call('attachment.import', { conversation_id: conversationId, request_id: 'folder', path: profile.root }),
  ).rejects.toThrow(/Attach a regular file/)
  const unknown = { id: 'never-attached', name: 'x.png', media_type: 'image/png', size: 10 }
  await expect(
    profile.call('agent.send', {
      conversation_id: conversationId,
      request_id: 'send-unknown',
      text: 'x',
      attachments: [unknown],
    }),
  ).rejects.toThrow('Attachment is missing; attach the file again')

  // A draft keeps its attachment reference across a daemon crash.
  const notes = await importFile(profile, conversationId, 'draft-notes', 'notes.txt', 'draft notes\n')
  const owner = { conversation_id: conversationId, window_id: 'window-1' }
  await profile.call('draft.save', { ...owner, text: 'see notes', revision: 1, attachments: [notes] })
  await profile.restartDaemon('kill')
  expect((await profile.call('draft.get', owner)).draft).toMatchObject({ text: 'see notes', attachments: [notes] })
  // A draft reference protects the attachment from reclaim.
  const { preview: protectedPreview } = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: notes.id,
  })
  expect(protectedPreview).toMatchObject({ reclaimable: false, protected_by: ['draft'] })

  // Once the draft drops it and it is reclaimed, a send that still names it is refused.
  await profile.call('draft.save', { ...owner, text: 'see notes', revision: 2 })
  const { preview } = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: notes.id,
  })
  expect(preview.reclaimable).toBe(true)
  await profile.call('attachment.reclaim.apply', {
    conversation_id: conversationId,
    attachment_id: notes.id,
    expected_generation: preview.generation,
  })
  await expect(
    profile.call('agent.send', {
      conversation_id: conversationId,
      request_id: 'send-reclaimed',
      text: 'x',
      attachments: [notes],
    }),
  ).rejects.toThrow(/Attachment is unavailable/)
  await expect(
    profile.call('draft.save', { ...owner, text: 'again', revision: 3, attachments: [notes] }),
  ).rejects.toThrow(/Attachment is unavailable/)
  expect((await snapshot(profile, conversationId)).messages).toEqual([])
  expect(await codexInputs(profile)).toEqual([])
})
