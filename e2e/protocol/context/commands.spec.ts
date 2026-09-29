// F037: slash commands and skills. The daemon lists what a Conversation's
// provider can run, with provenance and argument hints, and invokes a listed
// entry in the provider's native form through the prompt queue. A provider
// without a native path reports the entry as unavailable; a missing entry is a
// failure; an invocation is an effect command that never queues twice.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, startConversation, test, waitForIdle, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { claudeContents, codexInputs, snapshot, waitForPrompts } from './helpers'

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const reviewCommand =
  '---\ndescription: Review a file for bugs\nargument-hint: <file>\n---\nReview $ARGUMENTS carefully.\n'
const lintSkill = '---\nname: lint\ndescription: Lint the workspace\n---\nRun the linter.\n'

/** A Claude Conversation on `repo` that loads the given setting sources. */
async function claudeConversation(profile: ScratchProfile, repo: ScratchRepo, settingSources: string[]) {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: 'claude',
    provider_config: { setting_sources: settingSources },
  })
  return conversation.id
}

test('F037: Claude lists project commands and skills with provenance and runs one in its native form once', async ({
  profile,
  repo,
}) => {
  await write(join(repo.path, '.claude/commands/review.md'), reviewCommand)
  await write(join(repo.path, '.claude/skills/lint/SKILL.md'), lintSkill)
  const conversationId = await claudeConversation(profile, repo, ['project'])

  const listing = await profile.call('command.list', { conversation_id: conversationId })
  expect(listing.provider).toBe('claude')
  expect(listing.native_catalog).toMatchObject({ method: 'Query.supportedCommands()', queried: false })
  const review = listing.entries.find((entry) => entry.name === 'review')
  expect(review).toMatchObject({
    kind: 'command',
    description: 'Review a file for bugs',
    argument_hint: '<file>',
    invocable: true,
    invocation: '/review',
    mechanism: 'claude.prompt_slash',
    provenance: {
      source: 'provider_file',
      scope: 'workspace',
      path: expect.stringContaining('.claude/commands/review.md'),
    },
  })
  expect(listing.entries.find((entry) => entry.name === 'lint')).toMatchObject({
    kind: 'skill',
    invocable: true,
    invocation: '/lint',
    description: 'Lint the workspace',
    provenance: { source: 'provider_skill', scope: 'workspace' },
  })
  const cliList = await profile.cli('command', 'list', conversationId)
  expect(cliList.code, cliList.stderr).toBe(0)
  expect(JSON.stringify(cliList.json)).toContain('"invocation":"/review"')

  const invoke = {
    operation_id: 'invoke-review',
    conversation_id: conversationId,
    name: 'review',
    kind: 'command' as const,
    arguments: 'src/app.ts',
  }
  const reply = await profile.call('command.invoke', invoke)
  expect(reply).toMatchObject({
    outcome: 'queued',
    native_text: '/review src/app.ts',
    queue_id: 'invoke-review:command',
    mechanism: 'claude.prompt_slash',
    reason: null,
  })
  // The provider receives the native text as its prompt.
  expect(await waitForPrompts(profile, 'claude', 1)).toEqual(['/review src/app.ts'])
  await waitForIdle(profile, conversationId)

  // R002: the same operation converges without queueing again, also after a restart; other arguments conflict.
  expect(await profile.call('command.invoke', invoke)).toEqual(reply)
  await profile.restartDaemon('kill')
  expect(await profile.call('command.invoke', invoke)).toEqual(reply)
  await expect(profile.call('command.invoke', { ...invoke, arguments: 'other.ts' })).rejects.toThrow(
    'already used for a different request',
  )

  // A skill runs the same way, through the CLI.
  const cliInvoke = await profile.cli(
    'command',
    'invoke',
    conversationId,
    'skill',
    'lint',
    '--operation-id',
    'invoke-lint',
  )
  expect(cliInvoke.code, cliInvoke.stderr).toBe(0)
  expect(cliInvoke.json).toMatchObject({ outcome: 'queued', native_text: '/lint' })
  expect(await waitForPrompts(profile, 'claude', 2)).toEqual(['/review src/app.ts', '/lint'])
  await waitForIdle(profile, conversationId)
  expect(
    (await snapshot(profile, conversationId)).messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text),
  ).toEqual(['/review src/app.ts', '/lint'])
})

