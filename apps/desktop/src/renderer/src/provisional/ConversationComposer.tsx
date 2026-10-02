import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useEditorState } from '@tiptap/react'
import type { ConversationsBridge, DraftState, PendingSendState } from '../../../shared/bridge/conversations'
import type { ConversationState, ConversationStore } from '../state/conversation-store'
import type { DraftStash } from '@ade/contracts'
import { ConversationComposerForm } from './ConversationComposerForm'
import { deliveryOf, documentFor, hasDeliveryEvidence, messageOf, recoveryAdvice } from './ConversationComposerSupport'
import { useFollowUpInput } from './useFollowUpInput'
import { useDraftAttachments } from './useDraftAttachments'
import { usePromptEditor } from './promptEditor'
import { draftRecovery } from './draftRecovery'
import { usePreparedSend } from './usePreparedSend'
import { latestSave } from './latestSave'
import type { LatestSave } from './latestSave'
type Attempt = { requestId: string; text: string }
type Delivery = 'sending' | 'pending' | 'unknown' | 'rejected'

export function ConversationComposer({
  conversationId,
  viewId,
  conversations,
  store,
  profileIdentity,
  accountIdentity,
  isContextCurrent,
}: {
  conversationId: string
  viewId: string
  conversations: ConversationsBridge
  store: ConversationStore
  profileIdentity: string
  accountIdentity: string
  isContextCurrent: (profileIdentity: string, accountIdentity: string) => boolean
}) {
  const sessionRef = useRef({ active: false })
  const writerRef = useRef({ tail: Promise.resolve() as Promise<void> })
  const promptId = useId()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [draftStashes, setDraftStashes] = useState<DraftStash[] | null>(null)
  const attemptRef = useRef<Attempt | null>(null)
  const busyRef = useRef(false)
  const focusAfterUnlock = useRef(false)
  const submitRef = useRef<() => Promise<void>>(async () => undefined)
  const textRef = useRef('')
  const draftWriterRef = useRef<LatestSave | null>(null)
  const draft = usePreparedSend({ conversations, conversationId })
  const { contextNodes, settle, restore } = draft
  const isActiveContext = useCallback(
    () => sessionRef.current.active && isContextCurrent(profileIdentity, accountIdentity),
    [accountIdentity, isContextCurrent, profileIdentity],
  )
  const saveDraft = useCallback(
    (text: string): Promise<void> => {
      const next = writerRef.current.tail
        .catch(() => undefined)
        .then(() => {
          if (!isContextCurrent(profileIdentity, accountIdentity)) return
          return conversations
            .request('draft.save', { conversation_id: conversationId, text, view_id: viewId })
            .then(() => settle(text))
        })
      writerRef.current.tail = next
      return next
    },
    [accountIdentity, conversationId, conversations, isContextCurrent, profileIdentity, settle, viewId],
  )
  const saveDraftRef = useRef(saveDraft)
  useLayoutEffect(() => {
    saveDraftRef.current = saveDraft
  }, [saveDraft])
  useLayoutEffect(() => {
    const session = sessionRef.current
    const writer = writerRef.current
    session.active = true
    // Each edit reaches main at once, so a renderer crash right after typing loses nothing.
    const draftWriter = latestSave((text: string) =>
      saveDraftRef.current(text).catch((error: unknown) => {
        if (session.active) setDetail('Draft saving failed; the prompt remains in the editor. ' + messageOf(error))
      }),
    )
    draftWriterRef.current = draftWriter
    return () => {
      session.active = false
      draftWriter.flush()
      draftWriter.cancel()
      void writer.tail.catch((error: unknown) => {
        console.error('Conversation draft persistence failed after its view closed.', error)
      })
    }
  }, [conversationId, conversations, viewId])
  const scheduleSave = useCallback((text: string): void => {
    textRef.current = text
    if (sessionRef.current.active) setDetail(null)
    draftWriterRef.current?.(text)
  }, [])
  const scheduleSaveRef = useRef(scheduleSave)
  useLayoutEffect(() => {
    scheduleSaveRef.current = scheduleSave
  }, [scheduleSave])

  const editor = usePromptEditor(promptId, submitRef, scheduleSaveRef)
  const canSubmit = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => Boolean(currentEditor?.getText({ blockSeparator: '\n' }).trim()),
  })
  const followUp = useFollowUpInput({
    conversations,
    conversationId,
    store,
    isActiveContext,
    // Queue and Steer deliver the same prepared prompt Send would, never the raw editor text.
    takeText: () => draft.resolve(editor?.getText({ blockSeparator: '\n' }) ?? ''),
    clear: async () => {
      draftWriterRef.current?.cancel()
      textRef.current = ''
      editor?.commands.setContent(documentFor(''), { emitUpdate: false })
      await saveDraft('')
    },
  })
  // The request ID of a prompt restored from the daemon when this view opened.
  const restoredRef = useRef<string | null>(null)
  const draftAttachments = useDraftAttachments({ conversations, conversationId, viewId, isActiveContext })
  const { load: loadAttachments, clear: clearAttachments } = draftAttachments
  const updateAttempt = useCallback((next: Attempt | null): void => {
    if (!sessionRef.current.active) return
    attemptRef.current = next
    setAttempt(next)
  }, [])

  const applyStoreDelivery = useCallback(
    (state: ConversationState): void => {
      const current = attemptRef.current
      if (!current || !isActiveContext()) return
      const evidence = deliveryOf(state, current.requestId)
      if (!evidence) return

      if (evidence.native_outcome === 'accepted') {
        // A prompt restored after a restart is still an open intent in the daemon. Native
        // acceptance settles it: reconcile under the same request ID, which the daemon
        // answers from its receipt without starting another turn.
        if (restoredRef.current === current.requestId) {
          restoredRef.current = null
          void conversations
            .request('agent.retry_send', {
              conversation_id: conversationId,
              view_id: viewId,
              request_id: current.requestId,
            })
            .catch((error: unknown) => {
              if (isActiveContext()) setDetail("Couldn't settle the restored prompt. " + messageOf(error))
            })
        }
        updateAttempt(null)
        setDelivery(null)
        setDetail(null)
        textRef.current = ''
        restore('', [])
        clearAttachments()
        editor?.commands.clearContent(false)
      } else if (evidence.native_outcome === 'rejected') {
        setDelivery('rejected')
        const reason = evidence.error?.replaceAll('_', ' ')
        const advice = evidence.recovery ? recoveryAdvice[evidence.recovery] : 'Edit or retry this prompt when ready.'
        setDetail('The native agent rejected this prompt' + (reason ? ': ' + reason : '') + '. ' + advice)
      } else if (evidence.native_outcome === 'unknown') {
        setDelivery('unknown')
        const advice = evidence.recovery ? recoveryAdvice[evidence.recovery] : 'Reconcile with the same request ID.'
        setDetail('Delivery is unknown. ' + advice)
      } else {
        setDelivery('pending')
        setDetail(null)
      }
    },
    [clearAttachments, conversationId, conversations, editor, isActiveContext, restore, updateAttempt, viewId],
  )

  const submissionDelivery = useStore(store, (state) => (attempt ? deliveryOf(state, attempt.requestId) : null))

  useEffect(() => store.subscribe((state) => applyStoreDelivery(state)), [applyStoreDelivery, store])

  useEffect(() => {
    let active = true
    const unsubscribe = conversations.onDraftError((error) => {
      if (
        active &&
        isActiveContext() &&
        error.conversationId === conversationId &&
        error.viewId === viewId &&
        error.message
      )
        setDetail(error.message)
    })
    void conversations
      .request('draft.get', { conversation_id: conversationId, view_id: viewId })
      .then((state: DraftState) => {
        if (!active || !isActiveContext()) return
        const pending = state.send_pending
        const text = pending?.text ?? state.draft.text
        textRef.current = text
        restore(state.draft.text, state.draft.context_nodes ?? [])
        loadAttachments(state)
        if (pending) {
          restoredRef.current = pending.request_id
          updateAttempt({ requestId: pending.request_id, text: pending.text })
          setDelivery(pending.state === 'rejected' ? 'rejected' : 'unknown')
        }
        if (state.error) setDetail(state.error)
        editor?.commands.setContent(documentFor(text), { emitUpdate: false })
        setReady(true)
        applyStoreDelivery(store.getState())
      })
      .catch((error: unknown) => {
        if (!active || !isActiveContext()) return
        setDetail("Couldn't restore the saved prompt. " + messageOf(error))
        setReady(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [
    applyStoreDelivery,
    conversationId,
    conversations,
    editor,
    isActiveContext,
    loadAttachments,
    restore,
    store,
    updateAttempt,
    viewId,
  ])

  useEffect(() => {
    const editable = ready && !busy && !recoveryBusy && attempt === null
    editor?.setEditable(editable, false)
    if (editable && focusAfterUnlock.current) {
      focusAfterUnlock.current = false
      editor?.commands.focus('end')
    }
  }, [attempt, busy, editor, ready, recoveryBusy])

  const setFromResult = (result: {
    type: string
    request_id?: string
    text?: string
    state?: string
    message?: string
  }): void => {
    if (result.type === 'send_pending') {
      const rejected = result.state === 'rejected'
      setDelivery(rejected ? 'rejected' : 'unknown')
      setDetail(result.message ?? (rejected ? 'The prompt was rejected before admission. Edit or retry it.' : null))
    } else {
      // A daemon ack is not evidence that the native agent accepted or completed this prompt.
      setDelivery('pending')
      setDetail(null)
    }
  }

  const checkExistingAttempt = async (current: Attempt, failure?: string): Promise<void> => {
    try {
      const state = await conversations.request('draft.get', { conversation_id: conversationId, view_id: viewId })
      if (!isActiveContext() || attemptRef.current?.requestId !== current.requestId) return
      const pending: PendingSendState | null = state.send_pending
      if (pending?.request_id === current.requestId && pending.text === current.text) {
        const rejected = pending.state === 'rejected'
        setDelivery(rejected ? 'rejected' : 'unknown')
        if (rejected) setDetail('The prompt was rejected before admission. Edit or retry it.')
      } else if (failure !== undefined && !pending && !hasDeliveryEvidence(store, current.requestId)) {
        // The send failed and main holds no intent for it: the daemon refused it before
        // admission and the pipeline released it. Nothing was sent; the draft is unchanged.
        setDelivery('rejected')
        setDetail('This prompt was not sent. ' + failure)
      } else {
        setDelivery('unknown')
      }
    } catch {
      if (!isActiveContext()) return
      // A failed status read is not evidence that delivery succeeded or that a new send is safe.
    }
  }

  const submit = async (): Promise<void> => {
    if (!isActiveContext() || !editor || !ready || busyRef.current || attemptRef.current) return
    const text = editor.getText({ blockSeparator: '\n' })
    if (!text.trim()) return
    if (followUp.sendBlocked) {
      // Enter only sends; it never picks Queue or Steer on the person's behalf.
      setDetail('A turn is running or prompts are queued. Choose Queue prompt or Steer turn.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setDetail(null)
    let sending = false
    try {
      draftWriterRef.current?.flush()
      draftWriterRef.current?.cancel()
      await writerRef.current.tail
      if (!isActiveContext()) return
      // Plugin composer contributions prepare what the provider receives; the draft stays as written.
      const prepared = draft.resolve(text)
      if ('refused' in prepared) return setDetail(prepared.refused)
      const current = { requestId: crypto.randomUUID(), text: prepared.text }
      textRef.current = text
      updateAttempt(current)
      setDelivery('sending')
      sending = true
      const result = await conversations.request('agent.send', {
        conversation_id: conversationId,
        view_id: viewId,
        request_id: current.requestId,
        text: current.text,
      })
      if (isActiveContext() && !hasDeliveryEvidence(store, current.requestId)) setFromResult(result)
    } catch (error) {
      if (!isActiveContext()) return
      const current = attemptRef.current
      if (current) {
        setDelivery('unknown')
        setDetail('Delivery cannot be confirmed. This prompt and its request ID remain here. ' + messageOf(error))
        void checkExistingAttempt(current, messageOf(error))
      } else if (!sending) {
        setDetail("Couldn't save the prompt before sending. " + messageOf(error))
      }
    } finally {
      busyRef.current = false
      if (isActiveContext()) setBusy(false)
    }
  }
  useLayoutEffect(() => {
    // TipTap reads the latest committed submit callback.
    submitRef.current = submit
  })

  const retry = async (): Promise<void> => {
    if (!isActiveContext() || !attempt || delivery !== 'unknown' || busyRef.current) return
    const current = attempt
    busyRef.current = true
    setBusy(true)
    setDetail(null)
    try {
      const result = await conversations.request('agent.retry_send', {
        conversation_id: conversationId,
        view_id: viewId,
        request_id: current.requestId,
      })
      if (
        isActiveContext() &&
        attemptRef.current?.requestId === current.requestId &&
        !hasDeliveryEvidence(store, current.requestId)
      )
        setFromResult(result)
    } catch (error) {
      if (isActiveContext() && attemptRef.current?.requestId === current.requestId) {
        setDetail("Couldn't reconcile this prompt. Its request ID and text remain here. " + messageOf(error))
        setDelivery('unknown')
      }
    } finally {
      busyRef.current = false
      if (isActiveContext()) setBusy(false)
    }
  }

  // Built when a recovery action runs, so render never reads the composer's refs.
  const recovery = () =>
    draftRecovery({
      conversations,
      conversationId,
      viewId,
      editor,
      isActiveContext,
      isMounted: () => sessionRef.current.active,
      busyRef,
      attemptRef,
      textRef,
      flushPendingSave: async () => {
        draftWriterRef.current?.flush()
        draftWriterRef.current?.cancel()
        await writerRef.current.tail
      },
      setRecoveryBusy,
      setDraftStashes,
      setContextNodes: (nodes) => restore(textRef.current, nodes),
      setDetail,
    })
  const openDraftRecovery = (): Promise<void> => recovery().openDraftRecovery()
  const restoreDraftRecovery = (stash: DraftStash): Promise<void> => recovery().restoreDraftRecovery(stash)
  const unlockRejected = (): void => {
    if (!sessionRef.current.active || delivery !== 'rejected') return
    focusAfterUnlock.current = true
    updateAttempt(null)
    setDelivery(null)
    setDetail(null)
  }

  return (
    <ConversationComposerForm
      promptId={promptId}
      editor={editor}
      ready={ready}
      busy={busy}
      attemptRequestId={attempt?.requestId ?? null}
      delivery={delivery}
      admitted={submissionDelivery?.admitted ?? false}
      detail={detail}
      canSubmit={canSubmit}
      onSubmit={submit}
      onRetry={retry}
      onUnlockRejected={unlockRejected}
      recoveryBusy={recoveryBusy}
      draftStashes={draftStashes}
      onOpenDraftRecovery={openDraftRecovery}
      onRestoreDraftRecovery={restoreDraftRecovery}
      followUp={followUp}
      contextNodes={contextNodes}
      prepared={draft}
      draftAttachments={draftAttachments}
    />
  )
}
