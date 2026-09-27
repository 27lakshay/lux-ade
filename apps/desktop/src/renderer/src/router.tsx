import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useMatchRoute,
  type RouterHistory,
} from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { OnboardingScreen } from './screens/OnboardingScreen'
import { SettingsScreen } from './screens/SettingsScreen'

// Full-screen views. The route picks the screen: `/` is the workspace, `/onboarding` and
// `/settings` replace it. Panes, tabs and open conversations are never in the URL; they are layout
// state. Hash history, because the packaged app loads index.html from ade://app and reloads (dev hot
// reload, safe-mode recovery) should land on the same screen.
//
// The workspace stays mounted under the other screens, hidden, so its terminals and streams keep
// running while settings are open.

export function createAppRouter({
  Workspace,
  history = createHashHistory(),
}: {
  Workspace: ComponentType
  history?: RouterHistory
}) {
  function Root() {
    const onWorkspace = Boolean(useMatchRoute()({ to: '/' }))
    return (
      <>
        <div hidden={!onWorkspace} data-testid="workspace">
          <Workspace />
        </div>
        <Outlet />
      </>
    )
  }
  const root = createRootRoute({ component: Root })
  const workspace = createRoute({ getParentRoute: () => root, path: '/', component: () => null })
  const onboarding = createRoute({ getParentRoute: () => root, path: 'onboarding', component: OnboardingScreen })
  const settings = createRoute({ getParentRoute: () => root, path: 'settings', component: SettingsScreen })
  return createRouter({ routeTree: root.addChildren([workspace, onboarding, settings]), history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
