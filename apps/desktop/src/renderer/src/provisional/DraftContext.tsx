import { useId, useState } from 'react'
import type { ContextNode, ContextNodeReply, ContextPlan } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { messageOf } from './ConversationComposerSupport'

/** A context reference as a draft stores it: ADE keeps `data` exactly as its client supplied it. */
type Node = { id?: unknown; kind?: unknown; data?: unknown }

/** A readable line for any context reference, including a kind this build does not know. */
function contextLabel(node: unknown): string {
  const { id, kind, data } = (node ?? {}) as Node
  const fields = (data ?? {}) as Record<string, unknown>
  const provenance = (fields.provenance ?? {}) as Record<string, unknown>
  const name = [fields.label, fields.title, provenance.path, fields.path, id].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return `${typeof kind === 'string' ? kind.replaceAll('_', ' ') : 'context'}: ${name ?? 'unnamed reference'}`
}

/** The daemon context node a reference names, when it was captured through `context.capture`. */
function capturedNodeId(node: unknown): string | null {
  const fields = ((node ?? {}) as Node).data as Record<string, unknown> | undefined
  return typeof fields?.node_id === 'string' && fields.node_id ? fields.node_id : null
}

const ORIGIN: Record<string, string> = {
  daemon_read: 'read by ADE',
  client_supplied: 'text supplied by the client',
  browser_owner: 'captured by the browser',
}

/** The source identity of a captured node: where it came from, which part, and its digest. */
function sourceLine(node: ContextNode): string {
  const { provenance } = node
  const where = provenance.path ?? provenance.url ?? provenance.terminal_id ?? provenance.service ?? 'source'
  const lines =
    provenance.start_line !== null && provenance.end_line !== null
      ? ` · lines ${provenance.start_line}–${provenance.end_line}` +
        (provenance.total_lines !== null ? ` of ${provenance.total_lines}` : '')
      : ''
  const digest = node.sha256[0] ? ` · SHA-256 ${node.sha256[0].slice(0, 12)}` : ''
  return `${where}${lines} · ${ORIGIN[node.origin] ?? node.origin}${digest}`
}

/** The exact text the provider receives for a captured node, on request. */
function CapturedPreview({
  nodeId,
  label,
  plan,
  preview,
}: {
  nodeId: string
  label: string
  plan: ContextPlan | null
  preview: (nodeId: string) => Promise<ContextNodeReply>
}) {
  const [open, setOpen] = useState(false)
  const [reply, setReply] = useState<ContextNodeReply | null>(null)
  const [error, setError] = useState<string | null>(null)
  const region = useId()
  const toggle = () => {
    if (!open && !reply) {
      setError(null)
      preview(nodeId).then(setReply, (failure: unknown) =>
        setError("Couldn't read this context. " + messageOf(failure)),
      )
    }
    setOpen((value) => !value)
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="ghost" size="xs" type="button" aria-expanded={open} aria-controls={region} onClick={toggle}>
        {open ? 'Hide preview' : 'Preview what the provider receives'}
      </Button>
      {open && (
        <div id={region} role="region" aria-label={`Preview of ${label}`} className="flex w-full flex-col gap-1">
          {error ? (
            <Body role="alert">{error}</Body>
          ) : !reply ? (
            <Caption tone="muted">Reading the captured context…</Caption>
          ) : (
            <>
              <Caption tone="muted">{sourceLine(reply.node)}</Caption>
              {reply.node.truncated && (
                <Caption tone="muted">
                  Cut to fit: {reply.node.omitted_lines} lines and {reply.node.omitted_bytes} bytes are not included.
                </Caption>
              )}
              {!reply.available && (
                <Caption tone="muted">An attachment of this context was reclaimed; capture the context again.</Caption>
              )}
              {reply.previews.map((item) => {
                const prefix = plan?.parts.find((part) => part.attachment_id === item.attachment_id)?.text_prefix ?? ''
                return item.text === null ? (
                  <Caption key={item.attachment_id}>An image ({item.media_type}) is sent as it was captured.</Caption>
                ) : (
                  <ScrollArea
                    key={item.attachment_id}
                    className="w-full *:data-[slot=scroll-area-viewport]:max-h-(--conversation-context-preview-max-height,40vh)"
                  >
                    <Body
                      className="whitespace-pre-wrap [overflow-wrap:anywhere]"
                      data-attachment-id={item.attachment_id}
                    >
                      {prefix + item.text}
                    </Body>
                  </ScrollArea>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The context references a draft carries beside its text. The composer edits only text, so each
 * reference is listed readably and kept with the draft; it travels with the prompt as its
 * attachment. A reference captured by ADE offers the exact text the provider will receive.
 */
export function DraftContext({
  nodes,
  plan,
  preview,
}: {
  nodes: unknown[]
  plan: ContextPlan | null
  preview: (nodeId: string) => Promise<ContextNodeReply>
}) {
  if (nodes.length === 0) return null
  return (
    <ul aria-label="Draft context" className="flex flex-col gap-1">
      {nodes.map((node, index) => {
        const label = contextLabel(node)
        const nodeId = capturedNodeId(node)
        return (
          <li key={index} className="flex flex-col gap-1">
            <Caption tone="muted">{label}</Caption>
            {nodeId && <CapturedPreview nodeId={nodeId} label={label} plan={plan} preview={preview} />}
          </li>
        )
      })}
    </ul>
  )
}
