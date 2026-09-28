import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from 'vitest-browser-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createAppRouter } from '../../app/router'
import { MotionProvider } from '../../app/MotionProvider'
import '../../app/app.css'
import type { RenderContent } from './content/ContentHosts'
import { defaultLayout } from './model/layout'
import { DEFAULT_WORKSPACE, layoutStore } from './model/layout-store'
import { Workspace } from './Workspace'

// Renders the workspace at window size with the app's providers, for browser tests.

export function resetLayout(): void {
  localStorage.removeItem('ade.layouts')
  layoutStore.setState({
    active: DEFAULT_WORKSPACE,
    layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') },
    recent: [DEFAULT_WORKSPACE],
    keepMounted: 3,
  })
  document.documentElement.style.setProperty('--titlebar-height', '40px')
  document.documentElement.style.setProperty('--traffic-lights-inset', '80px')
}

export function renderWorkspace(renderContent?: RenderContent) {
  const Screen = () => <Workspace renderContent={renderContent} />
  const router = createAppRouter({ Workspace: Screen, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(
    <div style={{ width: 1440, height: 900 }}>
      <QueryClientProvider client={new QueryClient()}>
        <MotionProvider>
          <TooltipProvider delay={0}>
            <RouterProvider router={router} />
          </TooltipProvider>
        </MotionProvider>
      </QueryClientProvider>
    </div>,
  )
}

export const section = (label: string): Element | null => document.querySelector(`section[aria-label="${label}"]`)
