import { memo, useMemo } from 'react'
import type { SubmissionDelivery } from '@ade/contracts'
import { Body, Caption, Meta } from '@/components/Typography'
import { selectMessage, type ConversationMessage, type ConversationStore } from '../../../state/conversation-store'
import { useStore } from 'zustand'
import { RewindAction } from '@/provisional/Rewind'
import { ChildTranscripts } from '@/provisional/ChildTranscripts'
import { PluginTimelineItem } from '@/provisional/PluginTimelineItem'
import { ToolOutput } from '@/provisional/ToolOutput'
import { useTimelineView } from '../../../plugins/ui-host'
import { TranscriptMarkdown } from './TranscriptMarkdown'

const SUMMARY_LIMIT = 4_000

function preview(value: unknown): { text: string; truncated: boolean } {
  const parts: string[] = []
  let length = 0
  let truncated = false
  const append = (part: string): void => {
    if (length >= SUMMARY_LIMIT) {
      truncated = true
      return
    }
    const kept = part.slice(0, SUMMARY_LIMIT - length)
    parts.push(kept)
    length += kept.length
    if (kept.length < part.length) truncated = true
  }
  const visit = (item: unknown, depth: number): void => {
    if (length >= SUMMARY_LIMIT) {
      truncated = true
      return
    }
    if (typeof item === 'string') {
      append(item)
      return
    }
    if (item === null || typeof item !== 'object') {
      append(String(item))
      return
    }
    if (depth >= 2) {
      append(Array.isArray(item) ? `[${item.length} items]` : '{…}')
      truncated = true
      return
    }
    append(Array.isArray(item) ? '[' : '{')
    let count = 0
    if (Array.isArray(item)) {
      for (const value of item) {
        if (count >= 20 || length >= SUMMARY_LIMIT) {
          truncated = true
          break
        }
        if (count) append(', ')
        visit(value, depth + 1)
        count++
      }
      if (count < item.length) {
        append(count ? ', …' : '…')
        truncated = true
      }
      append(']')
      return
    }
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (count >= 20 || length >= SUMMARY_LIMIT) {
        truncated = true
        break
      }
      if (count) append(', ')
      append(`${key}: `)
      visit((item as Record<string, unknown>)[key], depth + 1)
      count++
    }
    if (truncated) append(count ? ', …' : '…')
    append('}')
  }
  visit(value, 0)
  return { text: parts.join(''), truncated }
}

function readableMessage(message: ConversationMessage): string {
  if (message.text) return message.text
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (typeof part === 'string') return [part]
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return [part.text]
        return []
      })
      .join('\n')
  }
  if (!content || typeof content !== 'object') return ''
  const details = content as Record<string, unknown>
  if (details.type === 'reasoning') {
    if (typeof details.text === 'string') return details.text
    if (typeof details.content === 'string') return details.content
  }
  if (details.type === 'plan') {
    const steps = Array.isArray(details.steps)
      ? details.steps
          .map((step) => {
            if (!step || typeof step !== 'object') return ''
            const item = step as Record<string, unknown>
            return [item.step, item.status].filter((value) => typeof value === 'string').join(' — ')
          })
          .filter(Boolean)
      : []
    return [typeof details.explanation === 'string' ? details.explanation : '', ...steps].filter(Boolean).join('\n')
  }
  if (details.type === 'subagents' && Array.isArray(details.agents)) {
    const agents = details.agents
      .map((agent) => {
        if (!agent || typeof agent !== 'object') return ''
        const item = agent as Record<string, unknown>
        return [item.name ?? item.id, item.state, item.summary].filter((value) => typeof value === 'string').join(' — ')
      })
      .filter(Boolean)
    return [typeof details.operation === 'string' ? details.operation : '', ...agents].filter(Boolean).join('\n')
  }
  const contentPreview = preview(content)
  return contentPreview.truncated
    ? `${contentPreview.text}\n[Content excerpt; some content not shown]`
    : contentPreview.text
}

function toolOutcome(message: ConversationMessage, details: Record<string, unknown>): string {
  const status = message.status
  if (details.is_error === true || status === 'failed' || status === 'error') return 'Failed'
  switch (status) {
    case 'completed':
      return details.output === null || details.output === undefined ? 'Incomplete' : 'Completed'
    case 'pending':
      return 'Pending'
    case 'streaming':
      return 'In progress'
    case 'interrupted':
      return 'Interrupted'
    case 'cancelled':
      return 'Cancelled'
    default:
      return typeof status === 'string' && status ? `Unknown status (${status})` : 'Unknown status'
  }
}

