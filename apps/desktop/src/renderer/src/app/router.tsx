import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useMatchRoute,
  useRouter,
  type ErrorComponentProps,
  type RouterHistory,
} from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { ErrorReport } from '../provisional/ErrorReport'
import { NotFound } from '../provisional/NotFound'
import { OnboardingScreen } from '../provisional/OnboardingScreen'
import { SettingsScreen } from '../provisional/SettingsScreen'

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
        {/* Full height, so the workspace inside (sized with h-full) fills the window. */}
        <div hidden={!onWorkspace} data-testid="workspace" className="h-full">
          <Workspace />
        </div>
        <Outlet />
      </>
    )
  }
  const root = createRootRoute({ component: Root, errorComponent: RouteError, notFoundComponent: NotFound })
  const workspace = createRoute({ getParentRoute: () => root, path: '/', component: () => null })
  const onboarding = createRoute({ getParentRoute: () => root, path: 'onboarding', component: OnboardingScreen })
  const settings = createRoute({ getParentRoute: () => root, path: 'settings', component: SettingsScreen })
  return createRouter({ routeTree: root.addChildren([workspace, onboarding, settings]), history })
}

// A screen that throws while rendering or loading. Retrying reloads its data and renders it again.
function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div className="fixed inset-0 bg-background">
      <ErrorReport
        error={error}
        onRetry={() => {
          reset()
          void router.invalidate()
        }}
      />
    </div>
  )
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
