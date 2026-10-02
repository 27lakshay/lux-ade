import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { startNativeHistoryProjection, type NativeHistoryState } from '@ade/client/history'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { Meta, Text, Title } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { ConversationComposer } from '../../../provisional/ConversationComposer'
import { NativeRequests } from '../../../provisional/NativeRequests'
import {
  createConversationStore,
  type ConversationMessage,
  type ConversationState,
} from '../../../state/conversation-store'
import { DaemonStoreContext, useDaemon } from '../../../state/hooks'
import type { DaemonState } from '../../../state/daemon-store'
import type { TabTarget } from '../model/layout'
import { openTabInAnother } from '../model/layout-store'
import type { ProfileState } from '../../../../../shared/bridge/types'
import { StopStatus } from '@/provisional/StopStatus'
import { QueuedPrompts } from '@/provisional/QueuedPrompts'
import { ExecutionBinding } from '@/provisional/ExecutionBinding'
import { RewindScope } from '@/provisional/Rewind'
import { ProviderSettingsPanel } from '@/provisional/ProviderSettingsPanel'
import type { QueuedPrompt } from '@ade/contracts'
import { PaneState } from './ConversationContentStates'
import { ConversationHistorySections } from './ConversationHistorySections'
import { useStopControls } from './useStopControls'

const EMPTY_MESSAGES: ConversationMessage[] = []

function accountIdentityFor(state: DaemonState, conversationId: string): string {
  const conversation = state.conversations[conversationId]
  return JSON.stringify([
    state.bootId,
    conversation?.workspace_id,
    conversation?.provider,
    conversation?.account_context,
    conversation?.account_id,
    conversation?.execution_host,
  ])
}

export function ConversationContent({ conversationId, tabId }: { conversationId: string; tabId: string }) {
  const host = window.adeHost
  const daemonStore = useContext(DaemonStoreContext)
  const [profileIdentity, setProfileIdentity] = useState('')
  const accountIdentity = useDaemon((state) => accountIdentityFor(state, conversationId))
  const profileIdentityRef = useRef(profileIdentity)
  const isContextCurrent = useCallback(
    (expectedProfile: string, expectedAccount: string): boolean =>
      Boolean(
        daemonStore &&
        host &&
        window.adeHost === host &&
        profileIdentityRef.current === expectedProfile &&
        accountIdentityFor(daemonStore.getState(), conversationId) === expectedAccount,
      ),
    [conversationId, daemonStore, host],
  )
  useEffect(() => {
    if (!host) return
    let active = true
    let profileEpoch = 0
    const update = (state: ProfileState): void => {
      if (!active) return
      profileEpoch++
      const identity = (state.activeId ?? '') + ':' + (state.selectedId ?? '')
      profileIdentityRef.current = identity
      setProfileIdentity(identity)
    }
    const unsubscribe = host.profiles.onState(update)
    const initialReadEpoch = profileEpoch
    void Promise.resolve()
      .then(() => host.profiles.getState())
      .then((state) => {
        if (profileEpoch === initialReadEpoch) update(state)
      })
      .catch(() => undefined)

    return () => {
      active = false
      unsubscribe()
    }
  }, [host])
  if (!host) return <PaneState title="Conversation unavailable" detail="The desktop connection is unavailable." />
  const contextKey = JSON.stringify([profileIdentity, accountIdentity])
  return (
    <LoadedConversation
      key={JSON.stringify([tabId, conversationId, contextKey])}
      conversationId={conversationId}
      tabId={tabId}
      host={host}
      profileIdentity={profileIdentity}
      accountIdentity={accountIdentity}
      isContextCurrent={isContextCurrent}
    />
  )
}

