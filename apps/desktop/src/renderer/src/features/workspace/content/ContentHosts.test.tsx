import { useEffect, useState } from 'react'
import { beforeEach, expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render as renderReact } from 'vitest-browser-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Tab } from '../model/layout'
import { dispatch, layoutNow, layoutStore, setKeepTerminals } from '../model/layout-store'
import { selectWorkspace } from '../model/layout-sync'
import { openTitled, renderWorkspace, resetLayout, titleOf, WORKSPACE } from '../testing'
import { attachHost, hostFor, releaseHost } from './hosts'

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
test('restores native scroll before the next frame and ignores a replaced viewport', async () => {
  const id = 'content-host-scroll-regression'
  const body = document.createElement('div')
  document.body.append(body)
  const host = hostFor(id)
  let detach = attachHost(body, id)
  const renderHistory = (key: string) => (
    <ScrollArea key={key} style={{ height: 80, width: 96 }}>
      <div style={{ height: 640, width: 240 }}>retained history</div>
    </ScrollArea>
  )
  let view: Awaited<ReturnType<typeof renderReact>> | undefined

  try {
    view = await renderReact(renderHistory('original'), { container: host })
    const first = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    expect(first).not.toBeNull()
    if (!first) throw new Error('ScrollArea viewport was not rendered')
    expect(first.clientHeight).toBeGreaterThan(0)
    first.scrollTop = 240
    expect(first.scrollTop).toBe(240)

    detach()
    detach = attachHost(body, id)
    expect(first.scrollTop).toBe(240)
    // Detach again in the same task, before a browser frame can restore anything.
    detach()
    await view.rerender(renderHistory('replacement'))
    const replacement = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    expect(replacement).not.toBeNull()
    if (!replacement) throw new Error('Replacement ScrollArea viewport was not rendered')
    expect(replacement).not.toBe(first)

    detach = attachHost(body, id)
    expect(replacement.scrollTop).toBe(0)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(replacement.scrollTop).toBe(0)
  } finally {
    detach()
    await view?.unmount()
    releaseHost(id)
    body.remove()
  }
})