function ToolSummary({ message }: { message: ConversationMessage }) {
  const content = message.content
  const details =
    content && typeof content === 'object' && !Array.isArray(content) ? (content as Record<string, unknown>) : null
  if (details?.type !== 'tool') {
    return <Body className="whitespace-pre-wrap [overflow-wrap:anywhere]">{readableMessage(message)}</Body>
  }

  const input = details.input === null || details.input === undefined ? null : preview(details.input)
  const output = details.output === null || details.output === undefined ? null : preview(details.output)
  const callId = typeof details.call_id === 'string' ? details.call_id : null
  const name = typeof details.name === 'string' ? details.name : 'Tool activity'
  const outcome = toolOutcome(message, details)
  const failed = outcome === 'Failed'
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md bg-panel p-2" data-kind="tool-summary">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Caption>{name}</Caption>
        {callId && <Meta>Call {callId}</Meta>}
        <Meta role="status">{outcome}</Meta>
      </div>
      {input && (
        <div className="min-w-0">
          <Meta>Input{input.truncated ? ' excerpt (bounded; some input not shown)' : ''}</Meta>
          <Meta className="whitespace-pre-wrap break-words">{input.text}</Meta>
        </div>
      )}
      {output && <ToolOutput label={failed ? 'Failure output' : 'Output'} output={details.output} excerpt={output} />}
    </div>
  )
}

function SubmissionStatus({ delivery }: { delivery: SubmissionDelivery }) {
  const terminal = delivery.terminal
  const correlatedTerminal =
    terminal?.correlated && delivery.native_turn_id !== null && terminal.turn_id === delivery.native_turn_id
  const status =
    delivery.native_outcome === 'accepted'
      ? 'Accepted by native agent'
      : delivery.native_outcome === 'rejected'
        ? 'Native agent rejected this prompt'
        : delivery.native_outcome === 'unknown'
          ? 'Delivery outcome unknown'
          : !delivery.admitted
            ? 'Delivery pending'
            : delivery.dispatch === 'pending'
              ? 'Held by the provider adapter; the native agent has not taken it yet'
              : 'Sent to the native agent; awaiting its acceptance'
  return (
    <div className="flex flex-wrap gap-x-2" data-request-id={delivery.request_id}>
      <Meta>{status}</Meta>
      {delivery.error && <Meta>Failure: {delivery.error.replaceAll('_', ' ')}</Meta>}
      {delivery.recovery && <Meta>Recovery: {delivery.recovery.replaceAll('_', ' ')}</Meta>}
      {correlatedTerminal && <Meta>Correlated native turn terminal status: {terminal.status}</Meta>}
      {correlatedTerminal && terminal.error && <Meta>Terminal failure: {terminal.error.replaceAll('_', ' ')}</Meta>}
    </div>
  )
}

function isSubagents(content: unknown): content is { type: 'subagents'; agents: unknown[] } {
  return (
    content !== null &&
    typeof content === 'object' &&
    (content as Record<string, unknown>).type === 'subagents' &&
    Array.isArray((content as Record<string, unknown>).agents)
  )
}

export const MessageRow = memo(function MessageRow({
  store,
  id,
  provider,
  fallbackMessage,
}: {
  store: ConversationStore
  id: string
  provider: string
  fallbackMessage: ConversationMessage
}) {
  const liveMessage = useStore(
    store,
    useMemo(() => selectMessage(id), [id]),
  )
  const message = liveMessage ?? fallbackMessage
  const pluginView = useTimelineView(message.kind)
  const text = readableMessage(message)
  const content = message.content
  const isReasoning =
    message.kind === 'reasoning' ||
    (content !== null &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).type === 'reasoning')
  const isTool =
    message.kind === 'tool' ||
    (content !== null &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).type === 'tool')
  return (
    <article className="flex min-w-0 flex-col gap-2" data-message-id={message.id} data-role={message.role}>
      <Caption tone="muted">
        {isReasoning
          ? 'Reasoning'
          : message.role === 'user'
            ? 'You'
            : message.role === 'assistant'
              ? provider
              : message.role}
      </Caption>
      {isTool ? (
        <ToolSummary message={message} />
      ) : pluginView ? (
        <PluginTimelineItem
          message={message}
          view={pluginView}
          canonical={
            <Body as="div" className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <TranscriptMarkdown text={message.text} streaming={message.status === 'streaming'} />
            </Body>
          }
        />
      ) : (
        text && (
          <Body as="div" className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            <TranscriptMarkdown text={text} streaming={message.status === 'streaming'} />
          </Body>
        )
      )}
      {message.delivery?.recoverable_message_id === message.id && <SubmissionStatus delivery={message.delivery} />}
      {message.role === 'user' && <RewindAction messageId={message.id} />}
      {isSubagents(content) && (
        <ChildTranscripts conversationId={message.conversation_id} messageId={message.id} agents={content.agents} />
      )}
    </article>
  )
})
