// F033: prompt context capture. Each supported surface (file range, diff hunk,
// terminal selection, service log, browser element) becomes a context node
// with its source identity. The node's preview is exactly what the provider
// receives, and a repeated capture never reads its source again.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, startConversation, test, waitForIdle, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { contextCaptureReply, startBrowserOwner } from '../fixtures/browser-owner'
import { configureService, nodeService, writeServicePrograms } from '../fixtures/services'
import { codexInputs, sha256, snapshot, waitForPrompts } from './helpers'

const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'

async function codexOnRepo(profile: ScratchProfile, repo: ScratchRepo) {
  await repo.commit('Add source', { 'src/app.ts': source })
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  return { workspaceId, conversationId, terminalId: workspace.terminal_id }
}

/** Capture and return the reply, failing with the daemon's message. */
async function capture(
  profile: ScratchProfile,
  conversationId: string,
  requestId: string,
  source: Record<string, unknown>,
) {
  return profile.call('context.capture', {
    conversation_id: conversationId,
    request_id: requestId,
    source: source as never,
  })
}

test('F033: file and diff captures keep their source identity and preview exactly what Codex receives', async ({
  profile,
  repo,
}) => {
  const { workspaceId, conversationId } = await codexOnRepo(profile, repo)

  const file = await capture(profile, conversationId, 'ctx-file', {
    kind: 'file_range',
    workspace_id: workspaceId,
    path: 'src/app.ts',
    start_line: 2,
    end_line: 4,
  })
  expect(file.node).toMatchObject({
    id: 'ctx-file',
    kind: 'file_range',
    origin: 'daemon_read',
    truncated: false,
    provenance: { workspace_id: workspaceId, path: 'src/app.ts', start_line: 2, end_line: 4, total_lines: 10 },
  })
  expect(file.available).toBe(true)
  const fileText = file.previews[0].text!
  expect(fileText).toContain('ADE context: file range\nPath: src/app.ts\nLines: 2-4\nFile lines: 10\n')
  expect(fileText).toContain('```\nline 2\nline 3\nline 4\n```')
  expect(fileText).not.toContain('line 5')
  expect(file.node.sha256).toEqual([sha256(fileText)])

  // A diff hunk is read again under the token the caller saw.
  await repo.dirty('src/app.ts', source.replace('line 7', 'line seven'))
  const diff = await profile.call('review.diff', { workspace_id: workspaceId, path: 'src/app.ts', staged: false })
  const hunk = await capture(profile, conversationId, 'ctx-hunk', {
    kind: 'diff_hunk',
    workspace_id: workspaceId,
    path: 'src/app.ts',
    staged: false,
    token: diff.token,
    hunk: 0,
  })
  expect(hunk.node).toMatchObject({
    kind: 'diff_hunk',
    origin: 'daemon_read',
    provenance: { path: 'src/app.ts', staged: false, diff_token: diff.token, hunk: 0 },
  })
  expect(hunk.previews[0].text).toContain('-line 7\n+line seven')
  // The diff moved on: the old token is refused and nothing is recorded under the new ID.
  await repo.dirty('src/app.ts', source.replace('line 7', 'line 7 again'))
  await expect(
    capture(profile, conversationId, 'ctx-hunk-stale', {
      kind: 'diff_hunk',
      workspace_id: workspaceId,
      path: 'src/app.ts',
      staged: false,
      token: diff.token,
      hunk: 0,
    }),
  ).rejects.toThrow('The diff changed since it was read')
  await expect(
    profile.call('context.get', { conversation_id: conversationId, node_id: 'ctx-hunk-stale' }),
  ).rejects.toThrow('No context node has this ID')

  // The plan shows the exact prefix; the provider then receives prefix + preview, byte for byte.
  const attachments = [...file.node.attachments, ...hunk.node.attachments]
  const plan = await profile.call('context.plan', { conversation_id: conversationId, text: 'review', attachments })
  expect(plan.admissible).toBe(true)
  expect(plan.parts.map((part) => part.form)).toEqual(['text_block', 'text_block'])
  await profile.call('agent.send', {
    conversation_id: conversationId,
    request_id: 'send-context',
    text: 'review',
    attachments,
  })
  const [input] = (await waitForPrompts(profile, 'codex', 1)) as Array<Array<Record<string, string>>>
  expect(input).toEqual([
    { type: 'text', text: 'review' },
    { type: 'text', text: `${plan.parts[0].text_prefix}${fileText}` },
    { type: 'text', text: `${plan.parts[1].text_prefix}${hunk.previews[0].text}` },
  ])
  await waitForIdle(profile, conversationId)
  expect(
    (await snapshot(profile, conversationId)).messages.find((message) => message.id === 'send-context')?.attachments,
  ).toEqual(attachments)
})

