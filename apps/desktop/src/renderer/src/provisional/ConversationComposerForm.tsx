import type { DraftStash } from '@ade/contracts'
import type { ComponentProps } from 'react'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { EditorContent } from '@tiptap/react'
import { PromptDeliveryStatus } from './PromptDeliveryStatus'

type Delivery = 'sending' | 'pending' | 'unknown' | 'rejected'

export function ConversationComposerForm({
  promptId,
  editor,
  ready,
  busy,
  attemptRequestId,
  delivery,
  admitted,
  detail,
  canSubmit,
  onSubmit,
  onRetry,
  onUnlockRejected,
  recoveryBusy,
  draftStashes,
  onOpenDraftRecovery,
  onRestoreDraftRecovery,
}: {
  promptId: string
  editor: ComponentProps<typeof EditorContent>['editor']
  ready: boolean
  busy: boolean
  attemptRequestId: string | null
  delivery: Delivery | null
  admitted: boolean
  detail: string | null
  canSubmit: boolean
  onSubmit: () => Promise<void>
  onRetry: () => Promise<void>
  onUnlockRejected: () => void
  recoveryBusy: boolean
  draftStashes: DraftStash[] | null
  onOpenDraftRecovery: () => Promise<void>
  onRestoreDraftRecovery: (stash: DraftStash) => Promise<void>
}) {
  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-panel px-4 py-3"
      aria-label="Prompt composer"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit()
      }}
    >
      <Field className="min-w-0">
        <FieldLabel htmlFor={promptId}>Prompt</FieldLabel>
        <EditorContent editor={editor} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PromptDeliveryStatus requestId={attemptRequestId} delivery={delivery} admitted={admitted} detail={detail} />
        {attemptRequestId ? (
          delivery === 'unknown' ? (
            <Button size="sm" type="button" onClick={() => void onRetry()} disabled={busy}>
              Reconcile delivery
            </Button>
          ) : delivery === 'rejected' ? (
            <Button
              size="sm"
              type="button"
              onClick={(event) => {
                event.preventDefault()
                onUnlockRejected()
              }}
              disabled={busy}
            >
              Edit or retry prompt
            </Button>
          ) : (
            <Button size="sm" type="button" disabled>
              {delivery === 'sending' ? 'Sending…' : 'Waiting for confirmation'}
            </Button>
          )
        ) : (
          <Button size="sm" type="submit" disabled={!ready || busy || !canSubmit}>
            Send prompt
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          type="button"
          aria-controls={promptId + '-recovery'}
          aria-expanded={draftStashes !== null}
          onClick={() => void onOpenDraftRecovery()}
          disabled={!ready || busy || recoveryBusy || attemptRequestId !== null}
        >
          {recoveryBusy ? 'Loading draft recovery…' : 'Recover saved draft'}
        </Button>
        {draftStashes !== null && (
          <section id={promptId + '-recovery'} className="space-y-2" aria-label="Saved draft recovery copies">
            {draftStashes.length === 0 ? (
              <Caption tone="muted" role="status">
                No saved draft recovery copies are available.
              </Caption>
            ) : (
              <>
                <Caption tone="muted">Restoring a saved draft keeps the replaced draft available for recovery.</Caption>
                <ul className="space-y-2">
                  {draftStashes.map((stash, index) => (
                    <li
                      key={stash.name + ':' + stash.revision}
                      className="flex min-w-0 flex-col gap-2 rounded-md bg-card p-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0">
                        <Body weight="medium">
                          Saved draft {index + 1} · {new Date(stash.saved_at).toLocaleString()}
                        </Body>
                        <Body className="break-words" tone="muted">
                          {stash.text ? stash.text.slice(0, 180) + (stash.text.length > 180 ? '…' : '') : 'Empty draft'}
                        </Body>
                      </div>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void onRestoreDraftRecovery(stash)}
                        disabled={busy || recoveryBusy || attemptRequestId !== null}
                      >
                        Restore draft {index + 1}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
      {!ready && <Caption tone="muted">Restoring saved prompt…</Caption>}
    </form>
  )
}
