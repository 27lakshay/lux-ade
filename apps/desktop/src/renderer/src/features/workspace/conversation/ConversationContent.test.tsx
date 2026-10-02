import { afterEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createStore } from 'zustand/vanilla'
import type { AgentCancelOutcome, AgentTerminateOutcome, ConversationStop, PendingRequest } from '@ade/contracts'

import type { DaemonState } from '../../../state/daemon-store'
import type { ProfileState } from '../../../../../shared/bridge/types'
import { createFakeHost, nextFrame } from '../../../state/fake-host'
import {
  deliveryFor,
  deliveryFrame,
  deliveryMessage,
  draftState,
  emptyDaemon,
  emptySnapshot,
  mount,
  profileState,
  snapshot,
  deferred,
} from './ConversationTestSupport'

let previousHost: typeof window.adeHost

afterEach(() => {
  vi.useRealTimers()
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

test('stale conversation projections disable native request effects', async () => {
  previousHost = window.adeHost
  const id = 'conversation-native-stale'
  const request = nativeRequest(id, {
    kind: 'choices',
    choices: [{ value: 'allow', label: 'Allow', scope: 'once' }],
  })
  const reply = { ...emptySnapshot(id), requests: [request] }
  const reload = deferred<unknown>()
  let snapshotReads = 0
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') {
      snapshotReads += 1
      return snapshotReads === 1 ? reply : reload.promise
    }
    return {}
  })
  const screen = await mount(fake, id, 'tab-native-stale', draftState())
  await expect.element(screen.getByRole('button', { name: 'Send response' })).toBeEnabled()

  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 3,
    conversation: reply.conversation,
    messages: reply.messages,
    requests: reply.requests,
  })
  await expect
    .element(screen.getByText('Request controls are read-only while conversation state is stale.'))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Send response' })).toBeDisabled()
  expect(fake.requests.filter(({ op }) => op === 'agent.answer')).toHaveLength(0)
  reload.resolve(reply)
})

function stopRecord(overrides: Partial<ConversationStop> = {}): ConversationStop {
  return {
    operation_id: 'stop-op-1',
    source_attempt_id: 'attempt-live-7',
    submission_id: 'submission-live-19',
    turn_id: null,
    requested_at_ms: 1730000000000,
    delivery: 'pending',
    outcome: 'requested',
    confirmation: null,
    native_status: null,
    evidence: null,
    reason: null,
    escalation: null,
    settled_at_ms: null,
    ...overrides,
  }
}

