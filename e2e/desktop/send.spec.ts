// Sending a prompt through the desktop (daemon authority ticket 08): the renderer asks main
// (`ade:conversation-request`), and main runs it through the SDK's `SendPipeline` over the
// send journal in the app's user-data directory (`@ade/client/journals`,
// apps/desktop/src/main/conversations). The conversation surface and its composer are not
// built yet (tab content renders nothing for a conversation), so these specs call the same
// bridge method the composer will call, from the window's page.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, prompts, test, turnReply, waitForMessage, type ScratchProfile } from './fixtures'

type SendReply = { type: string; request_id?: string; reconciled?: boolean; message?: string }

async function startConversation(profile: ScratchProfile, title: string) {
  const { catalog } = await profile.call('catalog.get', {})
  const workspace = catalog.workspaces[0]!
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: 'codex',
    title,
  })
  return { workspace, conversationId: conversation.id }
}

/** A conversation request through the window's bridge; a refusal comes back as its message. */
function request(
  page: Page,
  op: 'draft.save' | 'agent.send' | 'agent.retry_send',
  fields: Record<string, string>,
): Promise<SendReply | { refused: string }> {
  return page.evaluate(
    ({ op, fields }) =>
      (
        window.adeHost.conversations.request as (
          op: string,
          fields: Record<string, string>,
        ) => Promise<{ type: string }>
      )(op, fields).then(
        (reply) => reply,
        (error: unknown) => ({ refused: String(error) }),
      ),
    { op, fields },
  )
}

/** Types a prompt into the window's draft, as the composer does before it sends. */
async function type(page: Page, conversationId: string, text: string): Promise<void> {
  expect(await request(page, 'draft.save', { conversation_id: conversationId, text })).toMatchObject({
    type: 'draft',
    draft: { text },
  })
}

/** The user messages the daemon holds for the conversation. */
async function userMessages(profile: ScratchProfile, conversationId: string): Promise<string[]> {
  const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
  return (messages as Array<{ role: string; text?: string }>)
    .filter((message) => message.role === 'user')
    .map((message) => message.text ?? '')
}

/** Turns the Codex mock started. */
async function turns(profile: ScratchProfile): Promise<number> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
}

/** The conversation's row in the navigator and its status mark. */
function conversationRow(page: Page, title: string) {
  return page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: title })
}

test('a prompt sent from the window starts one turn, and a repeat of it is not sent again', async ({
  profile,
  desktop,
}) => {
  const { conversationId } = await startConversation(profile, 'Desktop send')
  const { window: page } = await desktop.launch(profile)
  const row = conversationRow(page, 'Desktop send')
  await expect(row.getByRole('img', { name: 'Idle' })).toBeVisible()

  // `hold` keeps the mock's turn running, so the window shows it running.
  await type(page, conversationId, prompts.hold)
  const reply = await request(page, 'agent.send', {
    conversation_id: conversationId,
    request_id: 'desktop-send-1',
    text: prompts.hold,
  })
  expect(reply).toMatchObject({ type: 'ack' })
  await expect(row.getByRole('img', { name: 'Running' })).toBeVisible()
  expect(await userMessages(profile, conversationId)).toEqual([prompts.hold])

  // The same request again settles as the prompt already delivered; nothing is sent twice.
  expect(
    await request(page, 'agent.send', {
      conversation_id: conversationId,
      request_id: 'desktop-send-1',
      text: prompts.hold,
    }),
  ).toMatchObject({ type: 'ack', request_id: 'desktop-send-1', reconciled: true })
  expect(await request(page, 'agent.retry_send', { conversation_id: conversationId })).toEqual({
    refused: expect.stringContaining('No prompt is awaiting confirmation'),
  })
  expect(await userMessages(profile, conversationId)).toEqual([prompts.hold])
  expect(await turns(profile)).toBe(1)

  // Cancelling ends the turn, and the window stops showing it running.
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect(row.getByRole('img', { name: 'Running' })).toBeHidden()
})

