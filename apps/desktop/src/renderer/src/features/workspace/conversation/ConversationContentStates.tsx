import { Body, Title } from '@/components/Typography'
import { Button } from '@/components/ui/button'

export function PaneState({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-base p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-2">
        <div role="status" className="flex flex-col items-center gap-2">
          <Title>{title}</Title>
          <Body tone="muted">{detail}</Body>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry history
          </Button>
        )}
      </div>
    </div>
  )
}