test('Stop targets the live attempt and submission without a turn wildcard and offers termination when unresolved', async () => {
  previousHost = window.adeHost
  const id = 'conversation-stop-exact-target'
  const base = emptySnapshot(id)
  const running = {
    ...base.conversation,
    status: 'running',
    runtime_run: 'attempt-live-7',
    runtime_submission: 'submission-live-19',
    active_turn_id: null,
  }
  const reply = { ...base, conversation: running }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.cancel') {
      const request = fields as { operation_id: string; source_attempt_id: string; submission_id: string }
      return {
        type: 'agent_cancel_outcome',
        conversation_id: id,
        operation_id: request.operation_id,
        source_attempt_id: request.source_attempt_id,
        submission_id: request.submission_id,
        delivery: 'pending',
        evidence: null,
      } satisfies AgentCancelOutcome
    }
    if (op === 'agent.terminate') {
      const request = fields as { operation_id: string; source_attempt_id: string }
      return {
        type: 'agent_terminate_outcome',
        conversation_id: id,
        operation_id: request.operation_id,
        source_attempt_id: request.source_attempt_id,
        process_exited: true,
        limits: ['Child or background processes the provider started may survive the provider process'],
      } satisfies AgentTerminateOutcome
    }
    return {}
  })
  const screen = await mount(fake, id, 'tab-stop-exact-target')
  await screen.getByRole('button', { name: 'Stop current turn' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.cancel').length).toBe(1)
  const cancelRequest = fake.requests.find(({ op }) => op === 'agent.cancel')!.fields as Record<string, unknown>
  expect(cancelRequest).toMatchObject({
    conversation_id: id,
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    source_attempt_id: 'attempt-live-7',
    submission_id: 'submission-live-19',
  })
  expect(cancelRequest).not.toHaveProperty('turn_id')

  // The daemon reports the acknowledgement, then that queued native input can still run.
  const push = (revision: number, stop: ConversationStop) =>
    fake.pushFrame({
      type: 'conversation_changed',
      boot_id: 'boot-1',
      revision,
      conversation: { ...running, status: 'cancelling', stop },
      messages: reply.messages,
      requests: reply.requests,
    })
  push(2, stopRecord({ delivery: 'acknowledged' }))
  const status = screen.getByRole('status', { name: 'Stop status' })
  await expect
    .poll(() => status.element().textContent)
    .toContain('The provider acknowledged the stop. Waiting for the turn to end.')
  await expect.element(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
  expect(document.body.textContent).not.toMatch(/\bstopped\b/i)
  push(
    3,
    stopRecord({
      delivery: 'acknowledged',
      outcome: 'unresolved',
      reason: '2 queued inputs can still run after this stop',
      escalation: 'terminate_process',
      evidence: {
        scope: 'submission',
        interruption_requested: true,
        termination: 'requested',
        active_work_remaining: true,
        queued_work_count: 2,
        background_work_remaining: null,
        observed_at_ms: 1730000000000,
      },
    }),
  )
  await expect.element(status).toHaveAttribute('data-stop-outcome', 'unresolved')
  await expect.poll(() => status.element().textContent).toContain('2 queued inputs can still run after this stop')
  await expect.poll(() => status.element().textContent).toContain('Queued inputs: 2.')
  await screen.getByRole('button', { name: 'Terminate provider process' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.terminate').length).toBe(1)
  expect(fake.requests.find(({ op }) => op === 'agent.terminate')!.fields).toMatchObject({
    conversation_id: id,
    source_attempt_id: 'attempt-live-7',
  })
  // The window shows the terminate request; the daemon's Stop record then reports the exit.
  push(
    4,
    stopRecord({
      delivery: 'acknowledged',
      outcome: 'confirmed',
      confirmation: 'process_exit',
      settled_at_ms: 1730000001000,
    }),
  )
  await expect
    .poll(() => status.element().textContent)
    .toContain('The provider process ended. Child or background processes it started may still be running.')
})

test('Stop forwards the live turn identity and shows confirmation only from native terminal evidence', async () => {
  previousHost = window.adeHost
  const id = 'conversation-stop-with-turn'
  const base = emptySnapshot(id)
  const running = {
    ...base.conversation,
    status: 'running',
    runtime_run: 'attempt-live-8',
    runtime_submission: 'submission-live-20',
    active_turn_id: 'turn-live-3',
  }
  const reply = { ...base, conversation: running }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return reply
    if (op === 'agent.cancel') {
      const request = fields as {
        operation_id: string
        source_attempt_id: string
        submission_id: string
        turn_id?: string
      }
      return {
        type: 'agent_cancel_outcome',
        conversation_id: id,
        operation_id: request.operation_id,
        source_attempt_id: request.source_attempt_id,
        submission_id: request.submission_id,
        turn_id: request.turn_id,
        delivery: 'acknowledged',
        evidence: null,
      } satisfies AgentCancelOutcome
    }
    return {}
  })
  const screen = await mount(fake, id, 'tab-stop-with-turn')
  await screen.getByRole('button', { name: 'Stop current turn' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.cancel').length).toBe(1)
  expect(fake.requests.find(({ op }) => op === 'agent.cancel')!.fields).toMatchObject({
    conversation_id: id,
    source_attempt_id: 'attempt-live-8',
    submission_id: 'submission-live-20',
    turn_id: 'turn-live-3',
  })
  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 2,
    conversation: {
      ...running,
      status: 'interrupted',
      active_turn_id: null,
      stop: stopRecord({
        source_attempt_id: 'attempt-live-8',
        submission_id: 'submission-live-20',
        turn_id: 'turn-live-3',
        delivery: 'acknowledged',
        outcome: 'confirmed',
        confirmation: 'native_terminal',
        native_status: 'interrupted',
        settled_at_ms: 1730000000500,
      }),
    },
    messages: reply.messages,
    requests: reply.requests,
  })
  const status = screen.getByRole('status', { name: 'Stop status' })
  await expect.element(status).toHaveAttribute('data-stop-outcome', 'confirmed')
  await expect.poll(() => status.element().textContent).toContain('The provider reported the turn ended (interrupted).')
  await expect.element(screen.getByRole('button', { name: 'Terminate provider process' })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: 'Stop current turn' })).not.toBeInTheDocument()
})

