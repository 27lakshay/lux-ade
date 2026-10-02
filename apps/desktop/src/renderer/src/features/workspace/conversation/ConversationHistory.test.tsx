import { afterEach, expect, test } from 'vitest'
import { createFakeHost, nextFrame } from '../../../state/fake-host'
import { deferred, mount, snapshot } from './ConversationTestSupport'

let previousHost: typeof window.adeHost

afterEach(() => {
  window.adeHost = previousHost
})

test('a failed initial history read shows the daemon reason and an explicit user retry', async () => {
  previousHost = window.adeHost
  let reads = 0
  const fake = createFakeHost(async () => {
    reads++
    if (reads === 1) throw new Error('Temporary conversation lookup failure')
    return snapshot('conversation-retry', 'Recovered retained message')
  })
  const screen = await mount(fake, 'conversation-retry', 'tab-retry')
  await expect.poll(() => fake.requests.filter(({ op }) => op === 'conversation.get').length).toBe(1)
  await expect.element(screen.getByText(/Temporary conversation lookup failure/)).toBeVisible()
  await screen.getByRole('button', { name: 'Retry history' }).click()
  await expect.element(screen.getByText('Recovered retained message')).toBeVisible()
})
test('keeps the admitted snapshot visible and offers a read-only refresh after resource recovery fails', async () => {
  previousHost = window.adeHost
  let reads = 0
  const refresh = deferred<ReturnType<typeof snapshot>>()
  const fake = createFakeHost(async (op) => {
    if (op !== 'conversation.get') return {}
    reads++
    if (reads === 1) return snapshot('conversation-resource', 'Retained snapshot before refresh')
    if (reads === 2) throw new Error('Automatic resnapshot unavailable')
    return refresh.promise
  })
  const screen = await mount(fake, 'conversation-resource', 'tab-resource')
  await expect.element(screen.getByText('Retained snapshot before refresh')).toBeVisible()
  const current = snapshot('conversation-resource', '').conversation
  fake.pushFrame({
    type: 'conversation_changed',
    boot_id: 'boot-1',
    revision: 2,
    conversation: current,
    messages: [
      { id: 'over-budget-message', role: 'assistant', kind: 'text', sequence: 2, text: 'x'.repeat(9 * 1024 * 1024) },
    ],
    requests: [],
  })
  await expect.poll(() => reads).toBe(2)
  await expect.element(screen.getByText('Retained snapshot before refresh')).toBeVisible()
  await expect.element(screen.getByText(/Conversation history may be out of date/)).toBeVisible()

  await screen.getByRole('button', { name: 'Refresh conversation history' }).click()
  await expect.poll(() => reads).toBe(3)
  await expect.element(screen.getByText('Retained snapshot before refresh')).toBeVisible()
  expect(fake.requests.some(({ op }) => op === 'agent.send')).toBe(false)
  refresh.resolve(snapshot('conversation-resource', 'Snapshot after refresh'))
  await expect.element(screen.getByText('Snapshot after refresh')).toBeVisible()
})

