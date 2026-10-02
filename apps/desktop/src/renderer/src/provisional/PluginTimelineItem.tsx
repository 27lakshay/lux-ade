import { useMemo, useState, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import type { PluginTimelineContribution } from '@ade/contracts'
import { Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import type { ConversationMessage } from '../state/conversation-store'
import { useTimelineDeclaration, type TimelineItem, type TimelineView } from '../plugins/ui-host'
import { messageOf } from './ConversationComposerSupport'

/**
 * The declared actions on a plugin item. Each runs the plugin's command through the daemon
 * (`plugin.command.invoke`, an effect command with a receipt) and stays available when the custom
 * view is not.
 */
function TimelineActions({
  pluginId,
  contribution,
  message,
}: {
  pluginId: string
  contribution: PluginTimelineContribution
  message: ConversationMessage
}) {
  const [status, setStatus] = useState<string | null>(null)
  if (!contribution.actions?.length) return null
  const run = async (title: string, command: string) => {
    setStatus(null)
    try {
      const reply = await window.adeHost!.conversations.request('plugin.command.invoke', {
        operation_id: crypto.randomUUID(),
        plugin_id: pluginId,
        command_id: command,
        args: { conversation_id: message.conversation_id, message_id: message.id },
      })
      setStatus(`${title}: ${reply.outcome.status.replaceAll('_', ' ')}`)
    } catch (error) {
      setStatus(`${title} failed. ` + messageOf(error))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Plugin actions" role="group">
      {contribution.actions.map((action) => (
        <Button key={action.command} size="sm" variant="outline" onClick={() => void run(action.title, action.command)}>
          {action.title}
        </Button>
      ))}
      {status && (
        <Caption tone="muted" role="status">
          {status}
        </Caption>
      )}
    </div>
  )
}

function Fallback({ children, reason }: { children: ReactNode; reason: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-plugin-view="fallback">
      {children}
      <Caption tone="muted">Custom view unavailable: {reason}</Caption>
    </div>
  )
}

/**
 * A message of a plugin-declared kind. Its registered renderer shows it inside an error boundary;
 * when the renderer is missing, still loading, disabled or throws, the message's canonical text
 * shows instead, with the reason.
 */
export function PluginTimelineItem({
  message,
  view,
  canonical,
}: {
  message: ConversationMessage
  view: TimelineView
  /** The core rendering of the message's canonical text. */
  canonical: ReactNode
}) {
  const content = message.content as { type?: unknown; data?: unknown } | null | undefined
  const data = content?.type === 'extension' ? content.data : null
  const item = useMemo<TimelineItem>(
    () =>
      Object.freeze({
        id: message.id,
        kind: message.kind,
        role: message.role,
        status: message.status,
        text: message.text,
        data: data === null || data === undefined ? null : Object.freeze(structuredClone(data)),
      }),
    [data, message.id, message.kind, message.role, message.status, message.text],
  )
  const declared = useTimelineDeclaration(message.kind)
  const actions = declared && (
    <TimelineActions pluginId={declared.pluginId} contribution={declared.contribution} message={message} />
  )
  if ('reason' in view)
    return (
      <>
        <Fallback reason={view.reason}>{canonical}</Fallback>
        {actions}
      </>
    )
  const { component: Renderer, pluginId, contribution } = view.renderer
  const missing = (contribution.required_fields ?? []).filter(
    (field) => !data || typeof data !== 'object' || !(field in (data as Record<string, unknown>)),
  )
  if (missing.length)
    return (
      <>
        <Fallback reason={`the payload lacks ${missing.join(', ')}`}>{canonical}</Fallback>
        {actions}
      </>
    )
  return (
    <>
      <ErrorBoundary
        resetKeys={[Renderer, item]}
        onError={(error) => console.error(`Plugin ${pluginId} timeline renderer ${contribution.id} failed`, error)}
        fallbackRender={({ error }) => (
          <Fallback reason={`${contribution.title} failed (${error instanceof Error ? error.message : String(error)})`}>
            {canonical}
          </Fallback>
        )}
      >
        <div className="min-w-0" data-plugin-view="custom" data-plugin-contribution={contribution.id}>
          <Renderer item={item} />
        </div>
      </ErrorBoundary>
      {actions}
    </>
  )
}
