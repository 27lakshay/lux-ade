import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { useDraftAttachments } from './useDraftAttachments'

const FORM: Record<string, string> = {
  native_image: 'sent as an image',
  text_block: 'sent as a text block',
  prompt_text: 'added to the prompt text',
  adapter_declared: 'sent in the form the provider declares',
}

/** The draft's attachments with what the provider will receive for each, before sending. */
export function DraftAttachments({
  state,
  disabled,
}: {
  state: ReturnType<typeof useDraftAttachments>
  disabled: boolean
}) {
  const { attachments, plan } = state
  const outcome = (id: string): string => {
    if (!plan) return 'Checking…'
    const refusal = plan.rejections.find((rejection) => rejection.attachment_id === id)
    if (refusal) return 'Will be refused: ' + refusal.message
    const part = plan.parts.find((item) => item.attachment_id === id)
    return part ? (FORM[part.form] ?? part.form) : 'Not planned'
  }
  const whole = plan?.rejections.filter((rejection) => !rejection.attachment_id) ?? []
  return (
    <div className="flex flex-col gap-1">
      {attachments.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-col gap-1">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center justify-between gap-2">
              <Caption>
                {attachment.name} · {attachment.size} bytes · {outcome(attachment.id)}
              </Caption>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled || state.working}
                onClick={() => void state.remove(attachment.id)}
              >
                Remove {attachment.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {whole.map((rejection) => (
        <Caption key={rejection.code} tone="muted">
          Will be refused: {rejection.message}
        </Caption>
      ))}
      <Button
        size="sm"
        variant="outline"
        type="button"
        className="self-start"
        disabled={disabled || state.working}
        onClick={() => void state.attach()}
      >
        {state.working ? 'Attaching…' : 'Attach files'}
      </Button>
      {state.message && (
        <Body role="alert" className="break-words">
          {state.message}
        </Body>
      )}
    </div>
  )
}
