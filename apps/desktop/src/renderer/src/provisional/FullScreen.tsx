import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Heading, Text } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'

// The frame every full-screen view shares: the whole window, a draggable title strip that clears the
// macOS window buttons, and a way back to the workspace. The views themselves are not designed yet;
// their content comes from Pen.
export function FullScreen({ title, children, backHref }: { title: string; children?: ReactNode; backHref?: string }) {
  return (
    <main aria-label={title} className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="drag flex h-(--titlebar-height) shrink-0 items-center justify-end px-4">
        {backHref ? (
          <a href={backHref} className="no-drag text-muted-foreground hover:text-foreground">
            <Text tone="inherit">Back to workspace</Text>
          </a>
        ) : (
          <Link to="/" className="no-drag text-muted-foreground hover:text-foreground">
            <Text tone="inherit">Back to workspace</Text>
          </Link>
        )}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <section className="ade-fullscreen-content flex flex-col px-10 py-6">
          <Heading>{title}</Heading>
          {children}
        </section>
      </ScrollArea>
    </main>
  )
}
