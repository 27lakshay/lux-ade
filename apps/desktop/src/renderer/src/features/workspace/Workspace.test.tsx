import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { beforeEach, expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createAppRouter } from '../../app/router'
import { MotionProvider } from '../../app/MotionProvider'
import '../../app/app.css'
import { defaultLayout } from './model/layout'
import { DEFAULT_WORKSPACE, dispatch, layoutStore } from './model/layout-store'
import { Workspace } from './Workspace'

beforeEach(() => {
  localStorage.removeItem('ade.layouts')
  layoutStore.setState({ active: DEFAULT_WORKSPACE, layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') } })
  document.documentElement.style.setProperty('--titlebar-height', '40px')
  document.documentElement.style.setProperty('--traffic-lights-inset', '80px')
})

async function renderWorkspace() {
  const router = createAppRouter({ Workspace, history: createMemoryHistory({ initialEntries: ['/'] }) })
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

const centre = (element: Element | null | undefined): number => {
  const rect = element!.getBoundingClientRect()
  return Math.round(rect.top + rect.height / 2)
}
const section = (label: string) => document.querySelector(`section[aria-label="${label}"]`)

test('rows line up across the rail and every card, as in the design', async () => {
  await renderWorkspace()
  const rail = [...document.querySelectorAll('nav[aria-label="Sections"] button')]
  const top = [
    centre(rail[0]),
    centre(section('Navigator')?.querySelector('button')),
    centre(section('Pane')?.querySelector('[role="tablist"]')?.parentElement),
    centre(section('Inspector')?.querySelector('[role="tablist"]')?.parentElement),
  ]
  // The title bar is 40px; every first row is centred 28px below it (8px gutter + 20).
  expect(top).toEqual([68, 68, 68, 68])
  expect(centre(rail.at(-1))).toBe(centre(document.querySelector('button[aria-label="Add project"]')))
  const grips = [...document.querySelectorAll('[aria-label^="Move"]')].map(centre)
  expect(new Set(grips).size).toBe(1)
})

test('the title-bar toggles collapse and restore the sidebar on that side', async () => {
  const screen = await renderWorkspace()
  const paneWidth = () => section('Pane')!.getBoundingClientRect().width
  const before = paneWidth()
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(() => section('Navigator')!.getBoundingClientRect().width).toBe(0)
  expect(paneWidth()).toBeGreaterThan(before)
  await screen.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect.poll(paneWidth).toBe(before)
})

test('tabs open in the pane, and the pane splits and closes', async () => {
  const screen = await renderWorkspace()
  await screen.getByRole('button', { name: 'New tab' }).click()
  await expect.element(screen.getByRole('tab', { name: /New conversation/ })).toBeVisible()
  await screen.getByRole('button', { name: 'Split right' }).click()
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  // The new, focused pane is empty.
  await expect.element(screen.getByText('Nothing open in this pane')).toBeVisible()
  await screen.getByRole('button', { name: 'Close pane' }).nth(1).click()
  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(1)
})

test('swapping sidebars moves each to the other side', async () => {
  await renderWorkspace()
  const left = (label: string) => section(label)!.getBoundingClientRect().left
  expect(left('Navigator')).toBeLessThan(left('Inspector'))
  dispatch({ type: 'swapSidebars' })
  await expect.poll(() => left('Navigator') > left('Inspector')).toBe(true)
})
