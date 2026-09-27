import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles.css'
import { App } from './App'
import { createAppRouter } from './router'
import { applyTokens, DEFAULT_GLASS, DEFAULT_THEME, REDUCED_TRANSPARENCY, type Theme } from './tokens'
import { readPersisted } from './persist'

// Set the colour variables before the first paint, from the saved dev-panel settings, so a saved
// light theme or glass setting never flashes the defaults. App keeps them current afterwards.
applyTokens(readPersisted<Theme>('theme', DEFAULT_THEME), {
  on: readPersisted<boolean | null>('glass', null) ?? !matchMedia(REDUCED_TRANSPARENCY).matches,
  ...readPersisted('glassTuning', DEFAULT_GLASS),
})

const router = createAppRouter({ Workspace: App })

// Menu commands that change the screen. Any other command acts on the workspace, so it first
// returns there from a full-screen view.
window.adeHost?.onCommand((command) => {
  if (command === 'open-settings') void router.navigate({ to: '/settings' })
  else if (command === 'open-onboarding') void router.navigate({ to: '/onboarding' })
  else if (router.state.location.pathname !== '/') void router.navigate({ to: '/' })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