test('while the daemon is down a prompt is refused, and after its restart it is delivered once', async ({
  profile,
  desktop,
}) => {
  const { conversationId } = await startConversation(profile, 'Daemon restart')
  const { window: page } = await desktop.launch(profile)
  const status = page.getByRole('contentinfo')
  await expect(status.getByRole('img', { name: 'Connected' })).toBeVisible()
  await expect(conversationRow(page, 'Daemon restart')).toBeVisible()

  await type(page, conversationId, 'hello')
  await profile.killDaemon()
  await expect(status.getByRole('img', { name: 'Connected' })).toBeHidden()
  const refused = await request(page, 'agent.send', {
    conversation_id: conversationId,
    request_id: 'desktop-send-down',
    text: 'hello',
  })
  expect(refused).toEqual({ refused: expect.stringContaining('Profile daemon is unavailable') })

  await profile.restartDaemon()
  await expect(status.getByRole('img', { name: 'Connected' })).toBeVisible()
  await expect(conversationRow(page, 'Daemon restart')).toBeVisible()
  expect(await userMessages(profile, conversationId)).toEqual([])

  expect(
    await request(page, 'agent.send', {
      conversation_id: conversationId,
      request_id: 'desktop-send-up',
      text: 'hello',
    }),
  ).toMatchObject({ type: 'ack' })
  await waitForMessage(profile, conversationId, turnReply.codex)
  expect(await userMessages(profile, conversationId)).toEqual(['hello'])
  expect(await turns(profile)).toBe(1)
})

test('a journaled prompt survives the app and the daemon dying, and a retry delivers it exactly once', async ({
  ade,
  profile,
  desktop,
}) => {
  const { conversationId } = await startConversation(profile, 'Journal recovery')
  const signal = join(ade.root, 'send-journaled')
  const release = join(ade.root, 'send-release')
  // Main pauses after the journal holds the prompt and before anything reaches the daemon.
  const paused = await desktop.launch(profile, {
    ADE_E2E_SEND_JOURNAL_PAUSE: '1',
    ADE_E2E_SEND_JOURNAL_SIGNAL: signal,
    ADE_E2E_SEND_JOURNAL_RELEASE: release,
  })
  await expect(conversationRow(paused.window, 'Journal recovery')).toBeVisible()
  await type(paused.window, conversationId, 'hello')
  void request(paused.window, 'agent.send', {
    conversation_id: conversationId,
    request_id: 'desktop-send-journal',
    text: 'hello',
  }).catch(() => undefined)
  await expect
    .poll(() =>
      access(signal).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true)

  // Both processes die with the prompt only in the journal.
  await profile.killDaemon()
  await desktop.kill(paused)
  await profile.restartDaemon()
  expect(await userMessages(profile, conversationId)).toEqual([])

  const { window: page } = await desktop.launch(profile)
  await expect(conversationRow(page, 'Journal recovery')).toBeVisible()
  // The prompt is listed as pending, and nothing delivered it on its own.
  const pending = await page.evaluate(() => window.adeHost.conversations.listPendingSends())
  expect(pending).toEqual([
    expect.objectContaining({ conversationId, requestId: 'desktop-send-journal', text: 'hello' }),
  ])
  expect(await turns(profile)).toBe(0)

  const retried = await request(page, 'agent.retry_send', { conversation_id: conversationId })
  expect(retried).toMatchObject({ type: 'ack' })
  await waitForMessage(profile, conversationId, turnReply.codex)
  expect(await request(page, 'agent.retry_send', { conversation_id: conversationId })).toEqual({
    refused: expect.stringContaining('No prompt is awaiting confirmation'),
  })
  expect(await page.evaluate(() => window.adeHost.conversations.listPendingSends())).toEqual([])
  expect(await userMessages(profile, conversationId)).toEqual(['hello'])
  expect(await turns(profile)).toBe(1)
})
