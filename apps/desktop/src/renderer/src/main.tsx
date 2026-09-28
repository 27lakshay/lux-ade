import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './app.css'
import { createAppRouter } from './router'
import { Workspace } from './Workspace'

const router = createAppRouter({ Workspace })

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
