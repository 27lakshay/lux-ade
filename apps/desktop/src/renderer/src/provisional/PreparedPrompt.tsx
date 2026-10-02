import { useEffect, useState } from 'react'
import type { Attachment, ContextPlan } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import type { PreparedSend } from './usePreparedSend'
import { messageOf } from './ConversationComposerSupport'

/**
 * The prompt a send delivers when plugin composer contributions prepared it differently from the
 * draft: the exact text the provider receives, why any contribution fell back, and the daemon's
 * plan for that text. Sending delivers this text; the draft itself stays as written.
 */
export function PreparedPrompt({ send, attachments }: { send: PreparedSend; attachments: Attachment[] }) {
  const { prepared, savedText: draftText, conversations, conversationId } = send
  const differs = prepared.text !== draftText
  const [planned, setPlanned] = useState<{ text: string; plan: ContextPlan } | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => {
    if (!differs) return
    let active = true
    conversations
      .request('context.plan', { conversation_id: conversationId, text: prepared.text, attachments })
      .then((plan) => {
        if (active) setPlanned({ text: prepared.text, plan })
      })
      .catch((error: unknown) => {
        if (active) setPlanError("Couldn't check the prepared prompt. " + messageOf(error))
      })
    return () => {
      active = false
    }
  }, [attachments, conversationId, conversations, differs, prepared.text])
  if (!differs && prepared.notes.length === 0 && !prepared.blocked) return null
  const refusals = planned?.text === prepared.text ? planned.plan.rejections.filter((item) => !item.attachment_id) : []
  return (
    <section aria-label="Prepared prompt" className="flex min-w-0 flex-col gap-1">
      {differs && (
        <>
          <Caption>The provider receives this prompt:</Caption>
          <Body
            as="div"
            role="note"
            aria-label="Prepared prompt text"
            className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {prepared.text}
          </Body>
        </>
      )}
      {prepared.notes.map((note) => (
        <Caption key={note} tone="muted">
          {note}
        </Caption>
      ))}
      {refusals.map((rejection) => (
        <Caption key={rejection.code} tone="muted">
          Will be refused: {rejection.message}
        </Caption>
      ))}
      {planError && <Caption tone="muted">{planError}</Caption>}
      {prepared.blocked && <Body role="alert">{prepared.blocked}</Body>}
    </section>
  )
}
