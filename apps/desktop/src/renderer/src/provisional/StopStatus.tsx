import type { AgentTerminateOutcome, ConversationStop } from '@ade/contracts'
import { Body } from '@/components/Typography'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

function flag(value: boolean | null | undefined): string {
  return value == null ? 'unknown' : value ? 'yes' : 'no'
}

function headline(stop: ConversationStop): { title: string; detail: string } {
  if (stop.outcome === 'confirmed') {
    if (stop.confirmation === 'process_exit')
      return {
        title: 'Stopped',
        detail:
          stop.evidence?.background_work_remaining === false
            ? 'The provider process ended.'
            : 'The provider process ended. Child or background processes it started may still be running.',
      }
    if (stop.confirmation === 'native_terminal')
      return {
        title: 'Stopped',
        detail:
          stop.native_status === 'completed'
            ? 'The turn finished before the stop took effect.'
            : `The provider reported the turn ended (${stop.native_status ?? 'status not reported'}).`,
      }
    return { title: 'Stopped', detail: stop.reason ?? 'Nothing was running.' }
  }
  if (stop.outcome === 'unresolved')
    return { title: 'Stop unresolved', detail: `${stop.reason ?? 'The work may still be running.'}` }
  return stop.delivery === 'acknowledged'
    ? { title: 'Stopping', detail: 'The provider acknowledged the stop. Waiting for the turn to end.' }
    : { title: 'Stop requested', detail: 'Waiting for the provider to acknowledge the stop.' }
}

export function StopStatus({
  stop,
  terminating,
  terminateOutcome,
  terminateError,
  onTerminate,
  queuedPrompts,
  queuePaused,
}: {
  stop: ConversationStop
  queuedPrompts: number
  queuePaused: boolean
  terminating: boolean
  terminateOutcome: AgentTerminateOutcome | null
  terminateError: string | null
  onTerminate: (() => void) | null
}) {
  const { title, detail } = headline(stop)
  const evidence = stop.evidence
  return (
    <Alert
      role="status"
      aria-live="polite"
      aria-label="Stop status"
      data-stop-outcome={stop.outcome}
      data-stop-delivery={stop.delivery}
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <Body>{detail}</Body>
        {evidence && (
          <Body>
            Scope: {evidence.scope}. Queued inputs: {evidence.queued_work_count ?? 'unknown'}. Foreground work
            remaining: {flag(evidence.active_work_remaining)}. Background work remaining:{' '}
            {flag(evidence.background_work_remaining)}.
          </Body>
        )}
        {queuedPrompts > 0 && (
          <Body>
            {queuedPrompts === 1 ? '1 prompt remains' : `${queuedPrompts} prompts remain`} in ADE's queue
            {queuePaused ? '; the queue is paused, so it will not run until you resume it.' : ' and will run next.'}
          </Body>
        )}
        {stop.escalation === 'terminate_process' && (
          <Body>
            Terminating ends the provider process ADE started for this conversation. Child or background processes it
            started may survive.
          </Body>
        )}
        {terminateOutcome && !terminateOutcome.process_exited && <Body>{terminateOutcome.limits.join('. ')}.</Body>}
        {terminateError && <Body role="alert">Termination failed: {terminateError}</Body>}
      </AlertDescription>
      {stop.escalation === 'terminate_process' && onTerminate && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onTerminate} disabled={terminating}>
            {terminating ? 'Terminating…' : 'Terminate provider process'}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}
