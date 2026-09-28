import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

// What a crashed screen shows: the error, a way to copy it into a bug report, and a retry. Stock
// kit until an error screen is designed in Pen.
export function ErrorReport({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const report = describe(error)
  const copy = (): void => {
    void navigator.clipboard.writeText(report).then(() => setCopied(true))
  }
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{error instanceof Error ? error.message : String(error)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button onClick={onRetry}>Try again</Button>
          <Button variant="outline" onClick={copy}>
            {copied ? 'Copied' : 'Copy error report'}
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  )
}

function describe(error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  return [detail, '', `URL: ${location.href}`, `User agent: ${navigator.userAgent}`].join('\n')
}
