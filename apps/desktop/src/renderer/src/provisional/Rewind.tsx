import { createContext, use, useCallback, useState, type ReactNode } from 'react'
import type { ConversationRewindPreview } from '@ade/contracts'
import { Body, Meta } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

const RewindContext = createContext<((messageId: string) => void) | null>(null)

type Step =
  | { kind: 'idle' }
  | { kind: 'loading'; messageId: string }
  | { kind: 'preview'; messageId: string; preview: ConversationRewindPreview; operationId: string }
  | { kind: 'working'; messageId: string; preview: ConversationRewindPreview; operationId: string }
  | { kind: 'done'; text: string }
  | { kind: 'failed'; text: string }

/** "Rewind to here" on a user message, inside a {@link RewindScope}. */
export function RewindAction({ messageId }: { messageId: string }) {
  const start = use(RewindContext)
  if (!start) return null
  return (
    <Button variant="ghost" size="sm" className="self-start" onClick={() => start(messageId)}>
      Rewind to before this prompt
    </Button>
  )
}

/**
 * A conversation rewind: the daemon previews what goes and what the provider does, the person
 * confirms, and the result names the native session the conversation continues in. Files are
 * never restored here; they rewind through ADE checkpoints. A retry after an unconfirmed reply
 * reuses the operation ID, so the provider never rewinds twice.
 */
export function RewindScope({
  conversationId,
  conversations,
  children,
}: {
  conversationId: string
  conversations: ConversationsBridge
  children: ReactNode
}) {
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [stepError, setStepError] = useState<string | null>(null)
  const begin = useCallback(
    (messageId: string) => {
      setStep({ kind: 'loading', messageId })
      setStepError(null)
      conversations
        .request('conversation.rewind.preview', {
          conversation_id: conversationId,
          scope: 'conversation',
          before_message_id: messageId,
        })
        .then((preview) => setStep({ kind: 'preview', messageId, preview, operationId: crypto.randomUUID() }))
        .catch((error: unknown) =>
          setStep({ kind: 'failed', text: "Couldn't preview the rewind. " + messageOf(error) }),
        )
    },
    [conversationId, conversations],
  )
  const confirm = async () => {
    if (step.kind !== 'preview') return
    setStep({ ...step, kind: 'working' })
    try {
      const done = await conversations.request('conversation.rewind', {
        operation_id: step.operationId,
        conversation_id: conversationId,
        scope: 'conversation',
        before_message_id: step.messageId,
        expected_state: step.preview.history!.state_token,
      })
      const history = done.history
      setStep(
        done.outcome === 'acknowledged'
          ? {
              kind: 'done',
              text:
                `Rewound: removed ${history?.removed_messages ?? 0} messages from ${history?.removed_turns ?? 0} turns.` +
                (history?.native_session
                  ? ` The conversation continues in native session ${history.native_session}; session ${history.previous_native_session ?? 'unknown'} is kept unchanged.`
                  : ''),
            }
          : {
              kind: 'failed',
              text: `Rewind ${done.outcome.replaceAll('_', ' ')}: ${done.reason ?? 'no reason given'}`,
            },
      )
    } catch (error) {
      // The outcome is unknown; Retry sends the same operation ID and reads the recorded result.
      setStep({ ...step, kind: 'preview' })
      setStepError(
        "The rewind's outcome was not confirmed. Retry reads it without rewinding again. " + messageOf(error),
      )
    }
  }
  const close = () => {
    setStep({ kind: 'idle' })
    setStepError(null)
  }
  const preview = step.kind === 'preview' || step.kind === 'working' ? step.preview : null
  return (
    <RewindContext value={begin}>
      {children}
      {step.kind !== 'idle' && (
        <section
          aria-label="Rewind conversation"
          className="mx-auto flex w-full max-w-[640px] flex-col gap-2 rounded-lg bg-panel px-4 py-3"
        >
          {step.kind === 'loading' && <Meta>Previewing the rewind…</Meta>}
          {preview && !preview.availability.available && (
            <Body>Rewind is unavailable: {preview.availability.reason ?? 'the provider does not offer it'}</Body>
          )}
          {preview?.history && (
            <>
              <Body>
                Removes {preview.history.removed_messages} messages from {preview.history.removed_turns} turns and keeps{' '}
                {preview.history.kept_messages}.
              </Body>
              <Meta>
                The provider performs it with {preview.availability.mechanism ?? 'its native rewind'}. Files are not
                restored; restore them from a checkpoint.
              </Meta>
            </>
          )}
          {stepError && <Body role="alert">{stepError}</Body>}
          {(step.kind === 'done' || step.kind === 'failed') && <Body role="status">{step.text}</Body>}
          <div className="flex gap-2">
            {preview?.history && preview.availability.available && (
              <Button size="sm" disabled={step.kind === 'working'} onClick={() => void confirm()}>
                {step.kind === 'working' ? 'Rewinding…' : stepError ? 'Retry rewind' : 'Rewind'}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={step.kind === 'working'} onClick={close}>
              {step.kind === 'done' || step.kind === 'failed' ? 'Close' : 'Cancel'}
            </Button>
          </div>
        </section>
      )}
    </RewindContext>
  )
}
