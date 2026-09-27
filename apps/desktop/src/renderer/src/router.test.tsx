import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { createAppRouter } from './router'

// A stand-in workspace with state, to show it stays mounted under full-screen views.
function Workspace() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Workspace {count}
    </button>
  )
}

test('full-screen views cover the workspace without unmounting it', async () => {
  const router = createAppRouter({ Workspace, history: createMemoryHistory({ initialEntries: ['/'] }) })
  const screen = await render(<RouterProvider router={router} />)
  await screen.getByRole('button', { name: 'Workspace 0' }).click()
  await expect.element(screen.getByRole('button', { name: 'Workspace 1' })).toBeVisible()

  await router.navigate({ to: '/settings' })
  await expect.element(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect.element(screen.getByTestId('workspace')).not.toBeVisible()

  await screen.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.element(screen.getByRole('button', { name: 'Workspace 1' })).toBeVisible()

  await router.navigate({ to: '/onboarding' })
  await expect.element(screen.getByRole('heading', { name: 'Welcome to ADE' })).toBeVisible()
})