test('F037: an entry the provider does not load, an ambiguous name and a missing file are refused without queueing', async ({
  profile,
  repo,
}) => {
  await write(join(repo.path, '.claude/commands/review.md'), reviewCommand)
  // Without the project setting source, Claude does not load project commands.
  const closed = await claudeConversation(profile, repo, [])
  const listed = (await profile.call('command.list', { conversation_id: closed })).entries.find(
    (entry) => entry.name === 'review',
  )
  expect(listed).toMatchObject({
    invocable: false,
    invocation: null,
    reason: expect.stringContaining('without the project setting source'),
  })
  const refused = await profile.call('command.invoke', {
    operation_id: 'invoke-closed',
    conversation_id: closed,
    name: 'review',
    kind: 'command',
  })
  expect(refused).toMatchObject({
    outcome: 'unavailable',
    native_text: null,
    queue_id: null,
    reason: expect.stringContaining('without the project setting source'),
  })
  const cli = await profile.cli('command', 'invoke', closed, 'command', 'review', '--operation-id', 'invoke-closed-cli')
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toContain('without the project setting source')

  // A command and a skill with one native text are both withheld: ADE cannot tell which Claude would run.
  const open = await claudeConversation(profile, repo, ['project'])
  await write(join(repo.path, '.claude/skills/review/SKILL.md'), lintSkill.replace('name: lint', 'name: review'))
  const ambiguous = (await profile.call('command.list', { conversation_id: open })).entries.filter(
    (entry) => entry.name === 'review',
  )
  expect(ambiguous.map((entry) => [entry.kind, entry.invocable])).toEqual([
    ['command', false],
    ['skill', false],
  ])
  expect(
    await profile.call('command.invoke', {
      operation_id: 'invoke-ambiguous',
      conversation_id: open,
      name: 'review',
      kind: 'command',
    }),
  ).toMatchObject({ outcome: 'unavailable' })

  // Once the skill and then the command file are gone, the name is missing.
  await rm(join(repo.path, '.claude/skills/review'), { recursive: true })
  await rm(join(repo.path, '.claude/commands/review.md'))
  await expect(
    profile.call('command.invoke', {
      operation_id: 'invoke-missing',
      conversation_id: open,
      name: 'review',
      kind: 'command',
    }),
  ).rejects.toThrow('No command named review is available to this Conversation')
  // Arguments the provider could not receive as typed input are refused.
  await write(join(repo.path, '.claude/commands/review.md'), reviewCommand)
  await expect(
    profile.call('command.invoke', {
      operation_id: 'invoke-control',
      conversation_id: open,
      name: 'review',
      kind: 'command',
      arguments: 'a\u0007b',
    }),
  ).rejects.toThrow('Arguments contain a control character')

  // Every refusal left no receipt: the unavailable operation IDs still run once the entry is invocable.
  expect(
    await profile.call('command.invoke', {
      operation_id: 'invoke-ambiguous',
      conversation_id: open,
      name: 'review',
      kind: 'command',
    }),
  ).toMatchObject({ outcome: 'queued', native_text: '/review' })
  expect(await waitForPrompts(profile, 'claude', 1)).toEqual(['/review'])
  for (const conversation of [closed, open]) {
    expect((await snapshot(profile, conversation)).queued).toEqual([])
  }
})

test('F037: Codex lists its prompts and skills as unavailable and nothing reaches the provider', async ({
  profile,
  repo,
}) => {
  await write(join(profile.home, '.codex/prompts/fix.md'), '---\ndescription: Fix it\n---\nFix $ARGUMENTS\n')
  await write(join(repo.path, '.agents/skills/lint/SKILL.md'), lintSkill)
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  const listing = await profile.call('command.list', { conversation_id: conversationId })
  expect(listing.native_catalog).toMatchObject({ method: 'skills/list', queried: false })
  expect(listing.entries.map((entry) => [entry.kind, entry.name, entry.invocable, entry.provenance.scope])).toEqual([
    ['command', 'fix', false, 'global'],
    ['skill', 'lint', false, 'workspace'],
  ])
  expect(listing.entries[0].reason).toContain('Codex app-server has no slash commands')
  expect(listing.entries[1].reason).toContain('skill turn input item')

  for (const [kind, name] of [
    ['command', 'fix'],
    ['skill', 'lint'],
  ] as const) {
    expect(
      await profile.call('command.invoke', {
        operation_id: `codex-${name}`,
        conversation_id: conversationId,
        name,
        kind,
      }),
    ).toMatchObject({ outcome: 'unavailable', native_text: null })
  }
  const state = await snapshot(profile, conversationId)
  expect(state.queued).toEqual([])
  expect(state.messages).toEqual([])
  expect(await codexInputs(profile)).toEqual([])
})

test('R001: an invocation whose reply was lost is queued once, even across a daemon crash', async ({
  profile,
  repo,
}) => {
  await write(join(repo.path, '.claude/commands/review.md'), reviewCommand)
  const conversationId = await claudeConversation(profile, repo, ['project'])
  // A paused queue holds the invocation, so the test can inspect it before delivery.
  await profile.call('queue.pause', { conversation_id: conversationId, paused: true })

  const invoke = {
    operation_id: 'invoke-lost',
    conversation_id: conversationId,
    name: 'review',
    kind: 'command' as const,
    arguments: 'lost.ts',
  }
  await sendAndLoseReply(profile, { op: 'command.invoke', ...invoke })
  await expect
    .poll(async () => (await snapshot(profile, conversationId)).queued.map((entry) => entry.id))
    .toEqual(['invoke-lost:command'])
  await profile.restartDaemon('kill')
  const retried = await profile.call('command.invoke', invoke)
  expect(retried).toMatchObject({ outcome: 'queued', native_text: '/review lost.ts', queue_id: 'invoke-lost:command' })
  expect((await snapshot(profile, conversationId)).queued).toHaveLength(1)

  // Released, the invocation is delivered exactly once, and a later retry still reads the stored reply.
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  expect(await waitForPrompts(profile, 'claude', 1)).toEqual(['/review lost.ts'])
  await waitForIdle(profile, conversationId)
  expect(await profile.call('command.invoke', invoke)).toEqual(retried)
  expect(await claudeContents(profile)).toEqual(['/review lost.ts'])

  // A queued invocation the user cancels reports that it will not run.
  await profile.call('queue.pause', { conversation_id: conversationId, paused: true })
  const cancelled = { ...invoke, operation_id: 'invoke-cancelled' }
  await sendAndLoseReply(profile, { op: 'command.invoke', ...cancelled })
  await expect.poll(async () => (await snapshot(profile, conversationId)).queued.length).toBe(1)
  await profile.call('queue.cancel', { conversation_id: conversationId, request_id: 'invoke-cancelled:command' })
  expect(await profile.call('command.invoke', cancelled)).toMatchObject({
    outcome: 'cancelled',
    reason: expect.stringContaining('will not run'),
  })
  await profile.call('queue.pause', { conversation_id: conversationId, paused: false })
  expect(await claudeContents(profile)).toEqual(['/review lost.ts'])
})
