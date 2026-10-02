import { render } from 'vitest-browser-react'
import { createStore } from 'zustand/vanilla'
import type { DaemonState, DaemonStore } from '../../../state/daemon-store'
import type { createFakeHost } from '../../../state/fake-host'
import { DaemonStoreContext } from '../../../state/hooks'
import { ConversationContent } from './ConversationContent'
import type { ConversationOperation } from '../../../../../shared/bridge/operations'
import type { DraftState } from '../../../../../shared/bridge/conversations'
import type { SubmissionDelivery } from '@ade/contracts'
import type { ProfileState } from '../../../../../shared/bridge/types'

export const emptyDaemon: DaemonState = {
  status: 'connected',
  detail: '',
  bootId: 'boot-1',
  revision: 1,
  workspaceIds: [],
  workspaces: {},
  conversationIds: [],
  conversations: {},
  terminals: {},
  projects: {},
  windows: {},
}

export const snapshot = (id: string, text: string) => ({
  conversation: {
    id,
    title: id,
    workspace_id: 'workspace-1',
    provider: 'codex',
    account_context: 'ambient',
    account_id: null,
    execution_host: { kind: 'local' },
  },
  messages: [{ id: `message-${id}`, role: 'user', kind: 'text', sequence: 1, text }],
  requests: [],
  revision: 1,
  boot_id: 'boot-1',
})

export const emptySnapshot = (id: string) => ({ ...snapshot(id, ''), messages: [] })

export const deliveryFor = (
  request_id: string,
  recoverable_message_id: string,
  overrides: Partial<SubmissionDelivery> = {},
): SubmissionDelivery => ({
  request_id,
  recoverable_message_id,
  admitted: true,
  dispatch: 'dispatched',
  native_outcome: 'pending',
  native_turn_id: null,
  terminal: null,
  error: null,
  recovery: null,
  ...overrides,
})

export const deliveryMessage = (id: string, text: string, delivery: SubmissionDelivery) => ({
  id,
  role: 'user',
  kind: 'text',
  sequence: 2,
  status: 'completed',
  text,
  delivery,
})

export const deliveryFrame = (conversationId: string, revision: number, message: unknown) => ({
  type: 'conversation_changed',
  boot_id: 'boot-1',
  revision,
  conversation: {
    id: conversationId,
    title: conversationId,
    workspace_id: 'workspace-1',
    provider: 'codex',
    account_context: 'ambient',
    account_id: null,
    execution_host: { kind: 'local' },
  },
  messages: [message],
  requests: [],
})
export const deferred = <T,>() => {
  const { promise, resolve } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void }
    }
  ).withResolvers<T>()
  return { promise, resolve }
}

export const draftState = (text = '', send_pending: DraftState['send_pending'] = null): DraftState => ({
  type: 'draft',
  draft: { text, revision: 0, attachments: [] },
  error: '',
  sent_text: '',
  send_pending,
})

export const profileState = (id: string): ProfileState => ({
  managed: false,
  profiles: [{ id, name: id, selected: true, home: '/tmp' }],
  selectedId: id,
  activeId: id,
  error: '',
})

export async function mount(
  fake: ReturnType<typeof createFakeHost>,
  conversationId: string,
  tabId: string,
  initialDraft: DraftState | Promise<DraftState> | (() => DraftState | Promise<DraftState>) = draftState(),
  profileOverrides: Partial<NonNullable<typeof window.adeHost>['profiles']> = {},
  daemonStore?: DaemonStore,
) {
  const conversations = fake.host.conversations
  const originalRequest = conversations.request.bind(conversations) as (
    operation: ConversationOperation,
    requestFields: unknown,
  ) => Promise<unknown>
  const host = {
    ...fake.host,
    profiles: { ...fake.host.profiles, ...profileOverrides },
    conversations: {
      ...conversations,
      request: (async (op: ConversationOperation, fields: unknown) => {
        if (op === 'draft.get') {
          fake.requests.push({ op, fields })
          return typeof initialDraft === 'function' ? initialDraft() : initialDraft
        }
        return originalRequest(op, fields)
      }) as NonNullable<typeof window.adeHost>['conversations']['request'],
    },
  }
  window.adeHost = host as unknown as NonNullable<typeof window.adeHost>
  const store = daemonStore ?? createStore<DaemonState>()(() => emptyDaemon)
  return render(
    <DaemonStoreContext value={store}>
      <ConversationContent conversationId={conversationId} tabId={tabId} />
    </DaemonStoreContext>,
  )
}
