import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

// Shown over a terminal whose stream closed and would not come back: why, and the two ways on.
// Provisional until the terminal's Pen design covers it.

export function TerminalStatus({
  message,
  onReconnect,
  onRestart,
}: {
  message: string
  onReconnect: () => void
  onRestart: () => void
}) {
  return (
    <Alert className="absolute inset-x-3 bottom-3 w-auto">
      <AlertTitle>The terminal is not connected</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onRestart}>
            Restart shell
          </Button>
          <Button size="sm" onClick={onReconnect}>
            Reconnect
          </Button>
        </div>
      </AlertAction>
    </Alert>
  )
}