test('Stop is hidden once the submission has ended, even though its identity is retained', async () => {
  previousHost = window.adeHost
  const id = 'conversation-stop-idle'
  const base = emptySnapshot(id)
  const reply = {
    ...base,
    conversation: {
      ...base.conversation,
      status: 'ready',
      runtime_run: 'attempt-idle',
      runtime_submission: 'submission-finished',
      active_turn_id: null,
    },
  }
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? reply : {}))
  const screen = await mount(fake, id, 'tab-stop-idle')
  await expect.element(screen.getByRole('button', { name: 'Open in another tab' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Stop current turn' })).not.toBeInTheDocument()
})

test('a rejected delivery after daemon acknowledgement leaves the prompt actionable', async () => {
  previousHost = window.adeHost
  const id = 'conversation-rejected'
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'agent.send') return { type: 'ack' }
    return {}
  })
  const screen = await mount(fake, id, 'tab-rejected', draftState('Keep this prompt'))
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => prompt.element().textContent).toContain('Keep this prompt')
  await expect.element(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  await prompt.click()
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.send').length).toBe(1)
  await expect
    .element(screen.getByText('Delivery is pending. This prompt and its request ID remain here.'))
    .toBeVisible()
  const first = fake.requests.find(({ op }) => op === 'agent.send')!.fields as { request_id: string; text: string }
  expect(first.text).toBe('Keep this prompt')
  fake.pushFrame(
    deliveryFrame(
      id,
      2,
      deliveryMessage(
        'rejected-message',
        first.text,
        deliveryFor(first.request_id, 'rejected-message', { native_outcome: 'rejected' }),
      ),
    ),
  )
  await expect.element(screen.getByRole('button', { name: 'Edit or retry prompt' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Edit or retry prompt' })).toBeEnabled()
  expect(prompt.element().textContent ?? '').toContain(first.text)
  await screen.getByRole('button', { name: 'Edit or retry prompt' }).click()
  await expect.element(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  // Unlocking makes the editor editable and moves focus to its end in an effect; filling
  // before that settles appends to the old text instead of replacing it.
  await expect.poll(() => prompt.element().getAttribute('contenteditable')).toBe('true')
  await expect.poll(() => document.activeElement === prompt.element()).toBe(true)
  await prompt.fill('Keep this prompt revised')
  await expect.poll(() => prompt.element().textContent).toContain('Keep this prompt revised')
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.send').length).toBe(2)
  const sends = fake.requests
    .filter(({ op }) => op === 'agent.send')
    .map(({ fields }) => fields as { request_id: string; text: string })
  expect(sends[1].text).toBe('Keep this prompt revised')
  expect(sends[1].request_id).not.toBe(first.request_id)
})

test('unknown delivery retains and reconciles the same request ID', async () => {
  previousHost = window.adeHost
  const id = 'conversation-unknown'
  const requestId = 'request-unknown-42'
  const text = 'Do not duplicate this prompt'
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'agent.retry_send')
      return { type: 'send_pending', request_id: (fields as { request_id: string }).request_id, text, state: 'pending' }
    return {}
  })
  const screen = await mount(
    fake,
    id,
    'tab-unknown',
    draftState(text, { request_id: requestId, text, state: 'pending' }),
  )
  await expect.element(screen.getByText('No retained messages yet.')).toBeVisible()
  fake.pushFrame(
    deliveryFrame(
      id,
      2,
      deliveryMessage(
        'unknown-message',
        text,
        deliveryFor(requestId, 'unknown-message', { native_outcome: 'unknown' }),
      ),
    ),
  )
  await expect.element(screen.getByRole('button', { name: 'Reconcile delivery' })).toBeVisible()
  await expect.element(screen.getByText('Request ID: ' + requestId)).toBeVisible()
  await screen.getByRole('button', { name: 'Reconcile delivery' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.retry_send').length).toBe(1)
  const retry = fake.requests.find(({ op }) => op === 'agent.retry_send')!
  expect((retry.fields as { request_id: string }).request_id).toBe(requestId)
  expect(fake.requests.filter(({ op }) => op === 'agent.send')).toHaveLength(0)
  await expect.element(screen.getByText('Request ID: ' + requestId)).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Prompt' }).element().textContent ?? '').toContain(text)
})

test('a send the daemon refused before admission is editable, never an unknown delivery', async () => {
  previousHost = window.adeHost
  const id = 'conversation-refused'
  const text = 'Look at this image'
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'agent.send') throw new Error('Attachment refused before sending: large.png is too large')
    return {}
  })
  // Main released the refused intent, so the draft has no pending send.
  const screen = await mount(fake, id, 'tab-refused', draftState(text))
  await expect.element(screen.getByText('No retained messages yet.')).toBeVisible()
  await screen.getByRole('button', { name: 'Send prompt' }).click()
  await expect
    .element(screen.getByText('This prompt was not sent. Attachment refused before sending: large.png is too large'))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Edit or retry prompt' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Reconcile delivery' })).not.toBeInTheDocument()
  expect(fake.requests.filter(({ op }) => op === 'agent.send')).toHaveLength(1)
  expect(screen.getByRole('textbox', { name: 'Prompt' }).element().textContent ?? '').toContain(text)
})

