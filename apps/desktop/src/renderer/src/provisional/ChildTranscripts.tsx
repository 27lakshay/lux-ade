import { useState } from 'react'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { messageOf } from './ConversationComposerSupport'

type Child = { id: string; name: string | null; state: string | null }
type Page = { items: string[]; offset: number | null; cursor: string | null; done: boolean }

/** A readable line for a transcript item of any shape: its role and text, else a bounded excerpt. */
function itemText(item: unknown): string {
  if (item && typeof item === 'object') {
    const value = item as Record<string, unknown>
    if (typeof value.text === 'string' && value.text)
      return `${typeof value.role === 'string' ? value.role : 'item'}: ${value.text}`
  }
  const json = JSON.stringify(item) ?? String(item)
  return json.length > 2000 ? json.slice(0, 2000) + ' [excerpt]' : json
}

/**
 * The child agents a subagent message names, each with its own transcript read page by page from
 * the provider through the daemon. A child whose transcript the provider cannot give says why;
 * the parent's summary stays readable either way.
 */
export function ChildTranscripts({
  conversationId,
  messageId,
  agents,
}: {
  conversationId: string
  messageId: string
  agents: unknown[]
}) {
  const children: Child[] = agents.flatMap((agent) => {
    const value = (agent ?? {}) as Record<string, unknown>
    return typeof value.id === 'string'
      ? [
          {
            id: value.id,
            name: typeof value.name === 'string' ? value.name : null,
            state: typeof value.state === 'string' ? value.state : null,
          },
        ]
      : []
  })
  const [pages, setPages] = useState<Record<string, Page>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const load = async (child: Child) => {
    const current = pages[child.id]
    try {
      const page = await window.adeHost!.conversations.request('agent.child_transcript', {
        conversation_id: conversationId,
        message_id: messageId,
        child_id: child.id,
        ...(current?.cursor ? { cursor: current.cursor } : current?.offset ? { offset: current.offset } : {}),
      })
      const next: Page = {
        items: [...(current?.items ?? []), ...page.items.map(itemText)],
        offset: page.next_offset ?? null,
        cursor: page.next_cursor ?? null,
        done: (page.next_offset ?? null) === null && (page.next_cursor ?? null) === null,
      }
      setPages((all) => ({ ...all, [child.id]: next }))
      setErrors(({ [child.id]: _dropped, ...rest }) => rest)
    } catch (error) {
      setErrors((all) => ({ ...all, [child.id]: "This child's transcript is unavailable. " + messageOf(error) }))
    }
  }
  if (children.length === 0) return null
  return (
    <ul aria-label="Child agents" className="flex flex-col gap-2">
      {children.map((child) => {
        const page = pages[child.id]
        return (
          <li key={child.id} className="flex flex-col gap-1">
            <Caption>
              {child.name ?? child.id}
              {child.state ? ` · ${child.state}` : ''}
            </Caption>
            {page && (
              <ol aria-label={`Transcript of ${child.name ?? child.id}`} className="flex flex-col gap-1">
                {page.items.map((item, index) => (
                  <li key={index}>
                    <Body className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item}</Body>
                  </li>
                ))}
              </ol>
            )}
            {errors[child.id] && <Body role="alert">{errors[child.id]}</Body>}
            {!page?.done && (
              <Button size="sm" variant="outline" className="self-start" onClick={() => void load(child)}>
                {page ? 'Load more of the transcript' : 'Show transcript'}
              </Button>
            )}
            {page?.done && <Caption tone="muted">End of transcript</Caption>}
          </li>
        )
      })}
    </ul>
  )
}
