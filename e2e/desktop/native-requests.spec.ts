import type { Page, TestInfo } from '@playwright/test'
import { codexPrompts, expect, prompts, test, waitForIdle, waitForPendingRequest } from './fixtures'

async function startConversation(profile: Parameters<typeof waitForPendingRequest>[0], title: string) {
  const { catalog } = await profile.call('catalog.get', {})
  const { conversation } = await profile.call('conversation.create', {
    workspace_id: catalog.workspaces[0]!.id,
    provider: 'codex',
    title,
  })
  return conversation.id
}

async function assertConnected(page: Page, testInfo: TestInfo) {
  const clientState = await page.evaluate(() => window.adeHost.profiles.getClientState())
  const evidence = {
    status: clientState.status,
    detail: clientState.detail,
    bootId: clientState.bootId,
    revision: clientState.revision,
  }
  await testInfo.attach('native-client-state.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  expect(evidence).toMatchObject({ status: 'connected' })
}

test('the built conversation form validates, stays read-only while offline, and submits a native question answer', async ({
  profile,
  desktop,
}, testInfo) => {
  const conversationId = await startConversation(profile, 'Native questions UI')
  const { window: page } = await desktop.launch(profile)
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Native questions UI' })
  await row.click()

  const composer = page.getByRole('form', { name: 'Prompt composer' })
  const prompt = composer.getByRole('textbox', { name: 'Prompt' })
  await expect(prompt).toBeEditable()
  await prompt.fill(prompts.questions)
  await composer.getByRole('button', { name: 'Send prompt' }).click()
  const pending = await waitForPendingRequest(profile, conversationId)
  expect(pending.metadata.schema.kind).toBe('questions')
  await assertConnected(page, testInfo)
  const form = page.getByRole('form', { name: 'Answer structured questions' })
  const requestCard = page.getByRole('article').filter({ has: form })
  await expect(requestCard).toBeVisible()
  const first = form.getByLabel('First?', { exact: true })
  const second = form.getByLabel('Second?', { exact: true })
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await form.getByRole('button', { name: 'Send response' }).click()
  for (const label of ['First?', 'Second?']) {
    const question = form.getByRole('group', { name: label, exact: true })
    await expect(question).toHaveAttribute('aria-invalid', 'true')
    const error = question.getByRole('alert')
    await expect(error).toBeVisible()
    const errorId = await error.getAttribute('id')
    const describedBy = await question.getAttribute('aria-describedby')
    expect(describedBy?.split(/\s+/)).toContain(errorId)
  }
  await expect(first).toBeFocused()
  const validationScreenshot = testInfo.outputPath('native-question-validation.png')
  await page.screenshot({ path: validationScreenshot, fullPage: true })
  await testInfo.attach('native-question-validation.png', { path: validationScreenshot, contentType: 'image/png' })
  await testInfo.attach('native-question-validation-dom.txt', {
    body: await requestCard.ariaSnapshot(),
    contentType: 'text/plain',
  })
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(0)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).requests).toEqual([
    expect.objectContaining({ id: pending.id, resolution: 'outstanding' }),
  ])
  await first.fill('unsent first answer')
  await second.fill('unsent second answer')

  // The live conversation disappears while its profile daemon is unavailable; it cannot submit a stale answer.
  const connected = page.getByRole('contentinfo').getByRole('img', { name: 'Connected' })
  await profile.killDaemon()
  await expect(connected).toBeHidden()
  const submit = form.getByRole('button', { name: 'Send response' })
  await expect.poll(async () => (await submit.count()) === 0 || !(await submit.isEnabled())).toBe(true)
  await expect(first).toBeDisabled()
  await expect(second).toBeDisabled()
  const offlineState = await page.evaluate(async () => {
    const { status, detail, bootId, revision } = await window.adeHost.profiles.getClientState()
    return { status, detail, bootId, revision }
  })
  await testInfo.attach('native-client-state-offline.json', {
    body: JSON.stringify(offlineState, null, 2),
    contentType: 'application/json',
  })
  expect(offlineState.status).toMatch(/^(reconnecting|unavailable)$/)
  const staleScreenshot = testInfo.outputPath('native-question-stale.png')
  await page.screenshot({ path: staleScreenshot, fullPage: true })
  await testInfo.attach('native-question-stale.png', { path: staleScreenshot, contentType: 'image/png' })
  await testInfo.attach('native-question-stale-dom.txt', {
    body: await requestCard.ariaSnapshot(),
    contentType: 'text/plain',
  })
  const offlineSubmitCanceled = await form.evaluate((element) => {
    const event = new Event('submit', { bubbles: true, cancelable: true })
    return !element.dispatchEvent(event)
  })
  expect(offlineSubmitCanceled).toBe(true)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(0)
  await profile.restartDaemon()
  await expect(connected).toBeVisible()
  await expect(form).toBeVisible()
  await expect(submit).toBeEnabled()
  await first.fill('')
  await second.fill('')
  await first.pressSequentially('first answer from Electron')
  await second.pressSequentially('second answer from Electron')
  await second.press('Tab')
  await expect(submit).toBeFocused()
  await submit.press('Enter')
  await expect
    .poll(async () => (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply').length)
    .toBe(1)
  await waitForIdle(profile, conversationId)

  const nativeReply = (await profile.mockCalls('codex')).find((call) => call.method === 'approval/reply')!
  expect(nativeReply.request_method).toBe('item/tool/requestUserInput')
  expect(nativeReply.result).toEqual({
    answers: {
      first: { answers: ['first answer from Electron'] },
      second: { answers: ['second answer from Electron'] },
    },
  })
  const after = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(after.requests).toEqual([])
  const replies = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(replies).toHaveLength(1)
  await testInfo.attach('native-question-answer.json', {
    body: JSON.stringify(
      {
        requestId: pending.id,
        sourceAttemptId: pending.source_attempt_id,
        revision: pending.revision,
        visibleQuestionLabels: ['First?', 'Second?'],
        invalidSchemaErrors: 2,
        focusedLabel: 'First?',
        nativeReplyMethod: nativeReply.request_method,
        nativeReplyCount: replies.length,
        requestsAfterCount: after.requests.length,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('the built Electron request form exposes native choices and submits the selected choice once', async ({
  profile,
  desktop,
}, testInfo) => {
  const conversationId = await startConversation(profile, 'Native choices UI')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Native choices UI' }).click()
  const composer = page.getByRole('form', { name: 'Prompt composer' })
  await composer.getByRole('textbox', { name: 'Prompt' }).fill(codexPrompts.approvalAll)
  await composer.getByRole('button', { name: 'Send prompt' }).click()

  const pending = await waitForPendingRequest(profile, conversationId)
  expect(pending.metadata.schema.kind).toBe('choices')
  if (pending.metadata.schema.kind !== 'choices') throw new Error('Expected native choice schema')
  await assertConnected(page, testInfo)
  const offeredChoices = pending.metadata.schema.choices
  expect(offeredChoices).toMatchObject([
    { value: 'accept', label: 'Allow once', scope: 'once' },
    { value: 'decline', label: 'Decline' },
    { value: 'cancel', label: 'Cancel turn' },
  ])

  const form = page.getByRole('form', { name: 'Answer agent request' })
  const requestCard = page.getByRole('article').filter({ has: form })
  await expect(form).toBeVisible()
  for (const label of ['Allow once', 'Decline', 'Cancel turn']) {
    await expect(form.getByRole('radio', { name: label, exact: true })).toBeVisible()
  }
  await expect(form.getByText('Once', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: 'Send response' }).click()
  const choiceGroup = form.getByRole('radiogroup')
  await expect(choiceGroup).toHaveAttribute('aria-invalid', 'true')
  const choiceError = form.getByRole('alert')
  await expect(choiceError).toBeVisible()
  const choiceErrorId = await choiceError.getAttribute('id')
  expect((await choiceGroup.getAttribute('aria-describedby'))?.split(/\s+/)).toContain(choiceErrorId)
  await expect(form.getByRole('radio', { name: 'Allow once', exact: true })).toBeFocused()
  const validationScreenshot = testInfo.outputPath('native-choice-validation.png')
  await page.screenshot({ path: validationScreenshot, fullPage: true })
  await testInfo.attach('native-choice-validation.png', { path: validationScreenshot, contentType: 'image/png' })
  await testInfo.attach('native-choice-validation-dom.txt', {
    body: await requestCard.ariaSnapshot(),
    contentType: 'text/plain',
  })

  await form.getByRole('radio', { name: 'Allow once', exact: true }).click()
  await form.getByRole('button', { name: 'Send response' }).click()
  await waitForIdle(profile, conversationId)
  const replies = (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({
    request_method: 'item/commandExecution/requestApproval',
    result: { decision: 'accept' },
  })
  const after = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(after.requests).toEqual([])
  await testInfo.attach('native-choice-answer.json', {
    body: JSON.stringify(
      {
        requestId: pending.id,
        sourceAttemptId: pending.source_attempt_id,
        revision: pending.revision,
        offeredChoiceLabelsAndScopes: offeredChoices.map(
          ({ label, scope }: { label: string; scope?: string | null }) => ({ label, scope: scope ?? null }),
        ),
        nativeReplyMethod: replies[0]?.request_method,
        nativeReplyCount: replies.length,
        nativeDecision: 'accept',
        requestsAfterCount: after.requests.length,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('the built Electron app explains an unsupported native request and never offers an answer form', async ({
  profile,
  desktop,
}, testInfo) => {
  const conversationId = await startConversation(profile, 'Unsupported native request')
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('list', { name: 'Projects' }).getByRole('button', { name: 'Unsupported native request' }).click()
  const composer = page.getByRole('form', { name: 'Prompt composer' })
  await composer.getByRole('textbox', { name: 'Prompt' }).fill(codexPrompts.unsupportedRequest)
  await composer.getByRole('button', { name: 'Send prompt' }).click()

  const pending = await waitForPendingRequest(profile, conversationId)
  expect(pending.metadata.schema.kind).toBe('unsupported')
  if (pending.metadata.schema.kind !== 'unsupported') throw new Error('Expected unsupported native schema')
  await assertConnected(page, testInfo)
  const reasonStatus = page.getByRole('status').filter({ hasText: pending.metadata.schema.reason })
  await expect(reasonStatus).toBeVisible()
  const requestCard = page.getByRole('article').filter({ has: reasonStatus })
  await expect(page.getByRole('form', { name: 'Answer agent request' })).toHaveCount(0)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(0)
  const screenshot = testInfo.outputPath('native-unsupported-request.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('native-unsupported-request.png', { path: screenshot, contentType: 'image/png' })
  await testInfo.attach('native-unsupported-request-dom.txt', {
    body: await requestCard.ariaSnapshot(),
    contentType: 'text/plain',
  })

  await profile.releaseMock('codex', 'expire-approval')
  await waitForIdle(profile, conversationId)
  const after = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(after.requests).toEqual([])
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')).toHaveLength(0)
  await testInfo.attach('native-unsupported-request.json', {
    body: JSON.stringify(
      {
        requestId: pending.id,
        sourceAttemptId: pending.source_attempt_id,
        revision: pending.revision,
        unsupportedReason: pending.metadata.schema.reason,
        requestsAfterCount: after.requests.length,
        nativeReplyCount: 0,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})