test('only accepted evidence clears the prompt; only a matching correlated terminal proves completion', async () => {
  previousHost = window.adeHost
  const id = 'conversation-accepted'
  const text = 'Clear only after accepted'
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'agent.send') return { type: 'ack' }
    return {}
  })
  const screen = await mount(fake, id, 'tab-accepted', draftState(text))
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => prompt.element().textContent).toContain(text)
  await expect.element(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  await prompt.click()
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'agent.send').length).toBe(1)
  await expect
    .element(screen.getByText('Delivery is pending. This prompt and its request ID remain here.'))
    .toBeVisible()
  const sent = fake.requests.find(({ op }) => op === 'agent.send')!.fields as { request_id: string; text: string }
  expect(screen.getByRole('textbox', { name: 'Prompt' }).element().textContent ?? '').toContain(text)
  const messageId = 'accepted-message'
  fake.pushFrame(
    deliveryFrame(
      id,
      2,
      deliveryMessage(
        messageId,
        text,
        deliveryFor(sent.request_id, messageId, {
          native_outcome: 'accepted',
          native_turn_id: 'native-turn-1',
          terminal: {
            correlated: false,
            error: null,
            interrupt_requested: false,
            status: 'completed',
            turn_id: 'other-turn',
          },
        }),
      ),
    ),
  )
  await expect.poll(() => screen.getByRole('textbox', { name: 'Prompt' }).element().textContent).toBe('')
  await expect.element(screen.getByText('Accepted by native agent')).toBeVisible()
  await expect.element(screen.getByText(/Correlated native turn terminal status/)).not.toBeInTheDocument()

  fake.pushFrame(
    deliveryFrame(
      id,
      3,
      deliveryMessage(
        messageId,
        text,
        deliveryFor(sent.request_id, messageId, {
          native_outcome: 'accepted',
          native_turn_id: 'native-turn-1',
          terminal: {
            correlated: true,
            error: null,
            interrupt_requested: false,
            status: 'completed',
            turn_id: 'native-turn-1',
          },
        }),
      ),
    ),
  )
  await expect.element(screen.getByText('Correlated native turn terminal status: completed')).toBeVisible()
})

