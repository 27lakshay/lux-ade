import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TITLEBAR_HEIGHT, TRAFFIC_LIGHTS_INSET } from '../../../shared/window-chrome'
import { Workspace } from '../features/workspace/Workspace'
import { handleLayoutCommand, registerLayoutCommands } from '../features/workspace/model/layout-commands'
import { createDaemonStore } from '../state/daemon-store'
import { DaemonStoreContext } from '../state/hooks'
import { IconProvider } from '../icons/Icon'
import { MotionProvider } from './MotionProvider'
import { startMotionPreference } from './motion-preference'
import { CommandPalette, openCommandPalette } from '../provisional/CommandPalette'
import { ConfirmHost } from '../provisional/ConfirmDialog'
import { NameHost } from '../provisional/NameDialog'
import { ErrorReport } from '../provisional/ErrorReport'
import './app.css'
import { commandService, registerAppCommands } from './commands'
import { clearOnProfileSwitch, queryClient } from './query-client'
import { createAppRouter } from './router'
import { startProfileSettings } from './profile-settings'
import { startTheme } from './theme'

// Starts the app in this window: theme, commands, routing, then the first render. Called once by
// src/bootstrap.ts.
async function loadBench() {
  const { benchContent } = await import('../dev/bench')
  return benchContent
}

export async function start(): Promise<void> {
  startTheme()
  startMotionPreference()
  // Screens lay out their title row with var(--titlebar-height); main places the window buttons.
  document.documentElement.style.setProperty('--titlebar-height', `${TITLEBAR_HEIGHT}px`)
  document.documentElement.style.setProperty('--traffic-lights-inset', `${TRAFFIC_LIGHTS_INSET}px`)

  registerAppCommands()
  registerLayoutCommands()
  commandService.listen(window)
  if (window.adeHost) clearOnProfileSwitch(window.adeHost.profiles)

  // Development (or a build made with VITE_ADE_BENCH=1) only: ?bench fills the panes with real terminals and long conversations to measure.
  const bench =
    (import.meta.env.DEV || import.meta.env.VITE_ADE_BENCH === '1') &&
    new URLSearchParams(window.location.search).has('bench')
      ? await loadBench()
      : undefined
  const router = createAppRouter({ Workspace: bench ? () => <Workspace renderContent={bench} /> : Workspace })
  const daemon = window.adeHost ? createDaemonStore(window.adeHost) : null
  if (daemon && window.adeHost) startProfileSettings(window.adeHost, daemon.store)
  // Menu commands that change the screen. Any other command acts on the workspace, so it first
  // returns there from a full-screen view.
  window.adeHost?.onCommand((command) => {
    if (command === 'command-palette') openCommandPalette()
    else if (command === 'open-settings') void router.navigate({ to: '/settings' })
    else if (command === 'open-onboarding') void router.navigate({ to: '/onboarding' })
    else {
      if (router.state.location.pathname !== '/') void router.navigate({ to: '/' })
      handleLayoutCommand(command)
    }
  })
  // Resolve the first screen before rendering, so the window never paints an empty frame.
  await router.load()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }) => <ErrorReport error={error} onRetry={resetErrorBoundary} />}
      >
        <DaemonStoreContext value={daemon?.store ?? null}>
          <QueryClientProvider client={queryClient}>
            <MotionProvider>
              <IconProvider>
                {/* Tooltips wait 600ms, then switch instantly while the pointer moves between controls. */}
                <TooltipProvider delay={600}>
                  <Toaster>
                    <RouterProvider router={router} />
                    <CommandPalette service={commandService} />
                    <ConfirmHost />
                    <NameHost />
                  </Toaster>
                </TooltipProvider>
              </IconProvider>
            </MotionProvider>
          </QueryClientProvider>
        </DaemonStoreContext>
      </ErrorBoundary>
    </StrictMode>,
  )
}
