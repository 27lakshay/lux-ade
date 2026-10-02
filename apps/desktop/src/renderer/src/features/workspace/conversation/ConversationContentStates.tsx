import type { AgentCancelOutcome } from '@ade/contracts'
import { Body, Meta, Title } from '@/components/Typography'
import { Button } from '@/components/ui/button'

function cancellationEvidenceFlag(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'yes' : 'no'
}

export function CancelOutcomeEvidence({ outcome }: { outcome: AgentCancelOutcome }) {
  const evidence = outcome.evidence
  return (
    <div className="flex flex-wrap gap-x-2" role="status" aria-live="polite" aria-label="Cancellation evidence">
      <Meta>
        Cancellation operation {outcome.operation_id} targeted attempt {outcome.source_attempt_id} and submission{' '}
        {outcome.submission_id}
        {outcome.turn_id == null ? '' : ' and turn ' + outcome.turn_id}.
      </Meta>
      <Meta>
        Scope: {evidence.scope}; interruption requested: {evidence.interruption_requested ? 'yes' : 'no'}; termination:{' '}
        {evidence.termination}; active work remaining: {cancellationEvidenceFlag(evidence.active_work_remaining)};
        queued work count: {evidence.queued_work_count ?? 'unknown'}; background work remaining:{' '}
        {cancellationEvidenceFlag(evidence.background_work_remaining)}; observed at (ms):{' '}
        {evidence.observed_at_ms ?? 'unknown'}.
      </Meta>
    </div>
  )
}

export function PaneState({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-base p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-2">
        <div role="status" className="flex flex-col items-center gap-2">
          <Title>{title}</Title>
          <Body tone="muted">{detail}</Body>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry history
          </Button>
        )}
      </div>
    </div>
  )
}
