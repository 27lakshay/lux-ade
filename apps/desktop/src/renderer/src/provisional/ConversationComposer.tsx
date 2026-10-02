import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { debounce } from 'es-toolkit/function'
import { useStore } from 'zustand'
import { useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { ConversationsBridge, DraftState, PendingSendState } from '../../../shared/bridge/conversations'
import type { ConversationState, ConversationStore } from '../state/conversation-store'
import type { DraftStash } from '@ade/contracts'
import { ConversationComposerForm } from './ConversationComposerForm'
import { documentFor, hasDeliveryEvidence, messageOf, recoveryAdvice } from './ConversationComposerSupport'
type Attempt = { requestId: string; text: string }
type Delivery = 'sending' | 'pending' | 'unknown' | 'rejected'
type DebouncedSave = { (text: string): void; cancel: () => void; flush: () => void }

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
  const debouncedSaveRef = useRef<DebouncedSave | null>(null)
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
            .then(() => undefined)
        })
      writerRef.current.tail = next
      return next
    },
    [accountIdentity, conversationId, conversations, isContextCurrent, profileIdentity, viewId],
  )
  const saveDraftRef = useRef(saveDraft)
  useLayoutEffect(() => {
    saveDraftRef.current = saveDraft
  }, [saveDraft])
  useLayoutEffect(() => {
    const session = sessionRef.current
    const writer = writerRef.current
    session.active = true
    const debouncedSave = debounce((text: string) => {
      void saveDraftRef.current(text).catch((error: unknown) => {
        if (session.active) setDetail('Draft saving failed; the prompt remains in the editor. ' + messageOf(error))
      })
    }, 250)
    debouncedSaveRef.current = debouncedSave
    return () => {
      session.active = false
      debouncedSave.flush()
      debouncedSave.cancel()
      void writer.tail.catch((error: unknown) => {
        console.error('Conversation draft persistence failed after its view closed.', error)
      })
    }
  }, [conversationId, conversations, viewId])
  const scheduleSave = useCallback((text: string): void => {
    textRef.current = text
    if (sessionRef.current.active) setDetail(null)
    debouncedSaveRef.current?.(text)
  }, [])
  const scheduleSaveRef = useRef(scheduleSave)
  useLayoutEffect(() => {
    scheduleSaveRef.current = scheduleSave
  }, [scheduleSave])

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    editable: false,
    editorProps: {
      attributes: {
        id: promptId,
        role: 'textbox',
        'aria-label': 'Prompt',
        'aria-multiline': 'true',
        class:
          'min-h-12 max-h-48 overflow-y-auto rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
        event.preventDefault()
        void submitRef.current()
        return true
      },
    },
    onUpdate: ({ editor: updated }) => scheduleSaveRef.current(updated.getText({ blockSeparator: '\n' })),
  })
  const canSubmit = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => Boolean(currentEditor?.getText({ blockSeparator: '\n' }).trim()),
  })
  const updateAttempt = useCallback((next: Attempt | null): void => {
    if (!sessionRef.current.active) return
    attemptRef.current = next
    setAttempt(next)
  }, [])

  const applyStoreDelivery = useCallback(
    (state: ConversationState): void => {
      const current = attemptRef.current
      if (!current || !isActiveContext()) return
      const message = state.snapshot?.messages.find(
        (item) => item.delivery?.request_id === current.requestId && item.id === item.delivery.recoverable_message_id,
      )
      const evidence = message?.delivery
      if (!evidence) return

      if (evidence.native_outcome === 'accepted') {
        updateAttempt(null)
        setDelivery(null)
        setDetail(null)
        textRef.current = ''
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
    [editor, isActiveContext, updateAttempt],
  )

  const submissionDelivery = useStore(store, (state) =>
    attempt
      ? (state.snapshot?.messages.find(
          (message) =>
            message.delivery?.request_id === attempt.requestId &&
            message.id === message.delivery.recoverable_message_id,
        )?.delivery ?? null)
      : null,
  )

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
        if (pending) {
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
  }, [applyStoreDelivery, conversationId, conversations, editor, isActiveContext, store, updateAttempt, viewId])

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

  const checkExistingAttempt = async (current: Attempt): Promise<void> => {
    try {
      const state = await conversations.request('draft.get', { conversation_id: conversationId, view_id: viewId })
      if (!isActiveContext() || attemptRef.current?.requestId !== current.requestId) return
      const pending: PendingSendState | null = state.send_pending
      if (pending?.request_id === current.requestId && pending.text === current.text) {
        const rejected = pending.state === 'rejected'
        setDelivery(rejected ? 'rejected' : 'unknown')
        if (rejected) setDetail('The prompt was rejected before admission. Edit or retry it.')
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
    busyRef.current = true
    setBusy(true)
    setDetail(null)
    let sending = false
    try {
      debouncedSaveRef.current?.flush()
      debouncedSaveRef.current?.cancel()
      await writerRef.current.tail
      if (!isActiveContext()) return
      const current = { requestId: crypto.randomUUID(), text }
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
        void checkExistingAttempt(current)
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

  const openDraftRecovery = async (): Promise<void> => {
    if (!isActiveContext() || busyRef.current || attemptRef.current) return
    busyRef.current = true
    setRecoveryBusy(true)
    try {
      debouncedSaveRef.current?.flush()
      debouncedSaveRef.current?.cancel()
      await writerRef.current.tail
      const result = await conversations.request('draft.stash.list', {
        conversation_id: conversationId,
        view_id: viewId,
      })
      if (!isActiveContext()) return
      setDraftStashes(result.stashes)
      setDetail(
        result.stashes.length ? 'Choose a saved draft to restore.' : 'No saved draft recovery copies are available.',
      )
    } catch (error) {
      if (isActiveContext()) setDetail('Could not load saved draft recovery. ' + messageOf(error))
    } finally {
      busyRef.current = false
      if (sessionRef.current.active) setRecoveryBusy(false)
    }
  }

  const restoreDraftRecovery = async (stash: DraftStash): Promise<void> => {
    if (!isActiveContext() || busyRef.current || attemptRef.current) return
    busyRef.current = true
    setRecoveryBusy(true)
    try {
      debouncedSaveRef.current?.flush()
      debouncedSaveRef.current?.cancel()
      await writerRef.current.tail
      const state = await conversations.request('draft.stash.restore', {
        conversation_id: conversationId,
        view_id: viewId,
        name: stash.name,
        stash_revision: stash.revision,
      })
      if (!isActiveContext()) return
      if (state.error) {
        setDetail(state.error)
        return
      }
      textRef.current = state.draft.text
      editor?.commands.setContent(documentFor(state.draft.text), { emitUpdate: false })
      setDraftStashes(null)
      setDetail('Saved draft restored. The displaced draft remains available in recovery.')
    } catch (error) {
      if (isActiveContext()) setDetail('Could not restore the saved draft. ' + messageOf(error))
    } finally {
      busyRef.current = false
      if (sessionRef.current.active) setRecoveryBusy(false)
    }
  }
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
    />
  )
}
