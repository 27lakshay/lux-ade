import { useEffect, useState } from 'react'
import type { CommandEntry, CommandList } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'

/**
 * The commands and skills this conversation's provider can run, with where each came from. Run
 * hands one to the provider in its native form through the prompt queue, a tracked effect with
 * its own receipt; typing `/name` in the prompt instead sends it to the agent as text.
 */
export function CommandsPanel({
  conversationId,
  conversations,
}: {
  conversationId: string
  conversations: ConversationsBridge
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<CommandList | null>(null)
  const [args, setArgs] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    conversations.request('command.list', { conversation_id: conversationId }).then(
      (reply) => active && setList(reply),
      (error: unknown) => active && setMessage("Couldn't list commands. " + messageOf(error)),
    )
    return () => {
      active = false
    }
  }, [conversationId, conversations, open])
  const run = async (entry: CommandEntry) => {
    setMessage(null)
    try {
      const reply = await conversations.request('command.invoke', {
        operation_id: crypto.randomUUID(),
        conversation_id: conversationId,
        name: entry.name,
        kind: entry.kind,
        arguments: args[entry.name] ?? '',
      })
      // Queued is ADE's queue holding the native text, not a provider acknowledgement.
      setMessage(
        reply.outcome === 'queued'
          ? `${reply.native_text ?? entry.name} is in this conversation's queue for the provider to run as its own ${entry.kind}. Its result appears in the conversation.`
          : `${entry.name}: ${reply.outcome}. ${reply.reason ?? ''}`.trim(),
      )
    } catch (error) {
      setMessage(`Couldn't run ${entry.name}. Nothing was queued. ` + messageOf(error))
    }
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
        Commands and skills
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-panel px-4 py-3" aria-label="Commands and skills">
          <Caption tone="muted">
            Run hands an entry to the provider as its own command. Typing /name in the prompt sends it as text.
          </Caption>
          {list && list.entries.length === 0 && (
            <Caption tone="muted">This provider has no listed commands or skills.</Caption>
          )}
          <ul aria-label="Provider commands" className="flex flex-col gap-2">
            {list?.entries.map((entry) => (
              <li key={`${entry.kind}:${entry.name}`} className="flex flex-col gap-1">
                <Caption>
                  {entry.kind === 'skill' ? 'Skill' : 'Command'} {entry.invocation ?? entry.name}
                  {entry.description ? ` — ${entry.description}` : ''} · from{' '}
                  {entry.provenance.source.replaceAll('_', ' ')}
                  {entry.provenance.path ? ` (${entry.provenance.path})` : ''}
                </Caption>
                {entry.invocable ? (
                  <div className="flex gap-2">
                    <Input
                      aria-label={`Arguments for ${entry.name}`}
                      placeholder={entry.argument_hint ?? 'Arguments'}
                      value={args[entry.name] ?? ''}
                      onChange={(event) => setArgs({ ...args, [entry.name]: event.target.value })}
                    />
                    <Button size="sm" onClick={() => void run(entry)}>
                      Run {entry.name}
                    </Button>
                  </div>
                ) : (
                  <Caption tone="muted">Unavailable: {entry.reason ?? 'the provider cannot run it'}</Caption>
                )}
                {entry.invocable && entry.reason && <Caption tone="muted">{entry.reason}</Caption>}
              </li>
            ))}
          </ul>
          {list && !list.native_catalog.queried && <Caption tone="muted">{list.native_catalog.reason}</Caption>}
          {message && <Body role="status">{message}</Body>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