test('a profile switch while a draft write is pending cannot send the old prompt into the new profile', async () => {
  previousHost = window.adeHost
  const id = 'conversation-profile-switch'
  const saveStarted = deferred<void>()
  const saveReply = deferred<unknown>()
  let activeProfile = 'profile-one'
  const profileListeners = new Set<(state: ProfileState) => void>()
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get')
      return snapshot(id, activeProfile === 'profile-one' ? 'Profile one history' : 'Profile two history')
    if (op === 'draft.save') {
      saveStarted.resolve()
      return saveReply.promise
    }
    if (op === 'agent.send') throw new Error('A stale profile prompt must not be sent')
    return {}
  })
  const screen = await mount(
    fake,
    id,
    'tab-profile-switch',
    () => draftState(activeProfile === 'profile-one' ? 'Profile one prompt' : 'Profile two prompt'),
    {
      getState: async () => profileState(activeProfile),
      onState: (listener) => {
        profileListeners.add(listener)
        return () => profileListeners.delete(listener)
      },
    },
  )
  await expect.element(screen.getByText('Profile one history')).toBeVisible()
  const oldPrompt = screen.getByRole('textbox', { name: 'Prompt' })
  await oldPrompt.click()
  await userEvent.keyboard(' old-account-only')
  await userEvent.keyboard('{Enter}')
  await saveStarted.promise

  activeProfile = 'profile-two'
  for (const listener of profileListeners) listener(profileState(activeProfile))
  await expect.element(screen.getByText('Profile two history')).toBeVisible()
  const newPrompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => newPrompt.element().textContent).toContain('Profile two prompt')
  saveReply.resolve(draftState('Profile one prompt old-account-only'))
  await nextFrame()
  expect(fake.requests.filter(({ op }) => op === 'agent.send')).toHaveLength(0)
  expect(newPrompt.element().textContent ?? '').toContain('Profile two prompt')
})

test('streamed assistant text, reasoning, tool attribution, and Shiki code blocks retain order', async () => {
  previousHost = window.adeHost
  const id = 'conversation-streamed'
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? emptySnapshot(id) : {}))
  const screen = await mount(fake, id, 'tab-streamed')
  await expect.element(screen.getByText('No retained messages yet.')).toBeVisible()
  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 2,
    conversation: snapshot(id, '').conversation,
    requests: [],
    messages: [
      {
        id: 'assistant-stream',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        sequence: 1,
        text: 'Partial **answer**',
      },
      {
        id: 'reasoning-stream',
        role: 'assistant',
        kind: 'reasoning',
        status: 'streaming',
        sequence: 2,
        text: 'Checking the result',
      },
      {
        id: 'tool-stream',
        role: 'assistant',
        kind: 'tool',
        status: 'pending',
        sequence: 3,
        content: {
          type: 'tool',
          name: 'exec_command',
          call_id: 'streamed-call-1',
          input: 'echo hello',
          output: null,
          is_error: false,
        },
      },
    ],
  })
  await expect.element(screen.getByText(/Partial/)).toBeVisible()
  await expect.element(screen.getByText('Checking the result')).toBeVisible()
  await expect.element(screen.getByText('Call streamed-call-1')).toBeVisible()
  const codeText = ['Completed answer', '', '\x60\x60\x60javascript', 'const answer = 42', '\x60\x60\x60'].join('\n')
  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 3,
    conversation: snapshot(id, '').conversation,
    requests: [],
    messages: [
      { id: 'assistant-stream', role: 'assistant', kind: 'text', status: 'completed', sequence: 1, text: codeText },
      {
        id: 'reasoning-stream',
        role: 'assistant',
        kind: 'reasoning',
        status: 'completed',
        sequence: 2,
        text: 'Result verified',
      },
      {
        id: 'tool-stream',
        role: 'assistant',
        kind: 'tool',
        status: 'completed',
        sequence: 3,
        content: {
          type: 'tool',
          name: 'exec_command',
          call_id: 'streamed-call-1',
          input: 'echo hello',
          output: 'hello',
          is_error: false,
        },
      },
    ],
  })
  await expect.element(screen.getByText('Completed answer')).toBeVisible()
  await expect.element(screen.getByText('Result verified')).toBeVisible()
  await expect.element(screen.getByText('hello')).toBeVisible()
  const orderedIds = Array.from(document.querySelectorAll('[data-message-id]')).map((node) =>
    node.getAttribute('data-message-id'),
  )
  expect(orderedIds).toEqual(['assistant-stream', 'reasoning-stream', 'tool-stream'])
  await expect
    .poll(() => document.querySelector('[data-message-id="assistant-stream"] pre.shiki')?.textContent)
    .toContain('const answer = 42')
})