test('marks capped native history incomplete and keeps its explicit refresh reachable', async () => {
  previousHost = window.adeHost
  const historyRequests: Record<string, unknown>[] = []
  const nativeSnapshot = {
    provider: 'codex',
    execution_id: 'execution-limit',
    generation: 'generation-limit',
    session: 'session-limit',
    source: 'thread-limit',
    consistency: 'best_effort',
    invalidation_epoch: 0,
    size_bytes: null,
    account_id: null,
    lineage: null,
    modified_at_ms: null,
  }
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get')
      return { ...snapshot('conversation-limit', 'Live conversation evidence'), history_epoch: 0 }
    if (op !== 'conversation.history') return {}
    const request = fields as Record<string, unknown>
    historyRequests.push(request)
    const cursor = request.native_cursor
    if (cursor !== null && typeof cursor !== 'string')
      throw new TypeError('Native history cursor must be a string or null.')
    const page = cursor === null ? 0 : Number(cursor.slice('native:'.length))
    return {
      type: 'conversation_history',
      complete: false,
      conversation_id: 'conversation-limit',
      error: null,
      history_epoch: 0,
      messages: Array.from({ length: 32 }, (_, index) => ({
        id: 'native-' + (page * 32 + index),
        sequence: 0,
        text: 'Native observation ' + (page * 32 + index),
        conversation_id: 'conversation-limit',
        kind: 'text',
        provider_item_id: null,
        role: 'assistant',
        status: 'completed',
        turn_id: null,
      })),
      next_native_cursor: 'native:' + (page + 1),
      retained_bytes: 2_000,
      snapshot: nativeSnapshot,
      stale: false,
    }
  })
  const screen = await mount(fake, 'conversation-limit', 'tab-limit')
  await expect.poll(() => historyRequests.length).toBe(1)
  for (let page = 0; page < 16; page++) {
    await screen.getByRole('button', { name: 'Load more native history' }).click()
    await expect.poll(() => historyRequests.length).toBe(page + 2)
  }
  await expect.element(screen.getByText(/Native history is incomplete/)).toBeVisible()
  const refresh = screen.getByRole('button', { name: 'Refresh conversation history' })
  await expect.element(refresh).toBeVisible()
  await refresh.click()
  await expect.poll(() => historyRequests.length).toBe(18)
  await expect.element(screen.getByRole('button', { name: 'Load more native history' })).toBeVisible()
})
test('keeps native source order, overlays exact ADE identity, and isolates unmatched current evidence', async () => {
  previousHost = window.adeHost
  const historyRequests: Record<string, unknown>[] = []
  const nativeSnapshot = {
    provider: 'codex',
    execution_id: 'execution-history',
    generation: 'generation-history',
    session: 'session-history',
    source: 'thread-history',
    consistency: 'best_effort',
    invalidation_epoch: 0,
    size_bytes: null,
    account_id: null,
    lineage: null,
    modified_at_ms: null,
  }
  const nativeMessage = (id: string, sequence: number, text: string) => ({
    id,
    sequence,
    text,
    conversation_id: 'conversation-native',
    kind: 'text',
    provider_item_id: null,
    role: 'assistant',
    status: 'completed',
    turn_id: null,
  })
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get')
      return {
        ...snapshot('conversation-native', 'Live message'),
        history_epoch: 0,
        messages: [
          nativeMessage('native-shared', 7, 'Exact identity overlay'),
          nativeMessage('live-first', 8, 'Current ADE first'),
          nativeMessage('live-second', 9, 'Current ADE second'),
        ],
      }
    if (op === 'conversation.history') {
      historyRequests.push(fields as Record<string, unknown>)
      return {
        type: 'conversation_history',
        complete: historyRequests.length > 1,
        conversation_id: 'conversation-native',
        error: null,
        history_epoch: 0,
        messages:
          historyRequests.length === 1
            ? [
                nativeMessage('native-shared', 0, 'Source copy before exact overlay'),
                nativeMessage('native-unknown', 0, 'Unmatched unknown-sequence observation'),
              ]
            : [nativeMessage('native-next', 0, 'Next source observation')],
        next_native_cursor: historyRequests.length === 1 ? 'native:cursor-1' : null,
        retained_bytes: 45,
        snapshot: nativeSnapshot,
        stale: false,
      }
    }
    return {}
  })
  const screen = await mount(fake, 'conversation-native', 'tab-native')
  await expect.element(screen.getByText('Source copy before exact overlay')).not.toBeInTheDocument()
  await expect.element(screen.getByText('Exact identity overlay')).toBeVisible()
  await expect.element(screen.getByText('Unmatched unknown-sequence observation')).toBeVisible()
  await expect.element(screen.getByText('Current ADE first')).toBeVisible()
  await expect.element(screen.getByText('Current ADE second')).toBeVisible()
  await expect.element(screen.getByText(/Native history is best effort/)).toBeVisible()
  await screen.getByRole('button', { name: 'Load more native history' }).click()
  await expect.element(screen.getByText('Next source observation')).toBeVisible()
  expect(
    historyRequests.map(({ conversation_id, history_epoch, native_cursor, snapshot }) => ({
      conversation_id,
      history_epoch,
      native_cursor,
      snapshot,
    })),
  ).toEqual([
    { conversation_id: 'conversation-native', history_epoch: 0, native_cursor: null, snapshot: null },
    {
      conversation_id: 'conversation-native',
      history_epoch: 0,
      native_cursor: 'native:cursor-1',
      snapshot: nativeSnapshot,
    },
  ])
  expect(
    [...document.querySelectorAll<HTMLElement>('[aria-label="Native history messages"] [data-message-id]')].map(
      (element) => element.dataset.messageId,
    ),
  ).toEqual(['native-shared', 'native-unknown', 'native-next'])
  expect(
    [...document.querySelectorAll<HTMLElement>('[aria-label="Current ADE messages"] [data-message-id]')].map(
      (element) => element.dataset.messageId,
    ),
  ).toEqual(['live-first', 'live-second'])
  expect(document.querySelectorAll('[data-message-id="native-shared"]')).toHaveLength(1)
})
test('announces matching stale native history and lets the person retry that exact page', async () => {
  previousHost = window.adeHost
  let reads = 0
  const historyRequests: Record<string, unknown>[] = []
  const nativeSnapshot = {
    provider: 'codex',
    execution_id: 'execution-stale',
    generation: 'generation-stale',
    session: 'session-stale',
    source: 'thread-history',
    consistency: 'best_effort',
    invalidation_epoch: 0,
    size_bytes: null,
    account_id: null,
    lineage: null,
    modified_at_ms: null,
  }
  const message = (text: string) => ({
    id: 'cached-history-message',
    sequence: 0,
    text,
    conversation_id: 'conversation-stale',
    kind: 'text',
    provider_item_id: null,
    role: 'assistant',
    status: 'completed',
    turn_id: null,
  })
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') return { ...snapshot('conversation-stale', ''), history_epoch: 0, messages: [] }
    if (op === 'conversation.history') {
      historyRequests.push(fields as Record<string, unknown>)
      reads++
      return reads === 1
        ? {
            type: 'conversation_history',
            complete: false,
            conversation_id: 'conversation-stale',
            error: { code: 'timeout', message: 'Using matching cached history.' },
            history_epoch: 0,
            messages: [message('Cached history while the provider is unavailable')],
            next_native_cursor: 'must-not-be-used',
            retained_bytes: 60,
            snapshot: nativeSnapshot,
            stale: true,
          }
        : {
            type: 'conversation_history',
            complete: true,
            conversation_id: 'conversation-stale',
            error: null,
            history_epoch: 0,
            messages: [message('Fresh matching history')],
            next_native_cursor: null,
            retained_bytes: 52,
            snapshot: nativeSnapshot,
            stale: false,
          }
    }
    return {}
  })
  const screen = await mount(fake, 'conversation-stale', 'tab-stale')
  await expect.element(screen.getByText('Cached history while the provider is unavailable')).toBeVisible()
  await expect.element(screen.getByText(/Native history may be incomplete or out of date/)).toBeVisible()
  await expect.element(screen.getByText(/Native history failure: timeout/)).toBeVisible()
  await screen.getByRole('button', { name: 'Retry native history' }).click()
  await expect.element(screen.getByText('Fresh matching history')).toBeVisible()
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
  expect(historyRequests.map(({ native_cursor, snapshot }) => ({ native_cursor, snapshot }))).toEqual([
    { native_cursor: null, snapshot: null },
    { native_cursor: null, snapshot: nativeSnapshot },
  ])
})

