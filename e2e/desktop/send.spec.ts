// Bridge tests exercise durable submission and reconciliation over desktop IPC; the composer scenario uses the real editor control.
import { access, readFile, realpath, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, prompts, test, turnReply, waitForIdle, waitForMessage, type ScratchProfile } from './fixtures'
import { binaries, repositoryRoot } from '../protocol/fixtures/environment'
import { isRunning } from '../protocol/fixtures/processes'

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

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
async function request(
  page: Page,
  op: 'draft.save' | 'agent.send' | 'agent.retry_send',
  fields: Record<string, string>,
): Promise<SendReply | { refused: string }> {
  // Requests carry the rendered view's tab ID; a re-render must not leave it empty.
  if (fields.conversation_id)
    await expect(page.locator(`[data-conversation-id="${fields.conversation_id}"][data-tab-id]`).first()).toBeVisible()
  return page.evaluate(
    ({ op, fields }) =>
      (
        window.adeHost.conversations.request as (
          op: string,
          fields: Record<string, string>,
        ) => Promise<{ type: string }>
      )(op, {
        ...fields,
        view_id:
          Array.from(document.querySelectorAll('[data-conversation-id][data-tab-id]'))
            .find((view) => view.getClientRects().length > 0)
            ?.getAttribute('data-tab-id') ?? '',
      }).then(
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
  await row.click()
  const view = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view).toBeVisible()
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

  // Running includes provider startup; wait for native dispatch before checking replay.
  await expect.poll(() => turns(profile)).toBe(1)

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

  const live = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  expect(live.runtime_run).toBeTruthy()
  expect(live.runtime_submission).toBeTruthy()
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  // The window shows the daemon's Stop record: confirmed only by the native terminal event.
  const stopStatus = view.getByRole('status', { name: 'Stop status' })
  await expect(stopStatus).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect(stopStatus).toContainText('The provider reported the turn ended (interrupted).')
  const settled = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  expect(settled.stop).toMatchObject({
    source_attempt_id: live.runtime_run,
    submission_id: live.runtime_submission,
    outcome: 'confirmed',
    confirmation: 'native_terminal',
  })
  await expect(view.getByRole('button', { name: 'Stop current turn' })).toHaveCount(0)
})

