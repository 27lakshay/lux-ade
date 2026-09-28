import { benchTerminalBridge } from '@ade/terminal/bench'
import type { TerminalBridge } from '@ade/terminal'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { layoutStore, openTabIn, setActiveWorkspace } from '../model/layout-store'
import { panes } from '../model/layout-tree'
import { renderWorkspace, resetLayout } from '../testing'
import { closePane, closeTab, newTerminal } from './terminal-tabs'

beforeEach(resetLayout)
afterEach(() => {
  window.adeHost = undefined as unknown as typeof window.adeHost
})

/** A host whose terminal commands are spies, and whose terminal stream is `bridge`. */
const hostSpy = (overrides: Partial<Window['adeHost']['terminals']> = {}, bridge?: TerminalBridge) => {
  const terminals = {
    create: vi.fn(async () => 't1'),
    close: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    ...overrides,
  }
  window.adeHost = {
    terminals,
    terminal: bridge ?? benchTerminalBridge({ scrollback: 20, linesPerSecond: 0 }),
    setWindowMinimumSize: vi.fn(),
    workspaces: { select: vi.fn(async () => true) },
  } as unknown as typeof window.adeHost
  return terminals
}
const tabsOf = (workspace: string) => Object.values(layoutStore.getState().layouts[workspace]?.tabs ?? {})

test('a new terminal starts in the daemon, then opens on its ID where it runs', async () => {
  let started: (id: string) => void = () => {}
  const host = hostSpy({ create: vi.fn(() => new Promise<string>((resolve) => (started = resolve))) })
  setActiveWorkspace('w1')
  const opening = newTerminal()
  // The window moves on before the daemon answers: the tab still joins w1.
  setActiveWorkspace('w2')
  started('t1')
  await opening
  expect(host.create).toHaveBeenCalledWith('w1')
  expect(tabsOf('w1')).toEqual([expect.objectContaining({ kind: 'terminal', target: { kind: 'terminal', id: 't1' } })])
  expect(tabsOf('w2')).toEqual([])
})

test('with no workspace yet, a new terminal says so and starts nothing', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  await newTerminal()
  expect(host.create).not.toHaveBeenCalled()
  await expect.element(screen.getByText('No workspace to start a terminal in')).toBeVisible()
})

test('closing a terminal tab stops the terminal first; a refusal keeps the tab', async () => {
  const host = hostSpy({
    close: vi.fn().mockRejectedValueOnce(new Error('Daemon is busy')).mockResolvedValue(undefined),
  })
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  const tabId = tabsOf('w1')[0]!.id
  await closeTab(tabId)
  expect(host.close).toHaveBeenCalledWith('w1', 't1')
  expect(tabsOf('w1')).toHaveLength(1)
  await expect.element(screen.getByText('Daemon is busy')).toBeVisible()
  await closeTab(tabId)
  expect(tabsOf('w1')).toHaveLength(0)
})

test('closing a pane stops its terminals; one that will not stop keeps its tab', async () => {
  const close = vi.fn(async (_workspace: string, id: string) => {
    if (id === 't2') throw new Error('Still running')
  })
  hostSpy({ close })
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'conversation', title: 'Chat' })
  openTabIn('w1', { kind: 'terminal', title: 'One', target: { kind: 'terminal', id: 't1' } })
  openTabIn('w1', { kind: 'terminal', title: 'Two', target: { kind: 'terminal', id: 't2' } })
  const pane = panes(layoutStore.getState().layouts.w1!.root)[0]!
  await closePane(pane.id)
  expect(close.mock.calls.map(([, id]) => id).sort()).toEqual(['t1', 't2'])
  expect(tabsOf('w1').map((tab) => tab.title)).toEqual(['Two'])
})

test('a terminal tab draws the terminal it names', async () => {
  hostSpy()
  await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  await expect.poll(() => document.querySelector('[data-terminal="t1"] canvas')).toBeTruthy()
})

test('a stream that will not attach is retried, then the terminal says why and offers a way on', async () => {
  const attach = vi.fn(async () => {
    throw new Error('The selected terminal is unavailable in this profile')
  })
  const host = hostSpy({}, { attach })
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  await expect
    .element(screen.getByText('The selected terminal is unavailable in this profile'), { timeout: 8000 })
    .toBeVisible()
  // The first attach and three retries.
  expect(attach).toHaveBeenCalledTimes(4)
  await screen.getByRole('button', { name: 'Restart shell' }).click()
  expect(host.restart).toHaveBeenCalledWith('w1', 't1')
  await expect.poll(() => attach.mock.calls.length).toBe(5)
}, 15_000)