test('keeps the visible native history item at the same viewport offset when another source page is appended', async () => {
  previousHost = window.adeHost
  const historyRequests: Record<string, unknown>[] = []
  const nativeSnapshot = {
    provider: 'codex',
    execution_id: 'execution-scroll',
    generation: 'generation-scroll',
    session: 'session-scroll',
    source: 'thread-history',
    consistency: 'best_effort',
    invalidation_epoch: 0,
    size_bytes: null,
    account_id: null,
    lineage: null,
    modified_at_ms: null,
  }
  const liveMessages = Array.from({ length: 30 }, (_, index) => ({
    id: 'live-' + index,
    role: 'user',
    kind: 'text',
    sequence: index + 1,
    status: 'completed',
    text: 'Live message ' + index,
  }))
  const nativeMessage = (index: number) => ({
    id: 'native-' + index,
    sequence: 0,
    text: 'Native message ' + index,
    conversation_id: 'conversation-scroll',
    kind: 'text',
    provider_item_id: null,
    role: 'assistant',
    status: 'completed',
    turn_id: null,
  })
  const fake = createFakeHost(async (op, fields) => {
    if (op === 'conversation.get') {
      return { ...snapshot('conversation-scroll', 'Live message'), history_epoch: 0, messages: liveMessages }
    }
    if (op === 'conversation.history') {
      historyRequests.push(fields as Record<string, unknown>)
      return {
        type: 'conversation_history',
        complete: historyRequests.length > 1,
        conversation_id: 'conversation-scroll',
        error: null,
        history_epoch: 0,
        messages:
          historyRequests.length === 1
            ? Array.from({ length: 30 }, (_, index) => nativeMessage(index))
            : Array.from({ length: 4 }, (_, index) => nativeMessage(30 + index)),
        next_native_cursor: historyRequests.length === 1 ? 'next-page' : null,
        retained_bytes: 40,
        snapshot: nativeSnapshot,
        stale: false,
      }
    }
    return {}
  })
  const screen = await mount(fake, 'conversation-scroll', 'tab-scroll')
  await expect.element(screen.getByText('Native message 0')).toBeVisible()
  const viewport = document.querySelector<HTMLElement>(
    '[aria-label="Native history messages"] [data-slot="scroll-area-viewport"]',
  )!
  viewport.scrollTop = 700
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 700, bubbles: true }))
  viewport.dispatchEvent(new Event('scroll'))
  await nextFrame()
  const visible = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find((element) => {
    const rect = element.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  })!
  const anchorId = visible.dataset.messageId!
  const anchorOffset = visible.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  await screen.getByRole('button', { name: 'Load more native history' }).click()
  await expect.poll(() => historyRequests.length).toBe(2)
  await expect
    .poll(
      () =>
        document.querySelector(
          '[data-conversation-id="conversation-scroll"] [aria-label="Native history controls"] button',
        ) === null,
    )
    .toBe(true)
  await expect
    .poll(() => {
      const currentViewport = document.querySelector<HTMLElement>(
        '[aria-label="Native history messages"] [data-slot="scroll-area-viewport"]',
      )!
      const currentAnchor = [...currentViewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (element) => element.dataset.messageId === anchorId,
      )
      return currentAnchor
        ? Math.abs(
            currentAnchor.getBoundingClientRect().top - currentViewport.getBoundingClientRect().top - anchorOffset,
          )
        : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(3)
})

