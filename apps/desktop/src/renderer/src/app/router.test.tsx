import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { createAppRouter } from './router'
import './app.css'
import { createDaemonStore } from '../state/daemon-store'
import { createFakeHost } from '../state/fake-host'
import { DaemonStoreContext } from '../state/hooks'

// A stand-in workspace with state, to show it stays mounted under full-screen views.
function Workspace() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Workspace {count}
    </button>
  )
}

test('the workspace fills the window height', async () => {
  // Reported: a band of empty window below the workspace. The shell sizes itself with h-full, so
  // every wrapper between the window and the shell must pass the full height down.
  const Shell = () => <div className="h-full" data-testid="shell" />
  const router = createAppRouter({ Workspace: Shell, history: createMemoryHistory({ initialEntries: ['/'] }) })
  const screen = await render(
    <div style={{ height: 600 }}>
      <RouterProvider router={router} />
    </div>,
  )
  const shell = screen.getByTestId('shell').element()
  expect(shell.getBoundingClientRect().height).toBe(600)
})

test('full-screen views cover the workspace without unmounting it', async () => {
  const router = createAppRouter({ Workspace, history: createMemoryHistory({ initialEntries: ['/'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(['profile-settings'], {
    appearance: 'system',
    reduced_motion: 'system',
    appearance_revision: 0,
    ui_font_family: 'Inter Variable',
    ui_font_size: 13,
    code_font_family: 'JetBrains Mono Variable',
    code_font_size: 12,
    terminal_font_family: 'JetBrains Mono Variable',
    terminal_font_size: 12,
    density: 'default',
    terminal_line_height: 1.35,
    terminal_font_kerning: 'auto',
    terminal_cursor_shape: 'block',
    terminal_cursor_blink: true,
    terminal_binding: { kind: 'follow_app' },
    syntax_binding: { kind: 'follow_app' },
    terminal_color_overrides: {},
    terminal_minimum_contrast: 1,
    terminal_bold_color: 'inherit',
  })
  const { store, stop } = createDaemonStore(createFakeHost().host)
  const screen = await render(
    <DaemonStoreContext value={store}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </DaemonStoreContext>,
  )
  await screen.getByRole('button', { name: 'Workspace 0' }).click()
  await expect.element(screen.getByRole('button', { name: 'Workspace 1' })).toBeVisible()

  await router.navigate({ to: '/settings' })
  await expect.element(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect.element(screen.getByTestId('workspace')).not.toBeVisible()

  await screen.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.element(screen.getByRole('button', { name: 'Workspace 1' })).toBeVisible()

  await router.navigate({ to: '/onboarding' })
  await expect.element(screen.getByRole('heading', { name: 'Welcome to ADE' })).toBeVisible()
  stop()
})
