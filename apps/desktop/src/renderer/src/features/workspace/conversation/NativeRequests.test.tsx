import { afterEach, expect, test, vi } from 'vitest'
import '../../../app/app.css'
import type { AgentAnswerOutcome, PendingRequest } from '@ade/contracts'

import { createFakeHost } from '../../../state/fake-host'
import { draftState, emptySnapshot, mount } from './ConversationTestSupport'

let previousHost: typeof window.adeHost

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.adeHost = previousHost
})

const nativeRequest = (
  conversationId: string,
  schema: PendingRequest['metadata']['schema'],
  overrides: Partial<PendingRequest> = {},
): PendingRequest => ({
  conversation_id: conversationId,
  id: 'native-request-1',
  metadata: {
    blocking: true,
    native_request_id: 'private-native-request-id',
    schema,
    schema_version: 1,
    summary: 'Choose how the agent may continue.',
  },
  resolution: 'outstanding',
  response_delivery: 'not_sent',
  revision: 7,
  source_attempt_id: 'attempt-1',
  ...overrides,
})

const answerOutcomeFor = (
  request: PendingRequest,
  fields: unknown,
  responseDelivery: AgentAnswerOutcome['response_delivery'],
): AgentAnswerOutcome => ({
  type: 'agent_answer_outcome',
  operation_id: (fields as Record<string, unknown>).operation_id as string,
  request_id: request.id,
  request_revision: request.revision,
  source_attempt_id: request.source_attempt_id,
  response_delivery: responseDelivery,
  resolution: 'outstanding',
})

test('native choices preserve provider values and fences, and transport acknowledgement is not a grant', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-choice'
  const providerValue = { native_choice_id: 'allow-once-42' }
  const request = nativeRequest(id, {
    kind: 'choices',
    choices: [
      { value: providerValue, label: 'Allow this command', scope: 'once', duration: 'this request' },
      { value: 'reject-native-choice', label: 'Reject this command' },
    ],
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.answer') return answerOutcomeFor(request, fields, 'acknowledged')
    return {}
  })
  const screen = await mount(fake, id, 'tab-native-choice', draftState())

  await expect.element(screen.getByText('Choose how the agent may continue.')).toBeVisible()
  await expect.element(screen.getByText('Once · this request')).toBeVisible()
  const allow = screen.getByRole('radio', { name: /Allow this command/ })
  await expect.element(allow).not.toBeChecked()
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
  await allow.click()
  await screen.getByRole('button', { name: 'Send response' }).click()

  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
  const submitted = fake.requests.find(({ op }) => op === 'agent.answer')!.fields as Record<string, unknown>
  expect(submitted).toMatchObject({
    conversation_id: id,
    request_id: request.id,
    request_revision: 7,
    source_attempt_id: 'attempt-1',
    answer: { kind: 'choice', value: providerValue },
  })
  await expect.element(screen.getByText('Outstanding', { exact: true })).toBeVisible()
  expect(document.body.textContent).not.toContain('private-native-request-id')

  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 2,
    conversation: reply.conversation,
    messages: reply.messages,
    requests: reply.requests,
  })
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
})
test('native request expiry reschedules past the maximum timer delay and preserves requests without a native deadline', async () => {
  previousHost = window.adeHost
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let currentTime = Date.now()
  const now = currentTime
  vi.spyOn(window.Date, 'now').mockImplementation(() => currentTime)
  const maximumTimerDelay = 2_147_483_647
  const id = 'conversation-native-expiry'
  const schema: PendingRequest['metadata']['schema'] = {
    kind: 'choices',
    choices: [{ value: 'allow', label: 'Expires after the maximum timer delay' }],
  }
  const base = nativeRequest(id, schema)
  const expiresAt = now + maximumTimerDelay + 5_000
  const expiring = {
    ...base,
    id: 'native-expiring-request',
    metadata: { ...base.metadata, expires_at_ms: expiresAt },
  }
  const noExpirySchema: PendingRequest['metadata']['schema'] = {
    kind: 'choices',
    choices: [{ value: 'allow', label: 'No native expiry' }],
  }
  const noExpiry = nativeRequest(id, noExpirySchema, { id: 'native-request-without-expiry' })
  const reply = { ...emptySnapshot(id), requests: [expiring, noExpiry] }
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? reply : {}))
  const screen = await mount(fake, id, 'tab-native-expiry', draftState())
  const expiringChoice = screen.getByRole('radio', { name: 'Expires after the maximum timer delay' })
  const noExpiryChoice = screen.getByRole('radio', { name: 'No native expiry' })

  await expect.element(expiringChoice).toBeEnabled()
  const expiringChoiceNode = expiringChoice.element()
  currentTime += maximumTimerDelay
  await vi.advanceTimersByTimeAsync(maximumTimerDelay)
  await expect.element(expiringChoice).toBeEnabled()
  currentTime += 4_999
  await vi.advanceTimersByTimeAsync(4_999)
  await expect.element(expiringChoice).toBeEnabled()
  currentTime += 1
  await vi.advanceTimersByTimeAsync(1)
  expect(expiringChoiceNode.isConnected).toBe(false)
  await expect.element(noExpiryChoice).toBeEnabled()
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
})