test('oversized tool history retains identity and marks input and output excerpts', async () => {
  previousHost = window.adeHost
  const inputTail = 'INPUT_TAIL_42'
  const outputTail = 'OUTPUT_TAIL_42'
  const fake = createFakeHost(async () => ({
    conversation: {
      id: 'conversation-tool',
      title: 'Tool history',
      workspace_id: 'workspace-1',
      provider: 'codex',
      account_context: 'ambient',
      account_id: null,
      execution_host: { kind: 'local' },
    },
    messages: [
      {
        id: 'tool-message',
        role: 'assistant',
        kind: 'tool',
        status: 'completed',
        sequence: 1,
        content: {
          type: 'tool',
          name: 'exec_command',
          call_id: 'tool-call-42',
          input: 'i'.repeat(5_000) + inputTail,
          output: 'o'.repeat(5_000) + outputTail,
          is_error: true,
        },
      },
    ],
    requests: [],
    revision: 1,
    boot_id: 'boot-1',
  }))
  const screen = await mount(fake, 'conversation-tool', 'tab-tool')
  await expect.element(screen.getByText('exec_command')).toBeVisible()
  await expect.element(screen.getByText(/tool-call-42/)).toBeVisible()
  await expect.element(screen.getByText('Failed')).toBeVisible()
  await expect.element(screen.getByText(/Input excerpt/)).toBeVisible()
  await expect.element(screen.getByText(/Failure output excerpt/)).toBeVisible()
  const summary = document.querySelector('[data-message-id="tool-message"] [data-kind="tool-summary"]')!
  expect(summary.textContent).not.toContain(inputTail)
  expect(summary.textContent).not.toContain(outputTail)
})