test('a persisted rejected send reopens as editable refusal, not an unknown delivery', async () => {
  previousHost = window.adeHost
  const id = 'conversation-restored-rejection'
  const requestId = 'request-restored-rejection'
  const text = 'Keep this rejected prompt available'
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? emptySnapshot(id) : {}))
  const screen = await mount(
    fake,
    id,
    'tab-restored-rejection',
    draftState(text, { request_id: requestId, text, state: 'rejected' }),
  )
  await expect.element(screen.getByRole('button', { name: 'Edit or retry prompt' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Edit or retry prompt' })).toBeEnabled()
  await expect.element(screen.getByRole('button', { name: 'Reconcile delivery' })).not.toBeInTheDocument()
  await expect.element(screen.getByText('Request ID: ' + requestId)).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Prompt' }).element().textContent ?? '').toContain(text)
})

test('a queued draft save flushed after account change does not write into the successor account context', async () => {
  previousHost = window.adeHost
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const id = 'conversation-queued-account-save'
  const firstSaveStarted = deferred<void>()
  const firstSaveReply = deferred<unknown>()
  const firstDraftRead = deferred<ReturnType<typeof draftState>>()
  const accountStore = createStore<DaemonState>()(() => emptyDaemon)
  const accountDrafts = new Map([
    ['boot-1', { text: 'Account one prompt', revision: 7 }],
    ['boot-2', { text: 'Account two prompt', revision: 11 }],
  ])
  const saves: Array<{ bootId: string | null; text: string }> = []
  const fake = createFakeHost(async (op, fields) => {
    const bootId = accountStore.getState().bootId
    const accountId = bootId ?? 'boot-1'
    if (op === 'conversation.get')
      return snapshot(id, accountId === 'boot-1' ? 'Account one history' : 'Account two history')
    if (op === 'draft.save') {
      const text = (fields as { text: string }).text
      const current = accountDrafts.get(accountId)!
      accountDrafts.set(accountId, { text, revision: current.revision + 1 })
      saves.push({ bootId, text })
      if (saves.length === 1) {
        firstSaveStarted.resolve()
        return firstSaveReply.promise
      }
      return draftState(text)
    }
    return {}
  })
  const screen = await mount(
    fake,
    id,
    'tab-queued-account-save',
    () => {
      const accountId = accountStore.getState().bootId ?? 'boot-1'
      if (accountId === 'boot-1') return firstDraftRead.promise
      const saved = accountDrafts.get(accountId)!
      const state = draftState(saved.text)
      state.draft.revision = saved.revision
      return state
    },
    {},
    accountStore,
  )
  await expect.element(screen.getByText('Account one history')).toBeVisible()
  const oldPrompt = screen.getByRole('textbox', { name: 'Prompt' })
  expect(oldPrompt.element().textContent).toBe('')
  await vi.advanceTimersByTimeAsync(250)
  expect(saves).toEqual([])
  expect(accountDrafts.get('boot-1')).toEqual({ text: 'Account one prompt', revision: 7 })

  const originalDraft = draftState('Account one prompt')
  originalDraft.draft.revision = 7
  firstDraftRead.resolve(originalDraft)
  await expect.element(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  expect(oldPrompt.element().textContent).toBe('Account one prompt')
  await vi.advanceTimersByTimeAsync(250)
  expect(saves).toEqual([])
  expect(accountDrafts.get('boot-1')).toEqual({ text: 'Account one prompt', revision: 7 })

  vi.useRealTimers()
  await oldPrompt.fill('Account one prompt first')
  await firstSaveStarted.promise
  expect(saves).toEqual([{ bootId: 'boot-1', text: 'Account one prompt first' }])
  expect(accountDrafts.get('boot-1')).toEqual({ text: 'Account one prompt first', revision: 8 })
  await oldPrompt.fill('Account one prompt first second')

  accountStore.setState((state) => ({ ...state, bootId: 'boot-2' }))
  await expect.element(screen.getByText('Account two history')).toBeVisible()
  const newPrompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => newPrompt.element().textContent).toBe('Account two prompt')
  firstSaveReply.resolve(draftState('Account one prompt first'))
  await nextFrame()
  expect(saves).toEqual([{ bootId: 'boot-1', text: 'Account one prompt first' }])
  expect(accountDrafts.get('boot-1')).toEqual({ text: 'Account one prompt first', revision: 8 })
  expect(accountDrafts.get('boot-2')).toEqual({ text: 'Account two prompt', revision: 11 })
  expect(newPrompt.element().textContent).toBe('Account two prompt')
})

test('closing a view flushes its draft when the profile and account context still match', async () => {
  previousHost = window.adeHost
  const id = 'conversation-simple-close'
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'draft.save') return draftState((fields as { text: string }).text)
    return {}
  })
  const screen = await mount(fake, id, 'tab-simple-close')
  await expect.element(screen.getByText('No retained messages yet.')).toBeVisible()
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => prompt.element().getAttribute('contenteditable')).toBe('true')
  await prompt.click()
  await userEvent.keyboard('Persist this draft on close')
  await screen.unmount()
  // Edits are written as they happen; closing must still save the last of them.
  const saves = () =>
    fake.requests.filter(({ op }) => op === 'draft.save').map(({ fields }) => (fields as { text: string }).text)
  await expect.poll(() => saves().at(-1)).toBe('Persist this draft on close')
})