function LoadedConversation({
  conversationId,
  tabId,
  host,
  profileIdentity,
  accountIdentity,
  isContextCurrent,
}: {
  conversationId: string
  tabId: string
  host: NonNullable<typeof window.adeHost>
  profileIdentity: string
  accountIdentity: string
  isContextCurrent: (profileIdentity: string, accountIdentity: string) => boolean
}) {
  const catalogConversation = useDaemon((state) => state.conversations[conversationId])
  const connectionStatus = useDaemon((state) => state.status)
  const workspace = useDaemon((state) =>
    catalogConversation ? state.workspaces[catalogConversation.workspace_id] : undefined,
  )
  const project = useDaemon((state) => (workspace ? state.projects[workspace.project_id] : undefined))
  const [store] = useState(() =>
    createStore<ConversationState>(() => ({ status: 'loading', snapshot: null, error: null })),
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const retainedSnapshot = store.getState().snapshot
    const projection = createConversationStore(host, conversationId)
    const initial = projection.store.getState()
    store.setState(retainedSnapshot ? { ...initial, snapshot: retainedSnapshot } : initial, true)
    const unsubscribe = projection.store.subscribe((next) => {
      store.setState(
        retainedSnapshot && next.snapshot === null && next.status !== 'deleted'
          ? { ...next, snapshot: retainedSnapshot }
          : next,
        true,
      )
    })
    return () => {
      unsubscribe()
      projection.stop()
    }
  }, [host, conversationId, store, attempt])
  const state = useStore(store, (value) => value)
  const conversation = state.snapshot?.conversation ?? catalogConversation
  const contextCurrent = isContextCurrent(profileIdentity, accountIdentity)
  const isCurrent = useCallback(
    () => isContextCurrent(profileIdentity, accountIdentity),
    [accountIdentity, isContextCurrent, profileIdentity],
  )
  const {
    hasStopTarget,
    stop,
    cancelPending,
    cancelError,
    requestStop,
    terminating,
    terminateOutcome,
    terminateError,
    requestTerminate,
  } = useStopControls(conversationId, store, state, isCurrent)
  const historyEpoch = state.snapshot?.history_epoch
  const [nativeHistoryState, setNativeHistoryState] = useState<NativeHistoryState | null>(null)
  const nativeHistoryController = useRef<{ historyEpoch: number; loadMore: () => Promise<void> } | null>(null)
  const historyAnchorCapture = useRef<(() => void) | null>(null)
  const currentAnchorCapture = useRef<(() => void) | null>(null)
  const provider = conversation?.provider
  useEffect(() => {
    if (historyEpoch === undefined || provider === undefined) return
    const projection = startNativeHistoryProjection({
      conversationId,
      historyEpoch,
      provider,
      isContextCurrent: () => isContextCurrent(profileIdentity, accountIdentity),
      fetchPage: (request) => host.conversations.request('conversation.history', request),
      onState: (next) =>
        setNativeHistoryState((previous) =>
          next.status === 'loading' && !next.loaded && previous?.historyEpoch === next.historyEpoch && previous.loaded
            ? {
                ...next,
                snapshot: previous.snapshot,
                nativeCursor: previous.nativeCursor,
                messages: previous.messages,
                loaded: true,
                stale: true,
                retainedBytes: previous.retainedBytes,
                failure: previous.failure,
                error: previous.error,
              }
            : next,
        ),
    })
    const controller = { historyEpoch, loadMore: projection.loadMore }
    nativeHistoryController.current = controller
    void projection.loadMore()
    return () => {
      projection.stop()
      if (nativeHistoryController.current === controller) nativeHistoryController.current = null
    }
  }, [host, conversationId, historyEpoch, provider, isContextCurrent, profileIdentity, accountIdentity, attempt])
  const nativeHistory = nativeHistoryState?.historyEpoch === historyEpoch ? nativeHistoryState : null
  const liveMessages = state.snapshot?.messages ?? EMPTY_MESSAGES
  const nativeMessages = nativeHistory?.loaded ? nativeHistory.messages : null
  const nativeTimeline = useMemo(() => {
    if (nativeMessages === null) return null
    const liveById = new Map(liveMessages.map((message) => [message.id, message]))
    const nativeIds = new Set<string>()
    const messages = nativeMessages.map((message) => {
      nativeIds.add(message.id)
      return liveById.get(message.id) ?? message
    })
    return { messages, nativeIds }
  }, [liveMessages, nativeMessages])
  const currentMessages = useMemo(
    () => liveMessages.filter((message) => !nativeTimeline?.nativeIds.has(message.id)),
    [liveMessages, nativeTimeline],
  )
  const loadMoreNativeHistory = (): void => {
    const controller = nativeHistoryController.current
    if (controller && controller.historyEpoch === historyEpoch) {
      historyAnchorCapture.current?.()
      void controller.loadMore()
    }
  }
  const retry = (): void => {
    const snapshot = store.getState().snapshot
    store.setState(
      {
        status: snapshot ? 'stale' : 'loading',
        snapshot,
        error: snapshot ? 'Refreshing retained history…' : null,
      },
      true,
    )
    setAttempt((value) => value + 1)
  }

  if (state.status === 'deleted')
    return (
      <PaneState title="Conversation unavailable" detail={state.error ?? 'This conversation is no longer available.'} />
    )
  if (state.error && !state.snapshot)
    return <PaneState title="Couldn’t load conversation" detail={state.error} onRetry={retry} />
  if (state.status === 'loading' && !state.snapshot)
    return <PaneState title="Loading conversation" detail="Reading retained history…" />
  if (state.status === 'stale' && !state.snapshot)
    return <PaneState title="Conversation unavailable" detail="History is being refreshed." />
  if (!conversation)
    return (
      <PaneState title="Conversation unavailable" detail="This conversation is not present in the workspace catalog." />
    )

  const target: TabTarget = { kind: 'conversation', id: conversationId }
  return (
    <div className="flex h-full min-h-0 flex-col bg-base" data-conversation-id={conversationId} data-tab-id={tabId}>
      <div className="mx-auto flex w-full max-w-[640px] shrink-0 flex-col gap-1.5 px-4 pb-1 pt-6">
        <div className="flex items-start justify-between gap-3">
          <Title>{conversation.title || 'Conversation'}</Title>
          <div className="flex items-center gap-2">
            {hasStopTarget && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void requestStop()}
                disabled={
                  state.status !== 'current' ||
                  !contextCurrent ||
                  cancelPending ||
                  (conversation.status === 'cancelling' && stop?.outcome === 'requested')
                }
              >
                {cancelPending || conversation.status === 'cancelling' ? 'Stopping…' : 'Stop current turn'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void openTabInAnother(target)}>
              Open in another tab
            </Button>
          </div>
        </div>
        {cancelError && <div role="alert">Cancellation request failed: {cancelError}</div>}
        {stop && (
          <StopStatus
            stop={stop}
            terminating={terminating}
            terminateOutcome={terminateOutcome}
            terminateError={terminateError}
            onTerminate={contextCurrent && state.status === 'current' ? () => void requestTerminate() : null}
            queuedPrompts={state.snapshot?.queued?.length ?? 0}
            queuePaused={state.snapshot?.conversation.queue_paused ?? false}
          />
        )}
        <ProviderSettingsPanel
          conversationId={conversationId}
          conversations={host.conversations}
          version={state.snapshot?.conversation.updated_at ?? 0}
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1" role="group" aria-label="Conversation context">
          <Text>{workspace?.name ?? 'Workspace unavailable'}</Text>
          <Meta>·</Meta>
          <Text>
            {conversation.execution_host.kind === 'local' ? 'Local host' : conversation.execution_host.host_id}
          </Text>
          <Meta>·</Meta>
          <Text>{conversation.provider}</Text>
          <Meta>·</Meta>
          <Text>
            {conversation.account_context === 'managed'
              ? (conversation.account_id ?? 'Managed account')
              : 'Ambient account'}
          </Text>
          {project && <Meta>Project: {project.name}</Meta>}
          <ExecutionBinding state={state} />
        </div>
        {state.error && (
          <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
            <Meta>Conversation history may be out of date: {state.error}</Meta>
            <Button variant="outline" size="sm" disabled={state.status === 'loading'} onClick={retry}>
              {state.status === 'loading' ? 'Refreshing conversation history…' : 'Refresh conversation history'}
            </Button>
          </div>
        )}
        {nativeHistory && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Native history controls">
            {nativeHistory.snapshot?.consistency === 'best_effort' && (
              <Meta role="status">Native history is best effort; the provider may change while pages load.</Meta>
            )}
            {nativeHistory.error && (
              <div role="alert" aria-live="assertive">
                <Meta>Native history may be incomplete or out of date: {nativeHistory.error}</Meta>
                {nativeHistory.failure && (
                  <Meta>Native history failure: {nativeHistory.failure.code.replaceAll('_', ' ')}</Meta>
                )}
              </div>
            )}
            {nativeHistory.restartRequired && (
              <Button variant="outline" size="sm" onClick={retry}>
                Refresh conversation history
              </Button>
            )}
            {nativeHistory.limitReached && (
              <>
                <Meta role="status">Native history is incomplete because the client history limit was reached.</Meta>
                <Button variant="outline" size="sm" onClick={retry}>
                  Refresh conversation history
                </Button>
              </>
            )}
            {!nativeHistory.finished && !nativeHistory.limitReached && !nativeHistory.restartRequired && (
              <Button
                variant="outline"
                size="sm"
                disabled={nativeHistory.status === 'loading'}
                onClick={loadMoreNativeHistory}
              >
                {nativeHistory.status === 'loading'
                  ? 'Loading more native history…'
                  : nativeHistory.loaded
                    ? nativeHistory.status === 'stale' || nativeHistory.status === 'error'
                      ? 'Retry native history'
                      : 'Load more native history'
                    : nativeHistory.status === 'error'
                      ? 'Retry native history'
                      : 'Load native history'}
              </Button>
            )}
          </div>
        )}
      </div>
      <RewindScope conversationId={conversationId} conversations={host.conversations}>
        <ConversationHistorySections
          store={store}
          provider={conversation.provider}
          nativeMessages={nativeTimeline?.messages ?? null}
          currentMessages={currentMessages}
          historyAnchorCapture={historyAnchorCapture}
          currentAnchorCapture={currentAnchorCapture}
        />
      </RewindScope>
      <div className="mx-auto w-full max-w-[640px] shrink-0 px-4 pb-4">
        <NativeRequests
          conversationId={conversationId}
          requests={state.snapshot?.requests ?? []}
          projectionStatus={state.status}
          connectionStatus={connectionStatus}
          conversations={host.conversations}
          profileIdentity={profileIdentity}
          accountIdentity={accountIdentity}
          isContextCurrent={isContextCurrent}
        />
        <QueuedPrompts
          conversationId={conversationId}
          queued={(state.snapshot?.queued ?? []) as QueuedPrompt[]}
          paused={state.snapshot?.conversation.queue_paused ?? false}
          conversations={host.conversations}
        />
        <ConversationComposer
          conversationId={conversationId}
          viewId={tabId}
          conversations={host.conversations}
          store={store}
          profileIdentity={profileIdentity}
          accountIdentity={accountIdentity}
          isContextCurrent={isContextCurrent}
        />
      </div>
    </div>
  )
}