test('tool history does not call incomplete or unknown states completed', async () => {
  previousHost = window.adeHost
  const states = [
    ['pending-tool', 'pending', 'Pending'],
    ['streaming-tool', 'streaming', 'In progress'],
    ['interrupted-tool', 'interrupted', 'Interrupted'],
    ['cancelled-tool', 'cancelled', 'Cancelled'],
    ['unknown-tool', 'future_state', 'Unknown status (future_state)'],
    ['completed-tool', 'completed', 'Completed'],
    ['incomplete-tool', 'completed', 'Incomplete'],
  ] as const
  const fake = createFakeHost(async () => ({
    conversation: {
      id: 'conversation-tool-states',
      title: 'Tool states',
      workspace_id: 'workspace-1',
      provider: 'codex',
      account_context: 'ambient',
      account_id: null,
      execution_host: { kind: 'local' },
    },
    messages: states.map(([id, status], index) => ({
      id,
      role: 'assistant',
      kind: 'tool',
      status,
      sequence: index + 1,
      text: '',
      content: {
        type: 'tool',
        name: 'exec_command',
        call_id: id,
        input: null,
        output: id === 'completed-tool' ? 'native result' : null,
        is_error: false,
      },
    })),
    requests: [],
    revision: 1,
    boot_id: 'boot-1',
  }))
  const screen = await mount(fake, 'conversation-tool-states', 'tab-tool-states')
  for (const [, , label] of states) await expect.element(screen.getByText(label)).toBeVisible()
})

test('a read completing after a view is disposed cannot populate its successor view', async () => {
  previousHost = window.adeHost
  const pending = deferred<unknown>()
  const staleReadFinished = deferred<void>()
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const fake = createFakeHost(async (_op, fields) => {
    const id = fields && typeof fields === 'object' && 'conversation_id' in fields ? fields.conversation_id : null
    if (id === 'conversation-departed') {
      markStarted()
      return pending.promise.then((value) => {
        staleReadFinished.resolve()
        return value
      })
    }
    return snapshot(typeof id === 'string' ? id : '', 'Successor retained message')
  })

  const departed = await mount(fake, 'conversation-departed', 'tab-departed')
  await started
  await departed.unmount()
  const successor = await mount(fake, 'conversation-successor', 'tab-successor')
  await expect.element(successor.getByText('Successor retained message')).toBeVisible()
  pending.resolve(snapshot('conversation-departed', 'Departed stale message'))
  await staleReadFinished.promise
  await nextFrame()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect.element(successor.getByText('Successor retained message')).toBeVisible()
  await expect.element(successor.getByText('Departed stale message')).not.toBeInTheDocument()
})
