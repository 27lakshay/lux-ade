import { benchTerminalBridge } from '@ade/terminal/bench'
import type { TerminalBridge } from '@ade/terminal'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { queryClient } from '../../../app/query-client'
import { dispatch, layoutNow, layoutStore, openTab } from '../model/layout-store'
import { handleLayoutCommand } from '../model/layout-commands'
import { panes } from '../model/layout-tree'
import {
  daemonLayouts,
  renderWorkspace,
  resetLayout,
  setCatalog,
  settle,
  terminalRecord,
  titleOf,
  WORKSPACE,
} from '../testing'
import { closePane, closeTab, newTerminal } from './terminal-tabs'
const { mountTerminalMock } = vi.hoisted(() => ({ mountTerminalMock: vi.fn() }))
vi.mock('@ade/terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ade/terminal')>()
  return {
    ...actual,
    mountTerminal: (...args: Parameters<typeof actual.mountTerminal>) => {
      return mountTerminalMock.getMockImplementation() ? mountTerminalMock(...args) : actual.mountTerminal(...args)
    },
  }
})

beforeEach(resetLayout)
afterEach(() => {
  window.adeHost = undefined as unknown as typeof window.adeHost
})

/**
 * A host whose terminal commands are spies and whose stream is `bridge`. Creating a terminal opens
 * its tab in the fake daemon's layout, as `terminal.create` with `place` does.
 */
const hostSpy = (overrides: Partial<Window['adeHost']['terminals']> = {}, bridge?: TerminalBridge) => {
  let created = 0
  const terminals = {
    create: vi.fn(async (_workspaceId: string, paneId?: string) => {
      const id = `t${++created}`
      daemonLayouts().shells.set(id, { foreground: null })
      daemonLayouts().placeTerminal(id, paneId)
      return id
    }),
    restart: vi.fn(async () => {}),
    ...overrides,
  }
  window.adeHost = {
    terminals,
    terminal: bridge ?? benchTerminalBridge({ scrollback: 20, linesPerSecond: 0 }),
    setWindowMinimumSize: vi.fn(),
  } as unknown as typeof window.adeHost
  return terminals
}
const tabs = () => Object.values(layoutNow().tabs)
/** A shell the fake daemon knows, with its tab open. */
async function shellTab(id: string, foreground: string | null = null): Promise<string> {
  daemonLayouts().shells.set(id, { foreground })
  await openTab({ kind: 'terminal', id })
  return `tab-${id}`
}

test('a new terminal is one daemon command that starts the shell and places its tab', async () => {
  const host = hostSpy()
  await newTerminal('p1')
  await settle()
  expect(host.create).toHaveBeenCalledWith(WORKSPACE, 'p1')
  expect(tabs()).toEqual([{ id: 'tab-t1', target: { kind: 'terminal', id: 't1' } }])
  expect(daemonLayouts().calls).not.toContain('layout.apply')
})

test('with no workspace yet, a new terminal says so and starts nothing', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  // The daemon has not named the window's workspace yet.
  layoutStore.setState({ window: null })
  await newTerminal()
  expect(host.create).not.toHaveBeenCalled()
  await expect.element(screen.getByText('No workspace to start a terminal in')).toBeVisible()
})

test('closing a shell tab is tab.close: the daemon stops the shell, and a failure keeps the tab', async () => {
  hostSpy()
  const screen = await renderWorkspace()
  const tabId = await shellTab('t1')
  const bridge = daemonLayouts().connection.bridge
  const real = bridge.closeTab.bind(bridge)
  bridge.closeTab = vi.fn().mockRejectedValueOnce(new Error('Daemon is unavailable')).mockImplementation(real)
  await closeTab(tabId)
  expect(tabs()).toHaveLength(1)
  await expect.element(screen.getByText('Daemon is unavailable')).toBeVisible()
  await closeTab(tabId)
  expect(tabs()).toHaveLength(0)
  expect(daemonLayouts().shells.has('t1')).toBe(false)
})

