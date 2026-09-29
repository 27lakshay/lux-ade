import { useEffect, useState } from 'react'
import { beforeEach, expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { Tab } from '../model/layout'
import { dispatch, layoutNow, layoutStore, setKeepTerminals } from '../model/layout-store'
import { selectWorkspace } from '../model/layout-sync'
import { openTitled, renderWorkspace, resetLayout, titleOf, WORKSPACE } from '../testing'

beforeEach(resetLayout)

const lifecycle: string[] = []

// Stands in for a terminal or conversation: state that must survive the tab moving.
function Counter({ tab }: { tab: Tab }) {
  const [count, setCount] = useState(0)
  const [title] = useState(() => titleOf(tab.id))
  useEffect(() => {
    lifecycle.push(`mount ${title}`)
    return () => void lifecycle.push(`unmount ${title}`)
  }, [title])
  return (
    <div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {title} {count}
      </button>
      <input aria-label={`${title} input`} />
    </div>
  )
}
const render = (tab: Tab) => <Counter tab={tab} />

const tabId = (title: string): string => Object.values(layoutNow().tabs).find((tab) => titleOf(tab.id) === title)!.id

test('moving a tab to another pane keeps its content: the same element, the same state, the focus', async () => {
  const screen = await renderWorkspace(render)
  await openTitled('terminal', 'Shell')
  await openTitled('terminal', 'Logs')
  await screen.getByRole('tab', { name: /Shell/ }).click()
  const counter = screen.getByRole('button', { name: /^Shell/ })
  await counter.click()
  await expect.element(screen.getByRole('button', { name: 'Shell 1' })).toBeVisible()
  const element = document.querySelector(`[data-content-host="${tabId('Shell')}"]`)
  await screen.getByRole('textbox', { name: 'Shell input' }).click()
  await userEvent.keyboard('ls')

  await dispatch({
    type: 'drop_tab',
    tab_id: tabId('Shell'),
    pane_id: layoutNow().focused_pane,
    zone: 'right',
    new_pane_id: 'p2',
  })

  await expect.poll(() => document.querySelectorAll('section[aria-label="Pane"]').length).toBe(2)
  await expect.element(screen.getByRole('button', { name: 'Shell 1' })).toBeVisible()
  expect(document.querySelector(`[data-content-host="${tabId('Shell')}"]`)).toBe(element)
  expect(element?.closest('[data-pane-body]')?.getAttribute('data-pane-body')).toBe('p2')
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Shell input' }).element())
  expect((document.activeElement as HTMLInputElement).value).toBe('ls')
})

test('switching workspace and back keeps content mounted for recent workspaces', async () => {
  const screen = await renderWorkspace(render)
  await openTitled('conversation', 'Chat')
  await screen.getByRole('button', { name: 'Chat 0' }).click()
  selectWorkspace('other')
  await expect.element(screen.getByRole('button', { name: 'Chat 1' })).not.toBeInTheDocument()
  selectWorkspace(WORKSPACE)
  await expect.element(screen.getByRole('button', { name: 'Chat 1' })).toBeVisible()
})

test('terminals stay mounted only for the workspace on screen, unless more are kept', async () => {
  const screen = await renderWorkspace(render)
  await openTitled('terminal', 'Shell')
  await openTitled('conversation', 'Chat')
  await expect.element(screen.getByRole('button', { name: 'Chat 0' })).toBeVisible()
  lifecycle.length = 0
  selectWorkspace('other')
  // The terminal unmounts; the conversation, in a recent workspace, stays.
  await expect.poll(() => lifecycle).toContain('unmount Shell')
  expect(lifecycle).not.toContain('unmount Chat')
  lifecycle.length = 0
  selectWorkspace(WORKSPACE)
  await expect.poll(() => lifecycle).toContain('mount Shell')
  expect(lifecycle).not.toContain('mount Chat')
  // Keeping terminals for two workspaces keeps it across a switch.
  setKeepTerminals(2)
  lifecycle.length = 0
  selectWorkspace('other')
  selectWorkspace(WORKSPACE)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(lifecycle).not.toContain('unmount Shell')
})

test('content unmounts when its tab closes, or its workspace falls off the recent list', async () => {
  const screen = await renderWorkspace(render)
  await openTitled('terminal', 'Shell')
  await screen.getByRole('button', { name: 'Shell 0' }).click()
  layoutStore.setState({ keepMounted: 1 })
  selectWorkspace('other')
  // Only the current workspace is kept: the content unmounts.
  await expect.poll(() => lifecycle.at(-1)).toBe('unmount Shell')
  selectWorkspace(WORKSPACE)
  // It mounts again, fresh.
  await expect.element(screen.getByRole('button', { name: 'Shell 0' })).toBeVisible()
  await dispatch({ type: 'close_tab', tab_id: tabId('Shell') })
  await expect.poll(() => document.querySelector('[data-content-host]')).toBeNull()
})