test('F033: terminal, service log and browser captures record who supplied the text and preview what is sent', async ({
  profile,
  repo,
}) => {
  const { workspaceId, conversationId, terminalId } = await codexOnRepo(profile, repo)

  // Terminal output is client-supplied; ADE strips escapes and checks the terminal exists.
  const terminal = await capture(profile, conversationId, 'ctx-term', {
    kind: 'terminal_output',
    workspace_id: workspaceId,
    terminal_id: terminalId,
    text: '\u001b[31mnpm test failed\u001b[0m\r\n  at app.ts:3\r\n',
    first_row: 40,
  })
  expect(terminal.node).toMatchObject({
    kind: 'terminal_output',
    origin: 'client_supplied',
    provenance: { terminal_id: terminalId, start_line: 40 },
  })
  expect(terminal.previews[0].text).toContain('```\nnpm test failed\n  at app.ts:3\n```')
  expect(terminal.previews[0].text).not.toContain('\u001b')
  await expect(
    capture(profile, conversationId, 'ctx-term-missing', {
      kind: 'terminal_output',
      workspace_id: workspaceId,
      terminal_id: 'no-such-terminal',
      text: 'x',
    }),
  ).rejects.toThrow('The workspace has no terminal with this ID')

  // A service log keeps only the requested tail and says what it cut.
  const programs = await writeServicePrograms(repo.path)
  await configureService(profile, workspaceId, 'web', nodeService(programs.server))
  const log = await capture(profile, conversationId, 'ctx-log', {
    kind: 'service_log',
    workspace_id: workspaceId,
    service: 'web',
    text: 'booting\nlistening on 4000\nGET / 500\n',
    lines: 2,
  })
  expect(log.node).toMatchObject({
    kind: 'service_log',
    origin: 'client_supplied',
    provenance: { service: 'web' },
    truncated: true,
    omitted_lines: 1,
  })
  expect(log.previews[0].text).toContain('```\nlistening on 4000\nGET / 500\n```')
  expect(log.previews[0].text).toContain('Truncated: 1 lines')
  await expect(
    capture(profile, conversationId, 'ctx-log-missing', {
      kind: 'service_log',
      workspace_id: workspaceId,
      service: 'api',
      text: 'x\n',
      lines: 1,
    }),
  ).rejects.toThrow('The workspace has no service with this name')

  // A browser element arrives from the browser owner as a document and a screenshot.
  const owner = await startBrowserOwner(profile, (command) =>
    contextCaptureReply(command, {
      url: 'https://app.test/dashboard',
      title: 'Dashboard',
      html: '<h1 class="headline">Revenue</h1>',
      text: 'Revenue',
    }),
  )
  const captured = await profile.call('browser.context.capture', {
    profile_id: owner.profileId,
    owner_id: owner.ownerId,
    tab_id: 'tab-1',
    conversation_id: conversationId,
    capture_id: 'shot-1',
    selector: 'main h1',
  })
  expect(captured.context.id).toBe('shot-1')
  const browser = await capture(profile, conversationId, 'ctx-browser', {
    kind: 'browser_capture',
    capture_id: 'shot-1',
  })
  expect(browser.node).toMatchObject({
    kind: 'browser_capture',
    origin: 'browser_owner',
    provenance: { capture_id: 'shot-1', url: 'https://app.test/dashboard', title: 'Dashboard' },
  })
  expect(browser.node.attachments.map((attachment) => attachment.media_type)).toEqual(['image/png', 'text/plain'])
  expect(browser.previews.map((preview) => preview.text === null)).toEqual([true, false])
  expect(JSON.parse(browser.previews[1].text!)).toMatchObject({
    format: 'ade-design-context-v1',
    capture_id: 'shot-1',
    element: { tag: 'h1', text: 'Revenue' },
  })
  await owner.close()
  await expect(
    capture(profile, conversationId, 'ctx-browser-missing', { kind: 'browser_capture', capture_id: 'shot-2' }),
  ).rejects.toThrow('no finished browser capture with this ID')

  // Everything goes to Codex in one prompt: each text as prefix + preview, the screenshot as a data URL.
  const attachments = [terminal, log, browser].flatMap((reply) => reply.node.attachments)
  const plan = await profile.call('context.plan', { conversation_id: conversationId, text: 'fix it', attachments })
  expect(plan.parts.map((part) => part.form)).toEqual(['text_block', 'text_block', 'native_image', 'text_block'])
  await profile.call('agent.send', {
    conversation_id: conversationId,
    request_id: 'send-surfaces',
    text: 'fix it',
    attachments,
  })
  const [input] = (await waitForPrompts(profile, 'codex', 1)) as Array<Array<Record<string, string>>>
  const previews = [terminal, log, browser].flatMap((reply) => reply.previews)
  expect(input.slice(1)).toEqual(
    plan.parts.map((part, index) =>
      part.form === 'native_image'
        ? { type: 'image', url: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/) }
        : { type: 'text', text: `${part.text_prefix}${previews[index].text}` },
    ),
  )
})

