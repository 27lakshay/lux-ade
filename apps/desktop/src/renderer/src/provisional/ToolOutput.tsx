import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Body, Meta } from '@/components/Typography'

/** The full text of a tool's output: text as written, structured output as indented JSON. */
function fullText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2)
}

/**
 * A tool's output: a bounded excerpt, and the whole output on request. The expansion grows below
 * its control, so the reading position and the control itself stay where they were.
 */
export function ToolOutput({
  label,
  output,
  excerpt,
}: {
  label: string
  output: unknown
  excerpt: { text: string; truncated: boolean }
}) {
  const [expanded, setExpanded] = useState(false)
  const region = useId()
  return (
    <div className="min-w-0">
      {/* The label changes on expansion; on its own line it cannot move the control. */}
      <div className="flex flex-col items-start gap-1">
        <Meta>
          {label}
          {excerpt.truncated && !expanded ? ' excerpt (bounded; full output not shown)' : ''}
        </Meta>
        {excerpt.truncated && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={region}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Show excerpt' : 'Show full output'}
          </Button>
        )}
      </div>
      {expanded ? (
        <ScrollArea
          id={region}
          role="region"
          aria-label={`Full ${label.toLowerCase()}`}
          className="*:data-[slot=scroll-area-viewport]:max-h-(--conversation-tool-output-max-height,60vh)"
        >
          <Body className="whitespace-pre-wrap [overflow-wrap:anywhere]">{fullText(output)}</Body>
        </ScrollArea>
      ) : (
        <Body id={region} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {excerpt.text}
        </Body>
      )}
    </div>
  )
}
