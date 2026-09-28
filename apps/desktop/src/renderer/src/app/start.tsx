import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TITLEBAR_HEIGHT } from '../../../shared/window-chrome'
import { Workspace } from '../features/workspace/Workspace'
import { IconProvider } from '../icons/Icon'
import { CommandPalette, openCommandPalette } from '../provisional/CommandPalette'
import { ConfirmHost } from '../provisional/ConfirmDialog'
import { ErrorReport } from '../provisional/ErrorReport'
import './app.css'
import { commandService, registerAppCommands } from './commands'
import { clearOnProfileSwitch, queryClient } from './query-client'
import { createAppRouter } from './router'
import { startTheme } from './theme'

// Starts the app in this window: theme, commands, routing, then the first render. Called once by
// src/bootstrap.ts.
export async function start(): Promise<void> {
  startTheme()
  // Screens lay out their title row with var(--titlebar-height); main places the window buttons.
  document.documentElement.style.setProperty('--titlebar-height', `${TITLEBAR_HEIGHT}px`)

  registerAppCommands()
  commandService.listen(window)
  if (window.adeHost) clearOnProfileSwitch(window.adeHost.profiles)

  const router = createAppRouter({ Workspace })
  // Menu commands that change the screen. Any other command acts on the workspace, so it first
  // returns there from a full-screen view.
  window.adeHost?.onCommand((command) => {
    if (command === 'command-palette') openCommandPalette()
    else if (command === 'open-settings') void router.navigate({ to: '/settings' })
    else if (command === 'open-onboarding') void router.navigate({ to: '/onboarding' })
    else if (router.state.location.pathname !== '/') void router.navigate({ to: '/' })
  })
  // Resolve the first screen before rendering, so the window never paints an empty frame.
  await router.load()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }) => <ErrorReport error={error} onRetry={resetErrorBoundary} />}
      >
        <QueryClientProvider client={queryClient}>
          <IconProvider>
            <TooltipProvider>
              <Toaster>
                <RouterProvider router={router} />
                <CommandPalette service={commandService} />
                <ConfirmHost />
              </Toaster>
            </TooltipProvider>
          </IconProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}
