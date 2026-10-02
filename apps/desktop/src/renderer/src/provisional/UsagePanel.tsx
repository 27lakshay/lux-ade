import { useEffect, useState } from 'react'
import type { UsageLimitWindow, UsageTokens, UsageTurn } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

const at = (ms: number) => new Date(ms).toLocaleString()
const count = (value: number | null) => (value === null ? 'not reported' : String(value))

function tokens(t: UsageTokens): string {
  const cached = t.cached_input === null ? '' : `, ${t.cached_input} cached`
  return `input ${count(t.input)}${cached} · output ${count(t.output)} tokens`
}

function turnLine(turn: UsageTurn): string {
  if (!turn.reported) return 'The provider reported no usage for this turn'
  const cost =
    turn.cost_usd === null
      ? 'cost not reported'
      : `$${turn.cost_usd.toFixed(4)}${turn.cost_basis === 'agent_estimate' ? " (the agent's estimate)" : ''}`
  return [tokens(turn.tokens), cost, `from ${turn.source ?? 'an unnamed report'}`, `observed ${at(turn.updated_at)}`]
    .concat(turn.note ? [turn.note] : [])
    .join(' · ')
}

function limitLine(window: UsageLimitWindow): string {
  const used = window.used_percent === null ? 'use not reported' : `${window.used_percent}% used`
  const span = window.window_minutes === null ? '' : ` of a ${window.window_minutes}-minute window`
  const reset = window.resets_at === null ? '' : `, resets ${at(window.resets_at)}`
  const status = window.status ? `, ${window.status.replaceAll('_', ' ')}` : ''
  const stale = window.reset_since_observed ? ' (the window has reset since this report)' : ''
  return `${window.limit_id}: ${used}${span}${reset}${status} · from ${window.source}, as of ${at(window.observed_at)}${stale}`
}

/**
 * Usage and limits as the provider reported them, with the native source and when ADE observed
 * each. A missing figure says so; it never reads as zero, and no cost is estimated by ADE.
 */
export function UsagePanel({
  conversationId,
  provider,
  conversations,
  version,
}: {
  conversationId: string
  provider: string
  conversations: ConversationsBridge
  version: number
}) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<UsageTurn[] | null>(null)
  const [limits, setLimits] = useState<UsageLimitWindow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    Promise.all([
      conversations.request('usage.turns', { conversation_id: conversationId, limit: 20 }),
      conversations.request('usage.limits', { provider }),
    ]).then(
      ([recorded, windows]) => {
        if (!active) return
        setTurns(recorded.turns)
        setLimits(windows.windows)
        setError(null)
      },
      (failure: unknown) => active && setError("Couldn't read usage. " + messageOf(failure)),
    )
    return () => {
      active = false
    }
  }, [conversationId, conversations, open, provider, version])
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
        Usage and limits
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-panel px-4 py-3" aria-label="Usage and limits">
          {error && <Body role="alert">{error}</Body>}
          <Caption>Turns, newest first</Caption>
          {turns?.length === 0 && <Caption tone="muted">No turns recorded yet.</Caption>}
          <ul aria-label="Turn usage" className="flex flex-col gap-1">
            {turns?.map((turn) => (
              <li key={turn.turn_id}>
                <Caption>{turnLine(turn)}</Caption>
              </li>
            ))}
          </ul>
          <Caption>Limits</Caption>
          {limits?.length === 0 && <Caption tone="muted">The provider has reported no limits.</Caption>}
          <ul aria-label="Usage limits" className="flex flex-col gap-1">
            {limits?.map((window) => (
              <li key={`${window.account_id ?? ''}:${window.limit_id}`}>
                <Caption>{limitLine(window)}</Caption>
              </li>
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
