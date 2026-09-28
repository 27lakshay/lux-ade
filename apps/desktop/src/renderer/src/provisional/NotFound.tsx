import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

// A route that does not exist, such as a stale link after an update.
export function NotFound() {
  return (
    <div className="fixed inset-0 bg-background">
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Nothing here</EmptyTitle>
          <EmptyDescription>This screen does not exist.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button render={<Link to="/" />}>Back to workspace</Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
