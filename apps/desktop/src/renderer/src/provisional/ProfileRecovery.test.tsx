import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ProfileState } from '../../../shared/bridge/types'
import { createAppRouter } from '../app/router'
import { createProfileStore } from '../state/profile-store'
import '../app/app.css'

const state = (error: string): ProfileState => ({
  managed: true,
  profiles: [],
  selectedId: null,
  activeId: null,
  error,
})

test('a launcher failure already present when the renderer starts shows recovery guidance', async () => {
  const profile = createProfileStore({
    getState: async () => state('Existing daemon cannot hand off this runtime'),
    onState: () => () => undefined,
  })
  try {
    const router = createAppRouter({
      Workspace: () => <button type="button">Workspace action</button>,
      profile: profile.store,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()
    const screen = await render(<RouterProvider router={router} />)
    await expect.element(screen.getByRole('alert')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Workspace action', includeHidden: true }))
      .not.toBeVisible()
    await expect
      .element(screen.getByText('Existing daemon cannot hand off this runtime', { exact: true }))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(
          'Resolve this error before reopening the profile. Keep any existing daemon running and use a compatible ADE version.',
          { exact: true },
        ),
      )
      .toBeVisible()
  } finally {
    profile.stop()
  }
})

test('a delayed initial read cannot erase a pushed failure and successful recovery clears the screen', async () => {
  let initial!: (value: ProfileState) => void
  let push!: (value: ProfileState) => void
  const profile = createProfileStore({
    getState: () =>
      new Promise((resolve) => {
        initial = resolve
      }),
    onState: (listener) => {
      push = listener
      return () => undefined
    },
  })
  try {
    const router = createAppRouter({
      Workspace: () => <button type="button">Workspace action</button>,
      profile: profile.store,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()
    const screen = await render(<RouterProvider router={router} />)
    push(state('Existing daemon cannot hand off this runtime'))
    initial(state(''))
    await expect.element(screen.getByRole('alert')).toBeVisible()
    await expect
      .element(screen.getByText('Existing daemon cannot hand off this runtime', { exact: true }))
      .toBeVisible()
    push(state(''))
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: 'Workspace action' })).toBeVisible()
  } finally {
    profile.stop()
  }
})
