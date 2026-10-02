import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { codexMessage, codexRollout } from '../protocol/fixtures/native-sessions'
import { installAndEnable, stagePlugin } from '../protocol/fixtures/plugins'
import { mockDirectory } from '../protocol/fixtures/providers'
import {
  cancellationIntent,
  expect,
  prompts,
  send,
  test,
  waitForIdle,
  waitForMessage,
  type ScratchProfile,
} from './fixtures'

async function readClientState(page: Page) {
  return page.evaluate(() => window.adeHost.profiles.getClientState())
}

async function attachClientState(page: Page, testInfo: TestInfo, name = 'daemon-client-state.json') {
  await page
    .waitForFunction(
      async () => {
        const { status } = await window.adeHost.profiles.getClientState()
        return status !== 'connecting' && status !== 'reconnecting'
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined)

  const state = await readClientState(page)
  await testInfo.attach(name, {
    body: JSON.stringify(
      { status: state.status, detail: state.detail, bootId: state.bootId, revision: state.revision },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  return state
}

async function startConversation(profile: ScratchProfile, title: string): Promise<string> {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title,
  })
  return conversation.id
}

async function sendHeldPrompt(page: Page): Promise<void> {
  const composer = page.getByRole('form', { name: 'Prompt composer' })
  const prompt = page.getByRole('textbox', { name: 'Prompt' })
  await expect(page.getByText('Restoring saved prompt…')).toBeHidden()
  await expect(prompt).toBeEditable()
  await prompt.pressSequentially(prompts.hold)
  await expect(prompt).toContainText(prompts.hold)
  const sendButton = composer.getByRole('button', { name: 'Send prompt' })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(page.getByText(prompts.hold, { exact: true })).toBeVisible()
}
test('opening another view keeps one retained conversation and closing one leaves its native turn running', async ({
  profile,
  desktop,
}, testInfo) => {
  const conversationId = await startConversation(profile, 'Conversation views')
  const { window } = await desktop.launch(profile)
  const initialState = await attachClientState(window, testInfo)
  const initialSnapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(initialState.status).toBe('connected')
  expect(initialState.catalog?.conversations.find((item) => item.id === conversationId)?.execution_host).toEqual(
    initialSnapshot.conversation.execution_host,
  )
  const initialRevision = initialState.revision ?? 0
  // Reopening the existing workspace emits a catalog_changed frame without changing its identity.
  await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  try {
    await expect
      .poll(async () => {
        const state = await readClientState(window)
        return state.revision ?? -1
      })
      .toBeGreaterThan(initialRevision)
  } finally {
    await attachClientState(window, testInfo, 'daemon-client-state-after-catalog-change.json')
  }
  const changedState = await readClientState(window)
  expect(changedState.status).toBe('connected')
  expect(changedState.catalog?.conversations.find((item) => item.id === conversationId)?.execution_host).toEqual(
    initialSnapshot.conversation.execution_host,
  )
  const row = window.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Conversation views' })
  await expect(row).toBeVisible()
  await row.click()
  await sendHeldPrompt(window)
  await expect(row.getByRole('img', { name: 'Running' })).toBeVisible()
  await expect
    .poll(async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length)
    .toBe(1)
  const admitted = (await profile.call('conversation.get', { conversation_id: conversationId })).messages.find(
    (message) => message.role === 'user' && message.text === prompts.hold,
  )!
  expect(admitted.delivery).toMatchObject({ request_id: expect.any(String), admitted: true })
  const start = (await profile.mockCalls('codex')).find((call) => call.method === 'turn/start')!
  expect((start.params as { clientUserMessageId: string }).clientUserMessageId).toBe(admitted.delivery!.request_id)
  await expect(window.getByText(prompts.hold, { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Open in another tab' }).press('Enter')
  const tabs = window.locator('[role="tab"][data-tab-id]')
  const views = window.locator('[data-conversation-id][data-tab-id]')
  await expect(tabs).toHaveCount(2)
  await expect(views).toHaveCount(1)
  const tabIds = await tabs.evaluateAll((items) => items.map((item) => item.getAttribute('data-tab-id')))
  expect(new Set(tabIds).size).toBe(2)
  await expect(views).toHaveAttribute('data-conversation-id', conversationId)

  const firstTab = window.locator(`[role="tab"][data-tab-id="${tabIds[0]}"]`)
  await firstTab.hover()
  await firstTab.getByRole('button', { name: 'Close tab' }).click()
  await expect(tabs).toHaveCount(1)
  await expect(views).toHaveCount(1)
  await expect(views.first()).toHaveAttribute('data-conversation-id', conversationId)
  await expect(row.getByRole('img', { name: 'Running' })).toBeVisible()
  await expect
    .poll(async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length)
    .toBe(1)

  await profile.call('agent.cancel', await cancellationIntent(profile, conversationId))
  await expect(row.getByRole('img', { name: 'Running' })).toBeHidden()
  const [snapshot, nativeCalls] = await Promise.all([
    profile.call('conversation.get', { conversation_id: conversationId }),
    profile.mockCalls('codex'),
  ])
  await testInfo.attach('native-turn-report.json', {
    body: JSON.stringify({ snapshot, nativeCalls }, null, 2),
    contentType: 'application/json',
  })
})

test('workspace context, tool envelopes, and rendered history agree with SDK and CLI inspection', async ({
  profile,
  desktop,
}, testInfo) => {
  const workspacePath = profile.defaultWorkspaceRoot
  const { workspace } = await profile.call('workspace.open', { path: workspacePath })
  const nativeId = '01a076ee-e1bb-71a1-9a20-d12ac6dc30ea'
  const callId = 'conversation-view-tool-call'
  const retainedHistory = Array.from({ length: 40 }, (_, index) =>
    codexMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `Retained transcript entry ${index}\n${'context line '.repeat(80)}`,
      index + 3,
    ),
  )
  const native = await codexRollout(profile.home, nativeId, workspacePath, [
    ...retainedHistory,
    codexMessage('user', 'Why does the conversation retain tool results?', 43),
    {
      timestamp: '2026-09-06T13:36:44.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'git status --short' }),
        call_id: callId,
      },
    },
    {
      timestamp: '2026-09-06T13:36:45.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: callId, output: '## main' },
    },
    codexMessage('assistant', 'The retained record includes the tool result.', 46),
  ])
  const imported = await profile.call('history.import.session', {
    provider: 'codex',
    native_session_id: nativeId,
    workspace_id: workspace.id,
  })
  const conversationId = imported.conversation.provenance.conversation_id
  await native.append(
    Array.from({ length: 64 }, (_, index) => {
      const text = 'Unmatched native source observation ' + (44 + index)
      return {
        timestamp: new Date(Date.UTC(2026, 8, 6, 13, 36, 47 + index)).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      }
    }),
  )
  const providerRoot = mockDirectory(profile.root, 'codex')
  await mkdir(providerRoot, { recursive: true })
  const updatedAt = 1_780_000_000
  await writeFile(
    join(providerRoot, 'history-mode.json'),
    JSON.stringify({ historyMode: 'legacy', path: native.path, updatedAt }),
  )
  await writeFile(
    join(providerRoot, nativeId + '.json'),
    JSON.stringify({
      id: nativeId,
      turns: [],
      updatedAt,
      historyMode: 'legacy',
      path: native.path,
    }),
  )
  const sdk = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(sdk.messages).toHaveLength(32)
  expect(sdk.messages[0]!.text).toContain('Retained transcript entry 11')
  const cli = await profile.cli('conversation', 'inspect', conversationId)
  expect(cli.code).toBe(0)
  expect(cli.json?.conversation).toMatchObject({
    id: sdk.conversation.id,
    workspace_id: sdk.conversation.workspace_id,
    provider: sdk.conversation.provider,
    account_context: sdk.conversation.account_context,
    execution_host: sdk.conversation.execution_host,
  })
  expect(cli.json?.messages).toEqual(sdk.messages)
  await testInfo.attach('conversation-inspection.json', {
    body: JSON.stringify({ command: ['conversation', 'inspect', conversationId], sdk, cli: cli.json }, null, 2),
    contentType: 'application/json',
  })

  const toolMessages = sdk.messages.filter((message) => {
    const content = message.content
    return (
      !!content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).type === 'tool'
    )
  })
  expect(toolMessages).toHaveLength(1)
  const toolMessage = toolMessages[0]!
  const tool = toolMessage.content as Record<string, unknown>
  expect(tool.name).toBe('exec_command')
  expect(tool.call_id).toBe(callId)
  expect(tool.input).toEqual({ cmd: 'git status --short' })
  expect(tool.output).toBe('## main')
  expect(tool.is_error).toBe(false)
  expect(toolMessage.status).toBe('completed')

  const { window: desktopPage } = await desktop.launch(profile)
  await attachClientState(desktopPage, testInfo)
  const unbounded = await desktopPage.evaluate(
    (id) => window.adeHost.conversations.request('conversation.get', { conversation_id: id }),
    conversationId,
  )
  expect(unbounded.messages).toHaveLength(32)
  const before = sdk.messages[16]!.sequence
  const cursorPage = await desktopPage.evaluate(
    ({ id, before, historyEpoch }) =>
      window.adeHost.conversations.request('conversation.get', {
        conversation_id: id,
        before,
        history_epoch: historyEpoch,
        limit: 4,
      }),
    { id: conversationId, before, historyEpoch: sdk.history_epoch },
  )
  expect(cursorPage.history_epoch).toBe(sdk.history_epoch)
  expect(cursorPage.messages).toHaveLength(4)
  expect(cursorPage.messages.every((message) => message.sequence < before)).toBe(true)
  const firstNativePage = await desktopPage.evaluate(
    ({ id, historyEpoch }) =>
      window.adeHost.conversations.request('conversation.history', {
        conversation_id: id,
        history_epoch: historyEpoch,
        max_items: 32,
        max_bytes: 512 * 1024,
      }),
    { id: conversationId, historyEpoch: sdk.history_epoch },
  )
  expect(firstNativePage.messages).toHaveLength(32)
  expect(firstNativePage.messages[0]!.text).toContain('Retained transcript entry 0')
  expect(firstNativePage.complete).toBe(false)
  const secondNativePage = await desktopPage.evaluate(
    ({ id, historyEpoch, snapshot, nativeCursor }) =>
      window.adeHost.conversations.request('conversation.history', {
        conversation_id: id,
        history_epoch: historyEpoch,
        snapshot,
        native_cursor: nativeCursor,
        max_items: 32,
        max_bytes: 512 * 1024,
      }),
    {
      id: conversationId,
      historyEpoch: firstNativePage.history_epoch,
      snapshot: firstNativePage.snapshot,
      nativeCursor: firstNativePage.next_native_cursor,
    },
  )
  expect(secondNativePage.messages).toHaveLength(32)
  expect(secondNativePage.complete).toBe(false)
  expect(secondNativePage.snapshot).toEqual(firstNativePage.snapshot)
  expect(secondNativePage.messages.some((message) => message.sequence > 0)).toBe(true)
  expect(secondNativePage.messages.some((message) => message.sequence === 0)).toBe(true)
  expect(secondNativePage.messages.some((message) => message.text === 'Unmatched native source observation 44')).toBe(
    true,
  )
  expect(secondNativePage.messages.at(-1)!.text).toBe('Unmatched native source observation 63')
  const row = desktopPage.getByRole('list', { name: 'Projects' }).getByRole('button', { name: sdk.conversation.title })
  await row.click()
  const view = desktopPage.locator('[data-conversation-id="' + conversationId + '"]')
  const nativeEvidence = view.getByRole('region', { name: 'Native history evidence' })
  await expect(nativeEvidence).toBeVisible()
  await expect(nativeEvidence.getByText('Retained transcript entry 0')).toBeVisible()
  await expect(view.getByRole('region', { name: 'Current ADE evidence' })).toBeVisible()
  const currentViewport = view.locator('[aria-label="Current ADE messages"] [data-slot="scroll-area-viewport"]')
  await currentViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const renderedTool = view.locator('[data-message-id="' + toolMessage!.id + '"]')
  await expect(renderedTool).toBeVisible()
  const summary = renderedTool.locator('[data-kind="tool-summary"]')
  await expect(summary).toContainText('## main')
  await expect(summary).toContainText(tool.name as string)
  await expect(summary).toContainText(callId)
  await expect(summary).toContainText('git status --short')
  await expect(summary).toContainText(tool.output as string)
  await expect(summary.getByRole('status')).toHaveText('Completed')
  await expect(summary).toContainText('Output')
  const sourceScreenshot = testInfo.outputPath('native-and-ADE-evidence.png')
  await desktopPage.screenshot({ path: sourceScreenshot, fullPage: true })
  await testInfo.attach('native-and-ADE-evidence.png', { path: sourceScreenshot, contentType: 'image/png' })
  const nativeViewport = view.locator('[aria-label="Native history messages"] [data-slot="scroll-area-viewport"]')
  const loadMoreHistory = view.getByRole('button', { name: 'Load more native history' })
  await loadMoreHistory.click()
  await expect(view.getByRole('button', { name: 'Loading more native history…' })).toBeVisible()
  await expect(loadMoreHistory).toBeVisible()
  await nativeViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(nativeViewport.getByText('Unmatched native source observation 63')).toBeVisible()
  await expect(view.getByRole('region', { name: 'Current ADE evidence' })).toHaveCount(0)
  await native.append([
    {
      timestamp: new Date(Date.UTC(2026, 8, 6, 13, 40, 0)).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Source changed after the admitted page' }],
      },
    },
  ])
  await view.getByRole('button', { name: 'Load more native history' }).click()
  await expect(view.getByRole('button', { name: 'Refresh conversation history' })).toBeVisible()
  await expect(view.getByRole('alert')).toBeVisible()
  await view.getByRole('button', { name: 'Refresh conversation history' }).click()
  await expect(view.getByRole('button', { name: 'Load more native history' })).toBeVisible()
  await nativeViewport.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(nativeViewport.getByText('Retained transcript entry 0')).toBeVisible()
  const context = view.getByRole('group', { name: 'Conversation context' })
  await expect(context).toContainText(workspace.name)
  await expect(context).toContainText(
    sdk.conversation.execution_host.kind === 'local' ? 'Local host' : sdk.conversation.execution_host.host_id,
  )
  await expect(context).toContainText(sdk.conversation.provider)
  await expect(context).toContainText(
    sdk.conversation.account_context === 'managed'
      ? (sdk.conversation.account_id ?? 'Managed account')
      : 'Ambient account',
  )
  const catalog = await profile.call('catalog.get', {})
  const project = catalog.catalog.projects.find((item) => item.id === workspace.project_id)
  expect(project).toBeDefined()
  await expect(context).toContainText(project!.name)

  const originalTabId = await view.getAttribute('data-tab-id')
  expect(originalTabId).toBeTruthy()
  await view.getByRole('button', { name: 'Open in another tab' }).press('Enter')
  const tabs = desktopPage.locator('[role="tab"][data-tab-id]')
  const views = desktopPage.locator(`[data-conversation-id="${conversationId}"][data-tab-id]`)
  await expect(tabs).toHaveCount(2)
  await expect(views).toHaveCount(1)
  const viewTabIds = await tabs.evaluateAll((items) => items.map((item) => item.getAttribute('data-tab-id')))
  expect(new Set(viewTabIds).size).toBe(2)
  await expect(views).toHaveAttribute('data-conversation-id', conversationId)
  const otherTabId = viewTabIds.find((id) => id !== originalTabId)!
  const firstTab = desktopPage.locator(`[role="tab"][data-tab-id="${originalTabId}"]`)
  const secondTab = desktopPage.locator(`[role="tab"][data-tab-id="${otherTabId}"]`)
  const firstView = desktopPage.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${originalTabId}"]`)
  const secondView = desktopPage.locator(`[data-conversation-id="${conversationId}"][data-tab-id="${otherTabId}"]`)
  const firstViewport = firstView.locator('[aria-label="Current ADE messages"] [data-slot="scroll-area-viewport"]')
  const secondViewport = secondView.locator('[aria-label="Current ADE messages"] [data-slot="scroll-area-viewport"]')
  await firstTab.click()
  await firstViewport.hover()
  await desktopPage.mouse.wheel(0, 240)
  await expect.poll(() => firstViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const firstScrollTop = await firstViewport.evaluate((element) => element.scrollTop)
  await secondTab.click()
  await secondViewport.hover()
  await desktopPage.mouse.wheel(0, 600)
  await expect.poll(() => secondViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(firstScrollTop)
  const secondScrollTop = await secondViewport.evaluate((element) => element.scrollTop)
  await firstTab.click()
  await expect.poll(() => firstViewport.evaluate((element) => element.scrollTop)).toBe(firstScrollTop)
  await secondTab.click()
  await expect.poll(() => secondViewport.evaluate((element) => element.scrollTop)).toBe(secondScrollTop)
  await desktopPage.screenshot({ path: testInfo.outputPath('conversation-history.png'), fullPage: false })
  await testInfo.attach('conversation-history.png', {
    path: testInfo.outputPath('conversation-history.png'),
    contentType: 'image/png',
  })
})

test('an empty daemon-owned conversation renders without messages', async ({ profile, desktop }, testInfo) => {
  const conversationId = await startConversation(profile, 'Empty conversation')
  const snapshot = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(snapshot.messages).toEqual([])

  const { window } = await desktop.launch(profile)
  await attachClientState(window, testInfo)
  const row = window.getByRole('list', { name: 'Projects' }).getByRole('button', { name: snapshot.conversation.title })
  await row.click()
  const view = window.locator(`[data-conversation-id="${conversationId}"]`)
  await expect(view.locator('[role="status"]')).toBeVisible()
  await expect(view.locator('[data-message-id]')).toHaveCount(0)
})

test('retained history remains readable after its provider plugin is disabled', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const { pluginId } = await installAndEnable(profile, await stagePlugin(ade.root, 'provider'))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: workspace.id,
    provider: `plugin:${pluginId}`,
    title: 'Unavailable provider history',
  })
  await send(profile, conversation.id, 'retained plugin prompt')
  await waitForMessage(profile, conversation.id, 'Hello plugin')
  await waitForIdle(profile, conversation.id)
  await profile.call('plugin.disable', { plugin_id: pluginId })
  const registrations = await profile.call('provider.registrations', {})
  expect(registrations.providers.some((item) => item.provider === `plugin:${pluginId}`)).toBe(false)
  const sdk = await profile.call('conversation.get', { conversation_id: conversation.id })
  const cli = await profile.cli('conversation', 'inspect', conversation.id)
  expect(cli.code).toBe(0)
  expect(cli.json?.messages).toEqual(sdk.messages)
  await testInfo.attach('provider-unavailable-inspection.json', {
    body: JSON.stringify({ pluginId, registrations, sdk, cli: cli.json }, null, 2),
    contentType: 'application/json',
  })

  const { window } = await desktop.launch(profile)
  await attachClientState(window, testInfo)
  const row = window.getByRole('list', { name: 'Projects' }).getByRole('button', { name: sdk.conversation.title })
  await row.click()
  const view = window.locator(`[data-conversation-id="${conversation.id}"]`)
  await expect(view.locator(`[data-message-id="${sdk.messages[0]!.id}"]`)).toContainText('retained plugin prompt')
  await expect(view.locator(`[data-message-id="${sdk.messages[1]!.id}"]`)).toContainText('Hello plugin')
  expect((await profile.call('conversation.get', { conversation_id: conversation.id })).messages).toEqual(sdk.messages)
})