test('F033: a repeated capture returns the recorded node without reading the source again, across a daemon crash', async ({
  profile,
  repo,
}) => {
  const { workspaceId, conversationId } = await codexOnRepo(profile, repo)
  const request = { kind: 'file_range', workspace_id: workspaceId, path: 'src/app.ts', start_line: 1, end_line: 2 }
  const first = await capture(profile, conversationId, 'ctx-once', request)
  // The file changes; the same request ID still returns what was captured.
  await repo.dirty('src/app.ts', 'rewritten\n')
  expect(await capture(profile, conversationId, 'ctx-once', request)).toEqual(first)
  await expect(capture(profile, conversationId, 'ctx-once', { ...request, end_line: 3 })).rejects.toThrow(
    'already used for a different capture',
  )

  await profile.restartDaemon('kill')
  expect(await profile.call('context.get', { conversation_id: conversationId, node_id: 'ctx-once' })).toEqual(first)
  const cli = await profile.cli('context', 'get', conversationId, 'ctx-once')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({
    node: { id: 'ctx-once', provenance: { start_line: 1, end_line: 2 } },
    available: true,
  })
  // The CLI captures under its own request ID and reads the file as it is now.
  const viaCli = await profile.cli(
    'context',
    'file',
    conversationId,
    'ctx-cli',
    workspaceId,
    'src/app.ts',
    '--lines',
    '1-1',
  )
  expect(viaCli.code, viaCli.stderr).toBe(0)
  expect(JSON.stringify(viaCli.json)).toContain('rewritten')
  expect(await codexInputs(profile)).toEqual([])
})

test('F033: captures are bounded, stay in their workspace, and report a reclaimed attachment as unavailable', async ({
  ade,
  profile,
  repo,
}) => {
  const { workspaceId, conversationId, terminalId } = await codexOnRepo(profile, repo)
  await expect(
    capture(profile, conversationId, 'ctx-long', {
      kind: 'file_range',
      workspace_id: workspaceId,
      path: 'src/app.ts',
      start_line: 1,
      end_line: 5001,
    }),
  ).rejects.toThrow('at most 5000 lines')
  await expect(
    capture(profile, conversationId, 'ctx-past', {
      kind: 'file_range',
      workspace_id: workspaceId,
      path: 'src/app.ts',
      start_line: 11,
      end_line: 12,
    }),
  ).rejects.toThrow('line 11 does not exist')
  await expect(
    capture(profile, conversationId, 'ctx-huge', {
      kind: 'terminal_output',
      workspace_id: workspaceId,
      terminal_id: terminalId,
      text: 'x'.repeat(1024 * 1024 + 1),
    }),
  ).rejects.toThrow('exceeds 1 MiB')

  // Over the 256 KiB body bound, a terminal capture keeps the newest lines and says so.
  const lines = Array.from({ length: 6000 }, (_, index) => `output ${index}`).join('\n')
  const bounded = await capture(profile, conversationId, 'ctx-bounded', {
    kind: 'terminal_output',
    workspace_id: workspaceId,
    terminal_id: terminalId,
    text: lines,
  })
  expect(bounded.node).toMatchObject({ truncated: true, omitted_lines: 1000 })
  expect(bounded.previews[0].text).toContain('output 5999\n')
  expect(bounded.previews[0].text).not.toContain('output 999\n')

  // Context comes only from the Conversation's own workspace.
  const other = await ade.repo({ name: 'other' })
  await writeFile(join(other.path, 'secret.txt'), 'other workspace\n')
  const otherWorkspace = (await profile.call('workspace.open', { path: other.path })).workspace.id
  await expect(
    capture(profile, conversationId, 'ctx-foreign', {
      kind: 'file_range',
      workspace_id: otherWorkspace,
      path: 'secret.txt',
      start_line: 1,
      end_line: 1,
    }),
  ).rejects.toThrow("Capture context from this Conversation's workspace")

  // Reclaiming the node's attachment makes it unavailable, and a send with it is refused.
  const node = await capture(profile, conversationId, 'ctx-reclaim', {
    kind: 'file_range',
    workspace_id: workspaceId,
    path: 'src/app.ts',
    start_line: 1,
    end_line: 1,
  })
  const attachment = node.node.attachments[0]
  const { preview } = await profile.call('attachment.reclaim.preview', {
    conversation_id: conversationId,
    attachment_id: attachment.id,
  })
  expect(preview.reclaimable).toBe(true)
  await profile.call('attachment.reclaim.apply', {
    conversation_id: conversationId,
    attachment_id: attachment.id,
    expected_generation: preview.generation,
  })
  expect(await profile.call('context.get', { conversation_id: conversationId, node_id: 'ctx-reclaim' })).toMatchObject({
    available: false,
    previews: [],
  })
  await expect(
    profile.call('agent.send', {
      conversation_id: conversationId,
      request_id: 'send-reclaimed',
      text: 'x',
      attachments: [attachment],
    }),
  ).rejects.toThrow(/Attachment is unavailable/)
  await expect(
    profile.call('context.plan', { conversation_id: conversationId, attachments: [attachment] }),
  ).rejects.toThrow(/Attachment/)
  expect((await snapshot(profile, conversationId)).messages).toEqual([])
})
