import { Body, Meta, Text } from '../components/Typography'

type Delivery = 'sending' | 'pending' | 'unknown' | 'rejected' | null

export function PromptDeliveryStatus({
  requestId,
  delivery,
  admitted,
  detail,
}: {
  requestId: string | null
  delivery: Delivery
  admitted: boolean
  detail: string | null
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
      {requestId && delivery === 'sending' && (
        <Text role="status" tone="muted">
          Submitting prompt…
        </Text>
      )}
      {requestId && delivery === 'pending' && (
        <Text role="status" tone="muted">
          {admitted
            ? 'The app accepted this request; native delivery is awaiting confirmation.'
            : 'Delivery is pending. This prompt and its request ID remain here.'}
        </Text>
      )}
      {requestId && delivery === 'unknown' && (
        <Text role="status" tone="muted">
          Delivery is unknown. Reconcile using the same request ID.
        </Text>
      )}
      {requestId && delivery === 'rejected' && (
        <Text role="status" tone="muted">
          The native agent rejected this prompt. Your text stays available.
        </Text>
      )}
      {requestId && <Meta className="break-all select-text">Request ID: {requestId}</Meta>}
      {detail && (
        <Body role="alert" className="break-words">
          {detail}
        </Body>
      )}
    </div>
  )
}