test('an account switch while a draft save settles prevents a waiting prompt from being sent', async () => {
  previousHost = window.adeHost
  const id = 'conversation-submit-account-race'
  const saveStarted = deferred<void>()
  const saveReply = deferred<unknown>()
  const accountStore = createStore<DaemonState>()(() => emptyDaemon)
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return emptySnapshot(id)
    if (op === 'draft.save') {
      saveStarted.resolve()
      return saveReply.promise
    }
    return {}
  })
  const screen = await mount(
    fake,
    id,
    'tab-submit-account-race',
    draftState('Keep account one prompt'),
    {},
    accountStore,
  )
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => prompt.element().textContent).toContain('Keep account one prompt')
  await prompt.click()
  await userEvent.keyboard(' revised')
  await saveStarted.promise
  await userEvent.keyboard('{Enter}')

  accountStore.setState((state) => ({ ...state, bootId: 'boot-2' }))
  saveReply.resolve(draftState('Keep account one prompt revised'))
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(fake.requests.filter(({ op }) => op === 'agent.send')).toHaveLength(0)
})

test('an account switch before a retry dispatch prevents retrying the old account request', async () => {
  previousHost = window.adeHost
  const id = 'conversation-retry-account-race'
  const accountStore = createStore<DaemonState>()(() => emptyDaemon)
  const requestId = 'request-account-one'
  const text = 'Keep the account one request'
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? emptySnapshot(id) : {}))
  const screen = await mount(
    fake,
    id,
    'tab-retry-account-race',
    draftState(text, { request_id: requestId, text, state: 'pending' }),
    {},
    accountStore,
  )
  const retry = screen.getByRole('button', { name: 'Reconcile delivery' })
  await expect.element(retry).toBeVisible()

  accountStore.setState((state) => ({ ...state, bootId: 'boot-2' }))
  retry.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(fake.requests.filter(({ op }) => op === 'agent.retry_send')).toHaveLength(0)
})

test('a profile event before the initial profile read resolves keeps the newer profile context', async () => {
  previousHost = window.adeHost
  const id = 'conversation-profile-read-race'
  const initialRead = deferred<ProfileState>()
  const subscribed = deferred<void>()
  let notify!: (state: ProfileState) => void
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? emptySnapshot(id) : {}))
  const screen = await mount(fake, id, 'tab-profile-read-race', draftState('Profile prompt'), {
    getState: () => initialRead.promise,
    onState: (listener) => {
      notify = listener
      subscribed.resolve()
      return () => undefined
    },
  })
  await subscribed.promise
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'draft.get').length).toBe(1)
  notify(profileState('profile-new'))
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'draft.get').length).toBe(2)
  initialRead.resolve(profileState('profile-old'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fake.requests.filter(({ op }) => op === 'draft.get')).toHaveLength(2)
  await expect.element(screen.getByText('No retained messages yet.')).toBeVisible()
})
