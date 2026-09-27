// F104: delegation binds the child's context explicitly. Attachments the
// parent owns are copied to the child under new IDs and reach the child's
// provider with its task, once. Context the parent does not own, that
// changed or that is missing is refused before any child exists.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, prompts, test, type ScratchProfile } from '../fixtures'
import { opId, parentIn, waitForChild } from './steps'

async function importInto(profile: ScratchProfile, conversation: string, id: string, name: string, text: string) {
  const path = join(profile.root, name)
  await writeFile(path, text)
  return (await profile.call('attachment.import', { conversation_id: conversation, request_id: id, path })).attachment
}

async function codexInputs(profile: ScratchProfile) {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<Record<string, string>> }).input)
}

test('a child receives the parent attachments named as its context, as its own copies, exactly once (F104)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const notes = await importInto(profile, parent, 'ctx-notes', 'notes.txt', 'the build fails on line 3\n')
  const request = {
    operation_id: opId('ctx'),
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    provider: 'codex',
    account: { mode: 'inherit' as const },
    workspace: { mode: 'same' as const },
    task: prompts.turn,
    context_attachments: [notes],
  }

  const { child } = await profile.call('orchestration.delegate', request)
  const childId = child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })

  // The child's task carries a copy it owns: same name, type and size, a new ID.
  const task = (await profile.call('conversation.get', { conversation_id: childId })).messages.find(
    (message) => message.id === child.task_message_id,
  )
  expect(task?.attachments).toHaveLength(1)
  const copy = task!.attachments![0]
  expect(copy).toMatchObject({ name: notes.name, media_type: notes.media_type, size: notes.size })
  expect(copy.id).not.toBe(notes.id)
  const [original, copied] = await Promise.all([
    profile.call('attachment.inspect', { conversation_id: parent, attachment_id: notes.id }),
    profile.call('attachment.inspect', { conversation_id: childId, attachment_id: copy.id }),
  ])
  expect(copied.sha256).toBe(original.sha256)
  await expect(
    profile.call('attachment.inspect', { conversation_id: childId, attachment_id: notes.id }),
  ).rejects.toThrow()

  // The provider saw the task and its context together.
  expect(await codexInputs(profile)).toEqual([
    [
      { type: 'text', text: prompts.turn },
      { type: 'text', text: `Attached file ${notes.name}:\nthe build fails on line 3\n` },
    ],
  ])

  // A retry, even after a daemon crash, returns the same child and copies nothing again.
  await profile.restartDaemon('kill')
  expect((await profile.call('orchestration.delegate', request)).child.child_conversation_id).toBe(childId)
  await expect(profile.call('orchestration.delegate', { ...request, context_attachments: [] })).rejects.toThrow(
    /already used for a different delegation/,
  )
  expect(await codexInputs(profile)).toHaveLength(1)
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toHaveLength(1)
})

test('context the parent does not own, or that changed or is missing, is refused with no child (F104)', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const { parent: other } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const foreign = await importInto(profile, other, 'ctx-foreign', 'foreign.txt', 'not the parent\n')
  const own = await importInto(profile, parent, 'ctx-own', 'own.txt', 'mine\n')
  const base = {
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    provider: 'codex',
    account: { mode: 'inherit' as const },
    workspace: { mode: 'same' as const },
    task: prompts.turn,
  }

  await expect(
    profile.call('orchestration.delegate', { ...base, operation_id: opId('foreign'), context_attachments: [foreign] }),
  ).rejects.toThrow(/another Conversation/)
  await expect(
    profile.call('orchestration.delegate', {
      ...base,
      operation_id: opId('changed'),
      context_attachments: [{ ...own, size: own.size + 1 }],
    }),
  ).rejects.toThrow(/metadata changed/)
  await expect(
    profile.call('orchestration.delegate', {
      ...base,
      operation_id: opId('missing'),
      context_attachments: [{ ...own, id: 'attachment_missing' }],
    }),
  ).rejects.toThrow(/Attachment is missing/)
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toEqual([])
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.conversations.map((item) => item.id).sort()).toEqual([parent, other].sort())
})

test('the CLI names context attachments by ID and the child receives them', async ({ profile }) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const notes = await importInto(profile, parent, 'ctx-cli', 'cli.txt', 'from the CLI\n')
  const delegated = await profile.cli(
    'child',
    'delegate',
    parent,
    'codex',
    prompts.turn,
    '--workspace',
    'same',
    '--account',
    'inherit',
    '--context',
    notes.id,
  )
  expect(delegated.code).toBe(0)
  const childId = (delegated.json as { child: { child_conversation_id: string } }).child.child_conversation_id
  await waitForChild(profile, childId, 'settled', { outcome: 'completed' })
  expect(JSON.stringify(await codexInputs(profile))).toContain('from the CLI')
  const missing = await profile.cli(
    'child',
    'delegate',
    parent,
    'codex',
    prompts.turn,
    '--workspace',
    'same',
    '--account',
    'inherit',
    '--context',
    'attachment_missing',
  )
  expect(missing.code).not.toBe(0)
})
