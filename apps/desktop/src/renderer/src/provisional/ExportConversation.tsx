import { useState } from 'react'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

/**
 * Writes the conversation's retained history to a new JSON file. It reads without the provider,
 * says whether anything can continue it natively, and marks attachments whose payloads are gone.
 */
export function ExportConversation({
  conversationId,
  conversations,
}: {
  conversationId: string
  conversations: ConversationsBridge
}) {
  const [message, setMessage] = useState<string | null>(null)
  const exportFile = async () => {
    setMessage(null)
    try {
      const done = await conversations.request('conversation.export.file', { conversation_id: conversationId })
      if (done) setMessage(`Exported ${done.message_count} messages to ${done.file}.`)
    } catch (error) {
      setMessage("Couldn't export. Nothing was written. " + messageOf(error))
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" className="self-start" onClick={() => void exportFile()}>
        Export conversation
      </Button>
      {message && <Body role="status">{message}</Body>}
    </div>
  )
}