test('closing a busy terminal asks first, naming the command, and forces only once confirmed', async () => {
  hostSpy()
  const screen = await renderWorkspace()
  const tabId = await shellTab('t1', 'sleep')
  const cancelled = closeTab(tabId)
  const dialog = screen.getByRole('alertdialog')
  await expect.element(dialog.getByText('Stop “sleep”?')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await cancelled
  expect(tabs()).toHaveLength(1)
  expect(daemonLayouts().shells.has('t1')).toBe(true)

  const confirmed = closeTab(tabId)
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Close terminal' }).click()
  await confirmed
  expect(tabs()).toHaveLength(0)
  // Asked, cancelled; asked again, then forced.
  expect(daemonLayouts().calls.filter((call) => call === 'tab.close')).toHaveLength(3)
})

test('closing a pane is pane.close: its tabs go, a busy shell asks first', async () => {
  hostSpy()
  const screen = await renderWorkspace()
  await openTab({ kind: 'new_conversation' })
  await shellTab('t1')
  await shellTab('t2', 'npm test')
  const pane = panes(layoutNow().root)[0]!
  const closing = closePane(pane.id)
  await expect.element(screen.getByRole('alertdialog').getByText('Stop “npm test”?')).toBeVisible()
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Close pane' }).click()
  await closing
  expect(tabs()).toEqual([])
  expect([...daemonLayouts().shells.keys()]).toEqual([])
})

test('a terminal tab draws the terminal it names, and takes the keyboard when shown', async () => {
  hostSpy()
  await renderWorkspace()
  await shellTab('t1')
  await expect.poll(() => document.querySelector('[data-terminal="t1"] canvas')).toBeTruthy()
  const input = () => document.querySelector('[data-terminal="t1"] textarea')
  await expect.poll(() => document.activeElement === input()).toBe(true)
  // Another tab takes the pane, then the terminal is chosen again: it has the keyboard again.
  await openTab({ kind: 'new_conversation' })
  await expect.poll(() => document.activeElement === input()).toBe(false)
  await dispatch({ type: 'activate_tab', tab_id: 'tab-t1' })
  await expect.poll(() => document.activeElement === input()).toBe(true)
})

test('a stream that will not attach is retried, then the terminal says why and offers a way on', async () => {
  const attach = vi.fn(async () => {
    throw new Error('The selected terminal is unavailable in this profile')
  })
  const host = hostSpy({}, { attach })
  const screen = await renderWorkspace()
  await shellTab('t1')
  await expect
    .element(screen.getByText('The selected terminal is unavailable in this profile'), { timeout: 8000 })
    .toBeVisible()
  // The first attach and three retries.
  expect(attach).toHaveBeenCalledTimes(4)
  await screen.getByRole('button', { name: 'Restart shell' }).click()
  expect(host.restart).toHaveBeenCalledWith(WORKSPACE, 't1')
  await expect.poll(() => attach.mock.calls.length).toBe(5)
}, 15_000)

test('New terminal is a menu command and a choice under the tab strip’s +', async () => {
  const host = hostSpy()
  const screen = await renderWorkspace()
  expect(handleLayoutCommand('new-terminal')).toBe(true)
  await expect.poll(() => tabs().length).toBe(1)
  await screen.getByRole('button', { name: 'New tab' }).first().click()
  await screen.getByRole('menuitem', { name: /New terminal/ }).click()
  await expect.poll(() => tabs().length).toBe(2)
  expect(host.create).toHaveBeenCalledTimes(2)
  expect(host.create).toHaveBeenLastCalledWith(WORKSPACE, 'p1')
})

test('a terminal tab is titled by its terminal: the shell, or the command running in it', async () => {
  hostSpy()
  const screen = await renderWorkspace()
  await shellTab('t1')
  setCatalog({ workspaces: [], conversations: [], terminals: [terminalRecord('t1', 'zsh')] })
  await expect.element(screen.getByRole('tab', { name: /zsh/ })).toBeVisible()
  expect(titleOf('tab-t1')).toBe('zsh')
  setCatalog({ workspaces: [], conversations: [], terminals: [terminalRecord('t1', 'sleep 60', { busy: true })] })
  await expect.element(screen.getByRole('tab', { name: /sleep 60/ })).toBeVisible()
})

test('a hidden terminal frees its canvas, and draws again when shown', async () => {
  hostSpy()
  await renderWorkspace()
  await shellTab('t1')
  await expect.poll(() => document.querySelector('[data-terminal="t1"] canvas')).toBeTruthy()
  // Held directly: a hidden tab's element is out of the page.
  const canvas = document.querySelector<HTMLCanvasElement>('[data-terminal="t1"] canvas')!
  await expect.poll(() => canvas.width).toBeGreaterThan(0)
  await openTab({ kind: 'new_conversation' })
  await expect.poll(() => canvas.isConnected).toBe(false)
  await expect.poll(() => canvas.width).toBe(0)
  await dispatch({ type: 'activate_tab', tab_id: 'tab-t1' })
  await expect.poll(() => canvas.width).toBeGreaterThan(0)
})

test('a terminal receives profile preferences at mount and updates them without remounting', async () => {
  const terminalSettings = {
    appearance: 'system',
    reduced_motion: 'system',
    appearance_revision: 0,
    terminal_font_family: 'JetBrains Mono Variable',
    terminal_font_size: 12,
    terminal_line_height: 1.35,
    terminal_font_kerning: 'auto',
    terminal_cursor_shape: 'block',
    terminal_cursor_blink: true,
  } as unknown as import('@ade/contracts').ProfileSettings
  queryClient.setQueryData(['profile-settings'], terminalSettings)
  const setPreferences = vi.fn(async () => {})
  const mount = mountTerminalMock.mockImplementation(
    () =>
      ({
        setVisible: vi.fn(),
        setFont: vi.fn(async () => {}),
        setPreferences,
        focus: vi.fn(),
        dispose: vi.fn(),
      }) as unknown as import('@ade/terminal').TerminalView,
  )
  hostSpy()
  try {
    await renderWorkspace()
    await shellTab('preferences-terminal')
    await expect.poll(() => mount.mock.calls.length).toBeGreaterThan(0)
    const mountCount = mount.mock.calls.length
    expect(mount.mock.calls[0]![4].preferences).toEqual({
      family: 'JetBrains Mono Variable',
      size: 12,
      lineHeight: 1.35,
      kerning: 'auto',
      cursorShape: 'block',
      cursorBlink: true,
      reducedMotion: undefined,
    })
    queryClient.setQueryData(['profile-settings'], {
      ...terminalSettings,
      terminal_font_family: 'A Different Font',
      terminal_font_size: 14,
      terminal_line_height: 1.5,
      terminal_font_kerning: 'none',
      terminal_cursor_shape: 'underline',
      terminal_cursor_blink: false,
      reduced_motion: 'off',
    })
    await expect.poll(() => setPreferences.mock.calls.length).toBeGreaterThan(0)
    expect(setPreferences).toHaveBeenLastCalledWith({
      family: 'A Different Font',
      size: 14,
      lineHeight: 1.5,
      kerning: 'none',
      cursorShape: 'underline',
      cursorBlink: false,
      reducedMotion: false,
    })
    queryClient.setQueryData(['profile-settings'], { ...terminalSettings, reduced_motion: 'on' })
    await expect.poll(() => setPreferences.mock.calls.length).toBeGreaterThan(1)
    expect(setPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: true }))
    expect(mount).toHaveBeenCalledTimes(mountCount)
  } finally {
    mount.mockReset()
    queryClient.removeQueries({ queryKey: ['profile-settings'] })
  }
})
