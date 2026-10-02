import { afterEach, expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createFakeHost } from '../../../state/fake-host'
import {
  deliveryFor,
  deliveryFrame,
  deliveryMessage,
  draftState,
  emptySnapshot,
  mount,
} from './ConversationTestSupport'

let previousHost: typeof window.adeHost

afterEach(() => {
  window.adeHost = previousHost
})

function running(id: string, extra: Record<string, unknown> = {}) {
  const base = emptySnapshot(id)
  return {
    ...base,
    conversation: {
      ...base.conversation,
      status: 'running',
      runtime_run: 'attempt-1',
      runtime_submission: 'submission-1',
      active_turn_id: 'turn-1',
      queue_paused: false,
    },
    queued: [] as Array<{ id: string; conversation_id: string; text: string; status: string }>,
    ...extra,
  }
}

const controls = (id: string, steer: { available: boolean; reason: string | null }) => ({
  type: 'conversation_controls',
  conversation_id: id,
  provider: 'codex',
  controls: [
    {
      control: 'steer',
      available: steer.available,
      mechanism: steer.available ? 'turn/steer' : null,
      reason: steer.reason,
    },
  ],
  snooze: null,
})

test('Steer targets the running turn, never sends, and clears the draft once the turn takes the input', async () => {
  previousHost = window.adeHost
  const id = 'conversation-steer'
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return running(id)
    if (op === 'conversation.controls') return controls(id, { available: true, reason: null })
    if (op === 'conversation.steer') {
      const request = fields as { operation_id: string; turn_id: string }
      return {
        type: 'conversation_control',
        operation_id: request.operation_id,
        conversation_id: id,
        control: 'steer',
        outcome: 'acknowledged',
        reason: null,
        turn_id: request.turn_id,
        files: null,
      }
    }
    return {}
  })
  const screen = await mount(fake, id, 'tab-steer', draftState('Look at the tests too'))
  await expect.element(screen.getByRole('button', { name: 'Steer turn' })).toBeEnabled()
  await expect.element(screen.getByRole('button', { name: 'Send prompt' })).not.toBeInTheDocument()
  await screen.getByRole('button', { name: 'Steer turn' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'conversation.steer').length).toBe(1)
  expect(fake.requests.find(({ op }) => op === 'conversation.steer')!.fields).toMatchObject({
    conversation_id: id,
    turn_id: 'turn-1',
    text: 'Look at the tests too',
  })
  expect(fake.requests.filter(({ op }) => op === 'agent.send' || op === 'queue.enqueue')).toHaveLength(0)
  await expect
    .poll(() => fake.requests.some(({ op, fields }) => op === 'draft.save' && (fields as { text: string }).text === ''))
    .toBe(true)
})

test('unsupported steering stays explicit, Queue adds to ADE’s queue and Remove only drops the ADE entry', async () => {
  previousHost = window.adeHost
  const id = 'conversation-queue'
  const reply = running(id)
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return reply
    if (op === 'conversation.controls')
      return controls(id, { available: false, reason: 'the Claude adapter has no native steer path' })
    if (op === 'queue.enqueue' || op === 'queue.cancel') return { type: 'ack' }
    return {}
  })
  const screen = await mount(fake, id, 'tab-queue', draftState('Then update the docs'))
  await expect.element(screen.getByRole('button', { name: 'Steer turn' })).toBeDisabled()
  await expect
    .poll(() => document.body.textContent)
    .toContain('Steering is unavailable: the Claude adapter has no native steer path.')
  await screen.getByRole('button', { name: 'Queue prompt' }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'queue.enqueue').length).toBe(1)
  const enqueued = fake.requests.find(({ op }) => op === 'queue.enqueue')!.fields as {
    request_id: string
    text: string
  }
  expect(enqueued.text).toBe('Then update the docs')
  expect(fake.requests.filter(({ op }) => op === 'agent.send' || op === 'conversation.steer')).toHaveLength(0)

  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 2,
    conversation: reply.conversation,
    messages: [],
    requests: [],
    queued: [{ id: enqueued.request_id, conversation_id: id, text: 'Then update the docs', status: 'queued' }],
  })
  const queue = screen.getByRole('region', { name: 'Queued prompts' })
  await expect.poll(() => queue.element().textContent).toContain("Waiting in ADE's queue · not sent to the provider")
  await screen.getByRole('button', { name: "Remove queued prompt 1 from ADE's queue" }).click()
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'queue.cancel').length).toBe(1)
  expect(fake.requests.find(({ op }) => op === 'queue.cancel')!.fields).toEqual({
    conversation_id: id,
    request_id: enqueued.request_id,
  })
})

test('Enter while a turn runs neither sends nor picks Queue or Steer', async () => {
  previousHost = window.adeHost
  const id = 'conversation-enter-busy'
  const fake = createFakeHost(async (op) => {
    if (op === 'conversation.get') return running(id)
    if (op === 'conversation.controls') return controls(id, { available: true, reason: null })
    return {}
  })
  const screen = await mount(fake, id, 'tab-enter-busy', draftState('Do not send me'))
  const prompt = screen.getByRole('textbox', { name: 'Prompt' })
  await expect.poll(() => prompt.element().textContent).toContain('Do not send me')
  await expect.element(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
  await prompt.click()
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => document.body.textContent).toContain('Choose Queue prompt or Steer turn.')
  expect(
    fake.requests.filter(({ op }) => op === 'agent.send' || op === 'queue.enqueue' || op === 'conversation.steer'),
  ).toHaveLength(0)
})

test('a sent prompt shows whether the adapter holds it or the native agent has it', async () => {
  previousHost = window.adeHost
  const id = 'conversation-ownership'
  const fake = createFakeHost(async (op) => (op === 'conversation.get' ? emptySnapshot(id) : {}))
  const screen = await mount(fake, id, 'tab-ownership')
  const frame = (revision: number, overrides: Parameters<typeof deliveryFor>[2]) =>
    fake.pushFrame(
      deliveryFrame(id, revision, deliveryMessage('owned', 'hello', deliveryFor('owned', 'owned', overrides))),
    )
  frame(2, { dispatch: 'pending', native_outcome: 'pending' })
  await expect
    .element(screen.getByText('Held by the provider adapter; the native agent has not taken it yet'))
    .toBeVisible()
  frame(3, { dispatch: 'dispatched', native_outcome: 'pending' })
  await expect.element(screen.getByText('Sent to the native agent; awaiting its acceptance')).toBeVisible()
  frame(4, { dispatch: 'dispatched', native_outcome: 'accepted' })
  await expect.element(screen.getByText('Accepted by native agent')).toBeVisible()
})
