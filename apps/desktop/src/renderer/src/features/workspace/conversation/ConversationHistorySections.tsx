import { Caption } from '@/components/Typography'
import type { ConversationMessage, ConversationStore } from '../../../state/conversation-store'
import { ConversationTimeline } from './ConversationTimeline'

type AnchorCapture = { current: (() => void) | null }

export function ConversationHistorySections({
  store,
  provider,
  nativeMessages,
  currentMessages,
  historyAnchorCapture,
  currentAnchorCapture,
}: {
  store: ConversationStore
  provider: string
  nativeMessages: ConversationMessage[] | null
  currentMessages: ConversationMessage[]
  historyAnchorCapture: AnchorCapture
  currentAnchorCapture: AnchorCapture
}) {
  if (nativeMessages === null) {
    return (
      <ConversationTimeline
        store={store}
        messages={currentMessages}
        provider={provider}
        ariaLabel="Conversation history"
        captureAnchorRef={historyAnchorCapture}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-label="Native history evidence" className="flex min-h-0 flex-1 flex-col">
        <Caption className="mx-auto w-full max-w-[640px] px-4 pt-2">Native history observations</Caption>
        <ConversationTimeline
          store={store}
          messages={nativeMessages}
          provider={provider}
          ariaLabel="Native history messages"
          captureAnchorRef={historyAnchorCapture}
        />
      </section>
      {currentMessages.length > 0 && (
        <section aria-label="Current ADE evidence" className="flex min-h-0 flex-1 flex-col">
          <Caption className="mx-auto w-full max-w-[640px] px-4 pt-2">Current ADE conversation</Caption>
          <ConversationTimeline
            store={store}
            messages={currentMessages}
            provider={provider}
            ariaLabel="Current ADE messages"
            captureAnchorRef={currentAnchorCapture}
          />
        </section>
      )}
    </div>
  )
}
