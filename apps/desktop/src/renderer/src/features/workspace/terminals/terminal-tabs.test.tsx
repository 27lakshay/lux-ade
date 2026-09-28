import { benchTerminalBridge } from '@ade/terminal/bench'
import type { TerminalBridge } from '@ade/terminal'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { dispatch, layoutStore, openTabIn, setActiveWorkspace } from '../model/layout-store'
import { handleLayoutCommand } from '../model/layout-commands'
import { panes } from '../model/layout-tree'
import { renderWorkspace, resetLayout, setCatalog } from '../testing'
import type { TerminalCloseOutcome } from '../../../../../shared/bridge/terminals'
import { closePane, closeTab, newTerminal } from './terminal-tabs'

beforeEach(resetLayout)
afterEach(() => {
  window.adeHost = undefined as unknown as typeof window.adeHost
})

/** A host whose terminal commands are spies, and whose terminal stream is `bridge`. */
const hostSpy = (overrides: Partial<Window['adeHost']['terminals']> = {}, bridge?: TerminalBridge) => {
  const terminals = {
    create: vi.fn(async () => 't1'),
    close: vi.fn(async (): Promise<TerminalCloseOutcome> => ({ closed: true })),
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
    close: vi.fn().mockRejectedValueOnce(new Error('Daemon is unavailable')).mockResolvedValue({ closed: true }),
  })
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  const tabId = tabsOf('w1')[0]!.id
  await closeTab(tabId)
  expect(host.close).toHaveBeenCalledWith('t1')
  expect(tabsOf('w1')).toHaveLength(1)
  await expect.element(screen.getByText('Daemon is unavailable')).toBeVisible()
  await closeTab(tabId)
  expect(tabsOf('w1')).toHaveLength(0)
})

test('closing a busy terminal asks first, and forces only once confirmed', async () => {
  const close = vi.fn(async (_id: string, force?: boolean): Promise<TerminalCloseOutcome> =>
    force ? { closed: true } : { closed: false, running: 'sleep' },
  )
  hostSpy({ close })
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  const tabId = tabsOf('w1')[0]!.id

  const cancelled = closeTab(tabId)
  const dialog = screen.getByRole('alertdialog')
  await expect.element(dialog.getByText('Stop “sleep”?')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await cancelled
  expect(close).toHaveBeenCalledTimes(1)
  expect(tabsOf('w1')).toHaveLength(1)

  const confirmed = closeTab(tabId)
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Close terminal' }).click()
  await confirmed
  expect(close).toHaveBeenLastCalledWith('t1', true)
  expect(tabsOf('w1')).toHaveLength(0)
})

test('closing a pane stops its terminals; one that will not stop keeps its tab', async () => {
  const close = vi.fn(async (id: string): Promise<TerminalCloseOutcome> => {
    if (id === 't2') throw new Error('Still running')
    return { closed: true }
  })
  hostSpy({ close })
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'conversation', title: 'Chat' })
  openTabIn('w1', { kind: 'terminal', title: 'One', target: { kind: 'terminal', id: 't1' } })
  openTabIn('w1', { kind: 'terminal', title: 'Two', target: { kind: 'terminal', id: 't2' } })
  const pane = panes(layoutStore.getState().layouts.w1!.root)[0]!
  await closePane(pane.id)
  expect(close.mock.calls.map(([id]) => id).sort()).toEqual(['t1', 't2'])
  expect(tabsOf('w1').map((tab) => tab.title)).toEqual(['Two'])
})

test('a terminal tab draws the terminal it names, and takes the keyboard when shown', async () => {
  hostSpy()
  await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  await expect.poll(() => document.querySelector('[data-terminal="t1"] canvas')).toBeTruthy()
  const input = () => document.querySelector('[data-terminal="t1"] textarea')
  await expect.poll(() => document.activeElement === input()).toBe(true)
  // Another tab takes the pane, then the terminal is chosen again: it has the keyboard again.
  openTabIn('w1', { kind: 'conversation', title: 'Chat' })
  await expect.poll(() => document.activeElement === input()).toBe(false)
  const terminalTab = tabsOf('w1').find((tab) => tab.kind === 'terminal')!
  dispatch({ type: 'activateTab', tabId: terminalTab.id })
  await expect.poll(() => document.activeElement === input()).toBe(true)
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

test('New terminal is a menu command and a choice under the tab strip’s +', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  expect(handleLayoutCommand('new-terminal')).toBe(true)
  await expect.poll(() => tabsOf('w1').length).toBe(1)
  await screen.getByRole('button', { name: 'New tab' }).first().click()
  await screen.getByRole('menuitem', { name: /New terminal/ }).click()
  await expect.poll(() => tabsOf('w1').length).toBe(2)
  expect(host.create).toHaveBeenCalledTimes(2)
  expect(host.create).toHaveBeenCalledWith('w1')
})

test('a terminal tab is titled by its terminal: the shell, or the command running in it', async () => {
  hostSpy()
  const screen = await renderWorkspace()
  setActiveWorkspace('w1')
  openTabIn('w1', { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id: 't1' } })
  const terminal = {
    id: 't1',
    workspace_id: 'w1',
    kind: 'shell',
    status: 'running',
    exit_code: null,
    busy: false,
    foreground: null,
    primary: false,
    service_id: null,
    script_run_id: null,
    conversation_id: null,
  } as const
  setCatalog({ workspaces: [], conversations: [], terminals: [{ ...terminal, title: 'zsh' }] })
  await expect.element(screen.getByRole('tab', { name: /zsh/ })).toBeVisible()
  setCatalog({ workspaces: [], conversations: [], terminals: [{ ...terminal, title: 'sleep 60', busy: true }] })
  await expect.element(screen.getByRole('tab', { name: /sleep 60/ })).toBeVisible()
})
