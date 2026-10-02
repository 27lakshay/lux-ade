import { useEffect, useState } from 'react'
import type { ControlAvailability } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

/**
 * Native compaction, offered only while the provider supports it now. The daemon's reply only
 * says the provider started; the result is the compaction record the provider reports into the
 * conversation. A retry after an unconfirmed reply reuses the operation ID, so it never compacts twice.
 */
export function CompactControl({
  conversationId,
  conversations,
  version,
}: {
  conversationId: string
  conversations: ConversationsBridge
  version: number
}) {
  const [control, setControl] = useState<ControlAvailability | null>(null)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    let active = true
    conversations.request('conversation.controls', { conversation_id: conversationId }).then(
      (reply) => active && setControl(reply.controls?.find((entry) => entry.control === 'compact') ?? null),
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [conversationId, conversations, version])
  if (!control) return null
  const compact = async () => {
    setWorking(true)
    setMessage(null)
    try {
      const reply = await conversations.request('conversation.compact', {
        operation_id: operationId,
        conversation_id: conversationId,
      })
      setOperationId(crypto.randomUUID())
      setMessage(
        reply.outcome === 'acknowledged'
          ? 'The provider started compacting. Its result appears in the conversation when it reports it.'
          : `Compaction ${reply.outcome.replaceAll('_', ' ')}: ${reply.reason ?? 'no reason given'}`,
      )
    } catch (error) {
      setMessage(
        "The compaction's outcome was not confirmed. Retry reads it without compacting again. " + messageOf(error),
      )
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" aria-label="Compaction">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={!control.available || working}
        onClick={() => void compact()}
      >
        {working ? 'Compacting…' : 'Compact context'}
      </Button>
      {!control.available && (
        <Caption tone="muted">Compaction is unavailable: {control.reason ?? 'not offered'}</Caption>
      )}
      {message && <Body role="status">{message}</Body>}
    </div>
  )
}