test('an unconfirmed Stop stays unresolved in the window until termination ends the provider process', async ({
  ade,
  desktop,
}, testInfo) => {
  const profile = await ade.profile({ env: { ADE_E2E_STOP_SETTLE_MS: '1500' } })
  const { conversationId } = await startConversation(profile, 'Unconfirmed stop')
  const { window: page } = await desktop.launch(profile)
  await conversationRow(page, 'Unconfirmed stop').click()
  const view = page.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view).toBeVisible()
  await type(page, conversationId, prompts.hold)
  expect(
    await request(page, 'agent.send', { conversation_id: conversationId, request_id: 'held', text: prompts.hold }),
  ).toMatchObject({ type: 'ack' })
  await expect.poll(() => turns(profile)).toBe(1)
  const provider = (await profile.mockCalls('codex')).at(-1)!.pid
  // The provider acknowledges the interrupt but never reports the turn ending.
  await profile.releaseMock('codex', 'defer-interrupt')
  await view.getByRole('button', { name: 'Stop current turn' }).click()
  const stopStatus = view.getByRole('status', { name: 'Stop status' })
  await expect(stopStatus).toHaveAttribute('data-stop-outcome', 'unresolved')
  await expect(stopStatus).toContainText('Stop unresolved')
  await expect(stopStatus).toContainText('did not report the turn ending')
  await expect(stopStatus).not.toContainText(/^Stopped/)
  await testInfo.attach('stop-unresolved.png', { body: await page.screenshot(), contentType: 'image/png' })

  await view.getByRole('button', { name: 'Terminate provider process' }).click()
  await expect(stopStatus).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect(stopStatus).toContainText('The provider process ended.')
  await expect(stopStatus).toContainText('may still be running')
  await testInfo.attach('stop-terminated.png', { body: await page.screenshot(), contentType: 'image/png' })
  await expect.poll(() => isRunning(provider)).toBe(false)
})
test('two live conversation views fence conflicting drafts and recover only the listed stash revision', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { conversationId } = await startConversation(profile, 'Cross-view draft conflict')
  const signal = join(ade.root, 'cross-view-send-paused')
  const release = join(ade.root, 'cross-view-send-release')
  const running = await desktop.launch(profile, {
    ADE_E2E_SEND_JOURNAL_PAUSE: '1',
    ADE_E2E_SEND_JOURNAL_SIGNAL: signal,
    ADE_E2E_SEND_JOURNAL_RELEASE: release,
  })
  const page = running.window
  await conversationRow(page, 'Cross-view draft conflict').click()
  const views = page.locator(`[data-conversation-id="${conversationId}"][data-tab-id]`)
  await expect(views).toHaveCount(1)
  const firstTabId = await views.getAttribute('data-tab-id')
  expect(firstTabId).toBeTruthy()
  const firstView = page.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${firstTabId}"]`)
  await firstView.getByRole('button', { name: 'Open in another tab' }).click()
  const tabs = page.locator('[role="tab"][data-tab-id]')
  await expect(tabs).toHaveCount(2)
  const tabIds = await tabs.evaluateAll((items) => items.map((item) => item.getAttribute('data-tab-id')))
  const secondTabId = tabIds.find((tabId) => tabId !== firstTabId)
  expect(secondTabId).toBeTruthy()
  expect(new Set(tabIds).size).toBe(2)
  const firstTab = page.locator(`[role="tab"][data-tab-id="${firstTabId}"]`)
  const secondTab = page.locator(`[role="tab"][data-tab-id="${secondTabId}"]`)
  const secondView = page.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${secondTabId}"]`)
  await secondTab.click()
  await expect(secondView).toBeVisible()
  const secondComposer = secondView.getByRole('form', { name: 'Prompt composer' })
  const secondPrompt = secondComposer.getByRole('textbox', { name: 'Prompt' })
  await expect(secondPrompt).toBeEditable()
  await firstTab.click()
  await expect(firstView).toBeVisible()
  const firstComposer = firstView.getByRole('form', { name: 'Prompt composer' })
  const firstPrompt = firstComposer.getByRole('textbox', { name: 'Prompt' })
  await expect(firstPrompt).toBeEditable()

  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  const readServerDraft = async () =>
    (await profile.call('draft.get', { conversation_id: conversationId, window_id: ownerId })).draft
  await firstPrompt.fill('hello')
  await expect.poll(async () => (await readServerDraft()).text).toBe('hello')

  // The second tab loaded its own draft entry before the first tab changed the daemon revision.
  await secondTab.click()
  await expect(secondPrompt).toHaveText('')
  const conflictingDraft = 'second view draft survives a revision conflict'
  await secondPrompt.pressSequentially(conflictingDraft)
  await expect
    .poll(async () => {
      const [local, draft, listed] = await Promise.all([
        page.evaluate(
          ({ conversationId, viewId }) =>
            window.adeHost.conversations.request('draft.get', { conversation_id: conversationId, view_id: viewId }),
          { conversationId, viewId: secondTabId! },
        ),
        readServerDraft(),
        profile.call('draft.stash.list', { conversation_id: conversationId }),
      ])
      return {
        localDraft: local.draft.text,
        localError: local.error,
        draftText: draft.text,
        stashTexts: listed.stashes.map((stash) => stash.text),
      }
    })
    .toEqual({
      localDraft: conflictingDraft,
      // The conflict is reported, and the second view's text is kept as a recovery copy.
      localError: 'Draft revision changed or could not be confirmed; its text and context are saved for recovery',
      draftText: 'hello',
      stashTexts: [conflictingDraft],
    })
  await expect(secondPrompt).toHaveText(conflictingDraft)
  await expect(secondView.getByText(/Draft revision changed/)).toBeVisible()

  // Hold the first actual UI send between its durable journal write and daemon dispatch.
  await firstTab.click()
  await expect(firstPrompt).toHaveText('hello')
  void firstComposer.getByRole('button', { name: 'Send prompt' }).click()
  await expect
    .poll(() =>
      access(signal).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true)
  let pendingAfterCompetingSend: unknown
  try {
    await secondTab.click()
    await secondComposer.getByRole('button', { name: 'Send prompt' }).click()
    const pending = await page.evaluate(() => window.adeHost.conversations.listPendingSends())
    pendingAfterCompetingSend = pending
    expect(pending).toEqual([expect.objectContaining({ conversationId, text: 'hello' })])
    expect(await userMessages(profile, conversationId)).toEqual([])
    expect(await turns(profile)).toBe(0)
    await expect(secondPrompt).toHaveText(conflictingDraft)
  } finally {
    await writeFile(release, 'release')
  }

  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  expect(await userMessages(profile, conversationId)).toEqual(['hello'])
  expect(await turns(profile)).toBe(1)
  expect(await page.evaluate(() => window.adeHost.conversations.listPendingSends())).toEqual([])

  await firstTab.click()
  await expect(firstPrompt).toHaveText('')
  const currentDraft = 'current first-view draft stays during stale recovery'
  await firstPrompt.fill(currentDraft)
  await expect.poll(async () => (await readServerDraft()).text).toBe(currentDraft)
  await firstComposer.getByRole('button', { name: 'Recover saved draft' }).click()
  const listed = await profile.call('draft.stash.list', { conversation_id: conversationId })
  const listedStash = listed.stashes.find((stash) => stash.text === conflictingDraft)
  expect(listedStash).toBeDefined()
  await expect(firstComposer.getByRole('region', { name: 'Saved draft recovery copies' })).toContainText(
    conflictingDraft,
  )

  const revisedStashText = conflictingDraft + ' (revised externally)'
  const revised = await profile.call('draft.stash.save', {
    conversation_id: conversationId,
    window_id: ownerId,
    name: listedStash!.name,
    expected_revision: listedStash!.revision,
    text: revisedStashText,
    attachments: listedStash!.attachments,
    context_nodes: listedStash!.context_nodes,
  })
  expect(revised.outcome).toBe('replaced')
  expect(revised.stash.revision).toBeGreaterThan(listedStash!.revision)
  await firstComposer.getByRole('button', { name: 'Restore draft 1' }).click()
  await expect(firstComposer.getByText(/Could not restore the saved draft. Saved draft recovery changed/)).toBeVisible()
  expect(await readServerDraft()).toMatchObject({ text: currentDraft })
  await expect(firstPrompt).toHaveText(currentDraft)

  await firstComposer.getByRole('button', { name: 'Recover saved draft' }).click()
  await expect(firstComposer.getByRole('region', { name: 'Saved draft recovery copies' })).toContainText(
    revisedStashText,
  )
  await firstComposer.getByRole('button', { name: 'Restore draft 1' }).click()
  await expect.poll(async () => (await readServerDraft()).text).toBe(revisedStashText)
  await expect(firstPrompt).toHaveText(revisedStashText)
  const stashAfterRestore = await profile.call('draft.stash.list', { conversation_id: conversationId })
  expect(stashAfterRestore.stashes.some((stash) => stash.text === revisedStashText)).toBe(true)
  await secondTab.click()
  await expect(secondPrompt).toHaveText(conflictingDraft)

  await testInfo.attach('cross-view-draft-conflict.json', {
    body: JSON.stringify(
      {
        conversationId,
        viewIds: tabIds,
        pendingAfterCompetingSend,
        userMessages: await userMessages(profile, conversationId),
        turnStartCount: await turns(profile),
        draftAfterRecovery: await readServerDraft(),
        initialStash: listedStash,
        revisedStash: revised.stash,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('an admitted intent reconciles after Electron restarts without starting another provider turn', async ({
  profile,
  desktop,
}, testInfo) => {
  const { conversationId } = await startConversation(profile, 'Admitted intent restart')
  const firstLaunch = await desktop.launch(profile)
  const page = firstLaunch.window
  await conversationRow(page, 'Admitted intent restart').click()
  const originalView = page.locator(`[data-conversation-id="${conversationId}"][data-tab-id]`)
  await expect(originalView).toHaveCount(1)
  const firstTabId = await originalView.getAttribute('data-tab-id')
  expect(firstTabId).toBeTruthy()
  await originalView.getByRole('button', { name: 'Open in another tab' }).click()
  const tabs = page.locator('[role="tab"][data-tab-id]')
  await expect(tabs).toHaveCount(2)
  const originalTabIds = await tabs.evaluateAll((items) => items.map((item) => item.getAttribute('data-tab-id')))
  const secondTabId = originalTabIds.find((tabId) => tabId !== firstTabId)
  expect(secondTabId).toBeTruthy()
  const firstTab = page.locator(`[role="tab"][data-tab-id="${firstTabId}"]`)
  const secondTab = page.locator(`[role="tab"][data-tab-id="${secondTabId}"]`)
  await secondTab.click()
  await expect(page.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${secondTabId}"]`)).toBeVisible()
  await firstTab.click()

  const ownerId = (JSON.parse(await readFile(join(desktop.userData, 'window-owner-v1.json'), 'utf8')) as { id: string })
    .id
  const text = prompts.hold
  const requestId = 'desktop-admitted-restart'
  const saved = await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: ownerId,
    expected_revision: 0,
    revision: 1,
    text,
    attachments: [],
    context_nodes: [],
  })
  expect(saved.draft).toMatchObject({ revision: 1, text })
  const prepared = await profile.call('draft.send.prepare', {
    conversation_id: conversationId,
    window_id: ownerId,
    request_id: requestId,
    draft_text: text,
    revision: 1,
    text,
    attachments: [],
    context_nodes: [],
  })
  expect(prepared.intent).toMatchObject({ request_id: requestId, context_nodes: [], state: 'pending' })
  const dispatched = await profile.call('agent.send', {
    conversation_id: conversationId,
    request_id: requestId,
    text,
    attachments: [],
  })
  expect(dispatched).toMatchObject({ type: 'ack' })
  await expect.poll(() => userMessages(profile, conversationId)).toEqual([text])
  await expect.poll(() => turns(profile)).toBe(1)
  const admittedBeforeRestart = await profile.call('draft.send.list', { window_id: ownerId, limit: 200 })
  expect(admittedBeforeRestart.sends).toEqual([
    expect.objectContaining({ intent: expect.objectContaining({ request_id: requestId, context_nodes: [] }) }),
  ])

  await desktop.kill(firstLaunch)
  const restarted = await desktop.launch(profile)
  const reopened = restarted.window
  await expect(conversationRow(reopened, 'Admitted intent restart')).toBeVisible()
  const reopenedTabs = reopened.locator('[role="tab"][data-tab-id]')
  await expect(reopenedTabs).toHaveCount(2)
  const reopenedIds = await reopenedTabs.evaluateAll((items) => items.map((item) => item.getAttribute('data-tab-id')))
  expect(new Set(reopenedIds)).toEqual(new Set(originalTabIds))
  const reopenedFirstTab = reopened.locator(`[role="tab"][data-tab-id="${firstTabId}"]`)
  await reopenedFirstTab.click()
  const reopenedView = reopened.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${firstTabId}"]`)
  await expect(reopenedView).toBeVisible()
  // The native agent already accepted the prompt, so the restored intent settles from that
  // evidence under its own request ID: no Reconcile action is needed and no turn starts again.
  const composer = reopenedView.getByRole('form', { name: 'Prompt composer' })
  await expect(composer.getByRole('button', { name: 'Reconcile delivery' })).toHaveCount(0)
  await expect
    .poll(async () => (await reopened.evaluate(() => window.adeHost.conversations.listPendingSends())).length)
    .toBe(0)
  expect(await userMessages(profile, conversationId)).toEqual([text])
  expect(await turns(profile)).toBe(1)
  expect((await profile.call('draft.send.list', { window_id: ownerId, limit: 200 })).sends).toEqual([])

  await testInfo.attach('admitted-intent-restart.json', {
    body: JSON.stringify(
      {
        conversationId,
        requestId,
        viewIds: reopenedIds,
        admittedBeforeRestart,
        userMessages: await userMessages(profile, conversationId),
        turnStartCount: await turns(profile),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
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

  await conversationRow(page, 'Daemon restart').click()
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
  await conversationRow(paused.window, 'Journal recovery').click()
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
  await conversationRow(page, 'Journal recovery').click()
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
test('the prompt composer renders public reasoning, bounded tool output, and a safe unknown item', async ({
  profile,
  desktop,
}, testInfo) => {
  const { conversationId } = await startConversation(profile, 'Composer native events')
  const runningDesktop = await desktop.launch(profile)
  const { window: page } = runningDesktop
  await conversationRow(page, 'Composer native events').click()
  const composer = page.getByRole('form', { name: 'Prompt composer' })
  const sendButton = composer.getByRole('button', { name: 'Send prompt' })
  const prompt = page.getByRole('textbox', { name: 'Prompt' })
  await expect(page.getByText('Restoring saved prompt…')).toBeHidden()
  await expect(prompt).toBeEditable()
  await expect(sendButton).toBeDisabled()
  await prompt.pressSequentially('   ')
  expect(await prompt.evaluate((element) => element.textContent ?? '')).toMatch(/^\s+$/)
  await expect(sendButton).toBeDisabled()
  await prompt.press('ControlOrMeta+A')
  await prompt.press('Backspace')
  await expect(prompt).toHaveText('')
  await expect(sendButton).toBeDisabled()
  await prompt.pressSequentially('typed-summary-large-tool')
  await expect(prompt).toContainText('typed-summary-large-tool')
  await expect(sendButton).toBeEnabled()
  const enabledComposerScreenshot = testInfo.outputPath('composer-enabled.png')
  await page.screenshot({ path: enabledComposerScreenshot, fullPage: true })
  await testInfo.attach('composer-enabled.png', { path: enabledComposerScreenshot, contentType: 'image/png' })
  await prompt.press('Enter')
  await waitForMessage(profile, conversationId, turnReply.codex)
  await waitForIdle(profile, conversationId)
  await expect(page.getByText('Hello world', { exact: true })).toBeVisible()

  const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
  const user = messages.find((message) => message.role === 'user' && message.text === 'typed-summary-large-tool')!
  expect(user.delivery).toMatchObject({ admitted: true, native_outcome: 'accepted', request_id: expect.any(String) })
  const requestId = user.delivery!.request_id!
  const reasoning = messages.find((message) => message.provider_item_id === 'public-reasoning-' + requestId)!
  expect(reasoning).toMatchObject({
    provider_item_id: 'public-reasoning-' + requestId,
    kind: 'reasoning',
    status: 'completed',
    text: 'Checking the fixture command before answering.',
  })
  const tool = messages.find((message) => message.provider_item_id === 'command-' + requestId)!
  expect(tool).toMatchObject({
    provider_item_id: 'command-' + requestId,
    kind: 'commandExecution',
    role: 'tool',
    status: 'failed',
  })
  expect(tool.text).toContain('fixture failure')
  expect(tool.text).toContain('TOOL_OUTPUT_TAIL_SENTINEL')
  const unknown = messages.find((message) => message.kind === 'futurePreview')!
  expect(unknown.text).toContain('futurePreview')
  expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_REASONING|PRIVATE_DELTA_REASONING|PRIVATE_NATIVE_PAYLOAD/)

  const reasoningRow = page.locator('[data-message-id="' + reasoning.id + '"]')
  await expect(reasoningRow).toContainText('Checking the fixture command before answering.')
  const toolSummary = page.locator('[data-kind="tool-summary"]')
  await expect(toolSummary).toContainText('fixture command')
  await expect(toolSummary).toContainText('fixture failure')
  await expect(toolSummary).toContainText('Call ' + tool.provider_item_id)
  await expect(toolSummary).toContainText('Failed')
  await expect(toolSummary).toContainText('excerpt (bounded; full output not shown)')
  await expect(toolSummary).not.toContainText('TOOL_OUTPUT_TAIL_SENTINEL')
  const unknownRow = page.locator('[data-message-id="' + unknown.id + '"]')
  await expect(unknownRow).toContainText('futurePreview')
  await expect(unknownRow.locator('[data-kind="tool-summary"]')).toHaveCount(0)
  await expect(unknownRow.getByRole('status')).toHaveCount(0)
  expect(await page.getByText('PRIVATE_REASONING').count()).toBe(0)
  expect(await page.getByText('PRIVATE_DELTA_REASONING').count()).toBe(0)
  expect(await page.getByText('PRIVATE_NATIVE_PAYLOAD').count()).toBe(0)
  const outputScreenshot = testInfo.outputPath('codex-output-tool-native-status.png')
  await page.screenshot({ path: outputScreenshot, fullPage: true })
  await testInfo.attach('codex-output-tool-native-status.png', { path: outputScreenshot, contentType: 'image/png' })

  const calls = await profile.mockCalls('codex')
  const starts = calls.filter((call) => call.method === 'turn/start')
  expect(starts).toHaveLength(1)
  expect((starts[0]!.params as { clientUserMessageId: string }).clientUserMessageId).toBe(requestId)
  const peerScript = profile.env.ADE_CODEX_BIN!
  const pythonIdentity = execFileSync(
    'python3',
    ['-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'],
    {
      encoding: 'utf8',
      env: profile.env,
    },
  )
    .trim()
    .split(/\r?\n/)
  const electronPath = runningDesktop.app.process().spawnfile
  const peerReport = {
    provider: 'Codex deterministic fixture; not installed Codex',
    transport: profile.env.ADE_CODEX_TRANSPORT,
    peerScript: {
      path: relative(repositoryRoot, peerScript),
      realpath: await realpath(peerScript),
      sha256: await sha256(peerScript),
    },
    interpreter: { path: pythonIdentity[0], version: pythonIdentity[1] },
    executables: [
      { name: 'ade-daemon', path: binaries.daemon, pid: profile.hello.pid, sha256: await sha256(binaries.daemon) },
      {
        name: 'ade-runtime',
        path: binaries.runtime,
        pid: profile.hello.runtime_pid,
        instance: profile.hello.runtime_instance,
        sha256: await sha256(binaries.runtime),
      },
      {
        name: 'Electron',
        path: electronPath,
        pid: runningDesktop.app.process().pid,
        sha256: await sha256(electronPath),
      },
    ],
    requestId,
    turnStartCount: starts.length,
    rpcMethodCounts: calls.reduce<Record<string, number>>((counts, call) => {
      counts[call.method] = (counts[call.method] ?? 0) + 1
      return counts
    }, {}),
    requestIds: starts.map((call) => (call.params as { clientUserMessageId: string }).clientUserMessageId),
    conversationItems: messages.map(({ id, provider_item_id, kind, role, status }) => ({
      id,
      provider_item_id,
      kind,
      role,
      status,
    })),
  }
  await testInfo.attach('codex-native-peer-report.json', {
    body: JSON.stringify(peerReport, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('codex-native-peer-script.py', {
    body: await readFile(peerScript),
    contentType: 'text/x-python',
  })
})
