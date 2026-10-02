import { useState } from 'react'
import { Body, Caption, Title } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

type Queued = { id: string; text: string; status: string }

/**
 * ADE's durable prompt queue. Entries here have not reached the provider:
 * removing one only drops it from ADE's queue. Once dispatched, a prompt
 * leaves this list and its message shows provider delivery instead.
 */
export function QueuedPrompts({
  conversationId,
  queued,
  paused,
  conversations,
}: {
  conversationId: string
  queued: Queued[]
  paused: boolean
  conversations: ConversationsBridge
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (queued.length === 0 && !paused) return null
  const run = async (action: () => Promise<unknown>, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(failure + ' ' + messageOf(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Queued prompts" className="flex flex-col gap-2 rounded-lg bg-panel px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <Title>Queued prompts</Title>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                conversations.request('queue.pause', {
                  operation_id: crypto.randomUUID(),
                  conversation_id: conversationId,
                  paused: !paused,
                }),
              paused ? "Couldn't resume the queue." : "Couldn't pause the queue.",
            )
          }
        >
          {paused ? 'Resume queue' : 'Pause queue'}
        </Button>
      </div>
      <Caption tone="muted" role="status">
        {paused
          ? 'The queue is paused. Queued prompts wait here and are not sent until you resume it.'
          : 'Queued prompts wait in ADE and are sent in order when the current turn ends.'}
      </Caption>
      <ol className="flex flex-col gap-2">
        {queued.map((entry, index) => (
          <li key={entry.id} className="flex min-w-0 items-start justify-between gap-2 rounded-md bg-card p-3">
            <div className="min-w-0">
              <Caption tone="muted">{index + 1}. Waiting in ADE's queue · not sent to the provider</Caption>
              <Body className="break-words">{entry.text}</Body>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Remove queued prompt ${index + 1} from ADE's queue`}
              onClick={() =>
                void run(
                  () =>
                    conversations.request('queue.cancel', { conversation_id: conversationId, request_id: entry.id }),
                  "Couldn't remove this queued prompt.",
                )
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      {error && (
        <Body role="alert" className="break-words">
          {error}
        </Body>
      )}
    </section>
  )
}