test('structured questions validate every answer and preserve secret text and native option values', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-questions'
  const providerValue = { answer_id: 'debugging' }
  const secret = 'private-test-secret'
  const request = nativeRequest(id, {
    kind: 'questions',
    questions: [
      {
        id: 'purpose',
        header: 'Purpose',
        prompt: 'What is this key for?',
        multiple: false,
        allow_other: false,
        secret: false,
        options: [{ value: providerValue, label: 'Debugging', description: 'Inspect a failing test.' }],
      },
      {
        id: 'token',
        prompt: 'Access token',
        multiple: false,
        allow_other: true,
        secret: true,
        options: [],
      },
    ],
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.answer') return answerOutcomeFor(request, fields, 'dispatched')
    return {}
  })
  const screen = await mount(fake, id, 'tab-native-questions', draftState())

  const secretInput = screen.getByLabelText('Access token')
  await expect.element(secretInput).toHaveAttribute('type', 'password')
  await screen.getByRole('button', { name: 'Send response' }).click()
  await expect.element(screen.getByText('Choose or enter an answer.').first()).toBeVisible()
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
  await expect
    .poll(() => screen.getByRole('radio', { name: 'Debugging' }).element() === document.activeElement)
    .toBe(true)

  await screen.getByRole('radio', { name: 'Debugging' }).click()
  await secretInput.fill(secret)
  await screen.getByRole('button', { name: 'Send response' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
  const submitted = fake.requests.find(({ op }) => op === 'agent.answer')!.fields as Record<string, unknown>
  expect(submitted).toMatchObject({
    answer: { kind: 'questions', answers: { purpose: [providerValue], token: [secret] } },
    request_id: request.id,
    request_revision: request.revision,
    source_attempt_id: request.source_attempt_id,
  })
  expect(document.body.textContent).not.toContain(secret)
})

test('a structured-question decline sends its exact native choice without an answer form', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-decline'
  const declineValue = { native_choice_id: 'decline-44' }
  const request = nativeRequest(id, {
    kind: 'questions',
    questions: [
      {
        id: 'required',
        prompt: 'Choose a handling option.',
        multiple: false,
        allow_other: false,
        secret: false,
        options: [{ value: 'continue', label: 'Continue', description: '' }],
      },
    ],
    decline: { value: declineValue, label: 'Not now', scope: 'once' },
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.answer') return answerOutcomeFor(request, fields, 'dispatched')
  })
  const screen = await mount(fake, id, 'tab-native-decline', draftState())

  await screen.getByRole('button', { name: 'Not now' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
  const submitted = fake.requests.find(({ op }) => op === 'agent.answer')!.fields as Record<string, unknown>
  expect(submitted).toMatchObject({ answer: { kind: 'choice', value: declineValue } })
  expect(submitted).toHaveProperty('request_revision', request.revision)
})

test('permission scope and strict-review selection retain the requested native payload', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-permissions'
  const requested = { permissions: [{ resource: 'workspace', access: 'read' }] }
  const request = nativeRequest(id, {
    kind: 'permissions',
    requested,
    scopes: ['once', 'turn', 'session', 'persistent'],
    supports_strict_auto_review: true,
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.answer') return answerOutcomeFor(request, fields, 'dispatched')
  })
  const screen = await mount(fake, id, 'tab-native-permissions', draftState())

  await screen.getByRole('radio', { name: 'Persistent' }).click()
  await screen.getByRole('radio', { name: 'Strict automatic review on' }).click()
  await screen.getByRole('button', { name: 'Send permission response' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
  const submitted = fake.requests.find(({ op }) => op === 'agent.answer')!.fields as Record<string, unknown>
  expect(submitted).toMatchObject({
    answer: { kind: 'permissions', permissions: requested, scope: 'persistent', strict_auto_review: true },
    request_revision: request.revision,
    source_attempt_id: request.source_attempt_id,
  })
})

test('unsupported, withdrawn and unknown-delivery requests stay readable and non-actionable', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-unsupported'
  const unsupported = nativeRequest(
    id,
    {
      kind: 'unsupported',
      reason: 'This provider response schema is not supported by this version.',
    },
    { resolution: 'unsupported', response_delivery: 'unknown' },
  )
  const withdrawn = nativeRequest(
    id,
    {
      kind: 'choices',
      choices: [{ value: 'allow', label: 'Allow', scope: 'persistent' }],
    },
    { id: 'withdrawn-request', resolution: 'withdrawn', response_delivery: 'not_sent' },
  )
  const reply = { ...emptySnapshot(id), requests: [unsupported, withdrawn] }
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? reply : {}))
  const screen = await mount(fake, id, 'tab-native-unsupported', draftState())

  await expect
    .element(screen.getByText('This provider response schema is not supported by this version.'))
    .toBeVisible()
  await expect.element(screen.getByText('Unsupported', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('Withdrawn', { exact: true })).toBeVisible()
  expect(document.body.textContent).not.toContain('private-native-request-id')
  expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Send response')).toBe(
    false,
  )
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
})
test('permission answers omit strict-review when the native default is selected', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-permissions-default'
  const requested = { paths: ['/workspace'] }
  const request = nativeRequest(id, {
    kind: 'permissions',
    requested,
    scopes: ['once'],
    supports_strict_auto_review: true,
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.answer') return answerOutcomeFor(request, fields, 'dispatched')
    return {}
  })
  const screen = await mount(fake, id, 'tab-native-permissions-default', draftState())

  await expect.element(screen.getByRole('radio', { name: 'Use native default' })).toBeChecked()
  await screen.getByRole('radio', { name: 'Once' }).click()
  await screen.getByRole('button', { name: 'Send permission response' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.answer').length).toBe(1)
  const submitted = fake.requests.find(({ op }) => op === 'agent.answer')!.fields as Record<string, unknown>
  const answer = submitted.answer as Record<string, unknown>
  expect(answer).toMatchObject({ kind: 'permissions', permissions: requested, scope: 'once' })
  expect(answer).not.toHaveProperty('strict_auto_review')
})

test('unknown native schema versions show their summary without guessed controls', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-unknown-version'
  const base = nativeRequest(id, {
    kind: 'choices',
    choices: [{ value: 'allow', label: 'Allow', scope: 'once' }],
  })
  const request = { ...base, metadata: { ...base.metadata, schema_version: 99 } }
  const reply = { ...emptySnapshot(id), requests: [request] }
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? reply : {}))
  const screen = await mount(fake, id, 'tab-native-unknown-version', draftState())

  await expect.element(screen.getByText('Choose how the agent may continue.')).toBeVisible()
  await expect.element(screen.getByText('Request schema version 99 is not supported.')).toBeVisible()
  expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Send response')).toBe(
    false,
  )
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
})
