import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

// The frame every full-screen view shares: the whole window, a draggable title strip that clears the
// macOS window buttons, and a way back to the workspace. The views themselves are not designed yet;
// their content comes from Pen.
export function FullScreen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="drag flex h-(--titlebar-height) shrink-0 items-center justify-end px-4">
        <Link to="/" className="no-drag text-ui text-muted-foreground hover:text-foreground">
          Back to workspace
        </Link>
      </header>
      <section className="flex-1 overflow-auto px-10 py-6">
        <h1 className="text-title font-semibold">{title}</h1>
        {children}
      </section>
    </main>
  )
}
