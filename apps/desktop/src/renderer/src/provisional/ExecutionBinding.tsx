import type { Conversation } from '@ade/contracts'
import { Meta } from '@/components/Typography'
import type { ConversationState } from '../state/conversation-store'
import { SyncStatus } from './SyncStatus'
import { ConversationRecovery } from './ConversationRecovery'

/**
 * What the open provider session was bound to, as the daemon recorded it: the CLI and SDK read
 * the same `execution` record. An ambient session uses the machine's own login, unisolated.
 */
export function ExecutionBinding({ state }: { state: ConversationState }) {
  const conversation = (state.snapshot?.conversation ?? null) as Conversation | null
  const execution = conversation?.execution ?? null
  return (
    <>
      {execution ? (
        <Meta aria-label="Session binding">
          {execution.account_context === 'managed'
            ? `Session bound to account generation ${execution.account_generation ?? 'unknown'}`
            : "Session uses this machine's own login, not isolated by ADE"}
          {execution.reattached ? ' · reattached after restart' : ''}
        </Meta>
      ) : (
        <Meta>No provider session open</Meta>
      )}
      {conversation && <SessionActivity conversation={conversation} />}
      <SyncStatus replay={state.status} revision={state.snapshot?.revision ?? null} />
      {conversation && <ConversationRecovery conversation={conversation} />}
    </>
  )
}

/**
 * Work the provider session does apart from a prompt: background tasks it reports, and output no
 * prompt owns. Unknown is said as unknown; silence is never shown as finished.
 */
function SessionActivity({ conversation }: { conversation: Conversation }) {
  const { background, autonomous_output_at_ms: autonomous } = conversation
  const parts: string[] = []
  if (background?.active === true)
    parts.push(
      background.running === null
        ? 'Background work running'
        : `${background.running} background ${background.running === 1 ? 'task' : 'tasks'} running`,
    )
  else if (background && background.active === null)
    parts.push(
      background.source === 'provider_exited'
        ? 'Background work unknown: the provider stopped'
        : 'Background work unknown',
    )
  else if (background?.active === false) parts.push('No background work running')
  if (autonomous !== null) parts.push(`Session output without a prompt at ${new Date(autonomous).toLocaleTimeString()}`)
  if (parts.length === 0) return null
  return (
    <Meta aria-label="Session activity" data-background={background?.active ?? 'unknown'}>
      {parts.join(' · ')}
    </Meta>
  )
}
