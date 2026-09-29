import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { render } from 'vitest-browser-react'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ClientState, Terminal } from '@ade/client'
import { createAppRouter } from '../../app/router'
import { createDaemonStore } from '../../state/daemon-store'
import { clientState, createFakeHost, fullCatalog, nextFrame, type CatalogFixture } from '../../state/fake-host'
import { DaemonStoreContext } from '../../state/hooks'
import { MotionProvider } from '../../app/MotionProvider'
import { ConfirmHost } from '../../provisional/ConfirmDialog'
import { NameHost } from '../../provisional/NameDialog'
import '../../app/app.css'
import { createFakeLayouts, type FakeLayouts } from '../../dev/layout-double/fake-layouts'
import type { RenderContent } from './content/ContentHosts'
import { tabContent } from './content/tab-content'
import { defaultLayout, type Layout } from './model/layout'
import { layoutNow, layoutStore, openTab } from './model/layout-store'
import { startLayoutSync } from './model/layout-sync'
import { Workspace } from './Workspace'

// Renders the workspace at window size with the app's providers, for browser tests. StrictMode, as
// in the app: it runs effects twice, which is where startup bugs hide. The window's layouts come
// from a fake daemon (dev/layout-double), which applies actions as the daemon does.

/** The workspace the fake daemon's window shows first. */
export const WORKSPACE = 'ws-1'

let layouts: FakeLayouts
let stopSync: (() => void) | null = null

/** Lets the fake daemon's replies and frames arrive. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A fresh window on a fake daemon: `WORKSPACE` shown, with one empty pane `p1`. */
export const resetLayout = (): Promise<void> => startWith({})

/** A fresh window on a fake daemon whose window has these layouts too, by workspace. */
export async function startWith(saved: Record<string, Layout>): Promise<void> {
  stopSync?.()
  layoutStore.setState({
    windowId: 'window-test',
    window: null,
    records: {},
    pending: null,
    keepMounted: 3,
    keepTerminals: 1,
  })
  layouts = createFakeLayouts({
    workspaceId: WORKSPACE,
    windowId: 'window-test',
    layouts: { [WORKSPACE]: defaultLayout('p1'), ...saved },
  })
  stopSync = startLayoutSync(layouts.connection)
  document.documentElement.style.setProperty('--titlebar-height', '40px')
  document.documentElement.style.setProperty('--traffic-lights-inset', '80px')
  await settle()
}

/** The fake daemon behind the window. */
export const daemonLayouts = (): FakeLayouts => layouts

/** The layout on screen, once what was sent has arrived. */
export async function shown(): Promise<Layout> {
  await settle()
  return layoutNow()
}

/**
 * The daemon the rendered workspace sees: push catalogs with `setCatalog`. Replaced per render; the
 * window's host (`window.adeHost`) is left to each test.
 */
let daemon = createFakeHost()

type Catalog = NonNullable<ClientState['catalog']>
let catalog: Catalog = fullCatalog({ workspaces: [], conversations: [] })
let sequence = 0

/** Shows these workspaces and conversations in the navigator, as a connected daemon's catalog. */
export function setCatalog(next: CatalogFixture): void {
  catalog = fullCatalog(next)
  daemon.pushClientState(clientState({ sequence: ++sequence, catalog }))
}

/** A terminal record as the catalog lists it. */
export const terminalRecord = (id: string, title: string, fields: Partial<Terminal> = {}): Terminal => ({
  id,
  workspace_id: WORKSPACE,
  kind: 'shell',
  title,
  status: 'running',
  exit_code: null,
  busy: false,
  foreground: null,
  primary: false,
  service_id: null,
  script_run_id: null,
  ...fields,
})

/**
 * Opens a tab on a new conversation or terminal record titled `title` (added to the catalog), in
 * `paneId` or the focused pane. Returns the tab's ID.
 */
export async function openTitled(kind: 'conversation' | 'terminal', title: string, paneId?: string): Promise<string> {
  const id = `${kind}-${++sequence}`
  if (kind === 'terminal') catalog = { ...catalog, terminals: [...catalog.terminals, terminalRecord(id, title)] }
  else
    catalog = {
      ...catalog,
      conversations: [
        ...catalog.conversations,
        { id, workspace_id: WORKSPACE, title, provider: 'fake', status: 'idle' },
      ],
    }
  daemon.pushClientState(clientState({ sequence, catalog }))
  // The catalog reaches the store on the next frame; the tab is titled from it.
  await nextFrame()
  await openTab({ kind, id }, paneId)
  await settle()
  return `tab-${id}`
}

/** A tab's title, as the tab strip shows it: its record's title in the catalog. */
export function titleOf(tabId: string | null | undefined): string | null {
  const target = tabId ? layoutNow().tabs[tabId]?.target : undefined
  if (!target) return null
  if (target.kind === 'terminal') return catalog.terminals?.find((item) => item.id === target.id)?.title ?? null
  if (target.kind === 'conversation') return catalog.conversations.find((item) => item.id === target.id)?.title ?? null
  return target.kind
}

/** Tabs draw their real content only where the test gave the window a terminal stream. */
const testContent: RenderContent = (tab, workspaceId) =>
  window.adeHost?.terminal ? tabContent(tab, workspaceId) : null

export function renderWorkspace(renderContent: RenderContent = testContent) {
  daemon = createFakeHost()
  catalog = fullCatalog({ workspaces: [], conversations: [] })
  const { store } = createDaemonStore(daemon.host)
  const Screen = () => <Workspace renderContent={renderContent} />
  const router = createAppRouter({ Workspace: Screen, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(
    <StrictMode>
      <DaemonStoreContext value={store}>
        <div data-window-frame style={{ width: 1440, height: 900 }}>
          <QueryClientProvider client={new QueryClient()}>
            <MotionProvider>
              <TooltipProvider delay={0}>
                <Toaster>
                  <RouterProvider router={router} />
                  <ConfirmHost />
                  <NameHost />
                </Toaster>
              </TooltipProvider>
            </MotionProvider>
          </QueryClientProvider>
        </div>
      </DaemonStoreContext>
    </StrictMode>,
  )
}

export const section = (label: string): Element | null => document.querySelector(`section[aria-label="${label}"]`)

const frame = (): Promise<unknown> => new Promise(requestAnimationFrame)

/**
 * Drags `source` onto `target` at a point inside it (default: its centre) by dispatching the native
 * drag events, as pragmatic-drag-and-drop's own tests do. Playwright's drag delivers the drop to
 * the library's "honey pot" element, so it cannot be used here.
 */
type Point = { clientX: number; clientY: number }
const centreOf = (element: Element, point?: { x: number; y: number }): Point => {
  const rect = element.getBoundingClientRect()
  return { clientX: rect.left + (point?.x ?? rect.width / 2), clientY: rect.top + (point?.y ?? rect.height / 2) }
}

/**
 * Starts a native drag from `source` (at its centre, as a real press on a grip would), for steps
 * that must look at the page mid-drag: hover over targets, then drop or cancel.
 */
export async function startDrag(source: Element) {
  const dataTransfer = new DataTransfer()
  const fire = (element: Element, type: string, position: Point): void => {
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...position }))
  }
  // The browser fires dragstart on the draggable element itself, even when a child was pressed (a
  // drag handle); the pointer position says where the drag began.
  const draggableElement = source.closest('[draggable="true"]') ?? source
  fire(draggableElement, 'dragstart', centreOf(source))
  await frame()
  let last: { target: Element; at: Point } | undefined
  // After a drop the library leaves a 2px shield where the drag began, until the pointer next
  // moves, as a user's always does. Move it, or the next click in the test lands on the shield.
  const moveOn = (at: Point): boolean => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, ...at }))
  return {
    async over(target: Element, point?: { x: number; y: number }): Promise<void> {
      const at = centreOf(target, point)
      if (last && last.target !== target) fire(last.target, 'dragleave', at)
      fire(target, 'dragenter', at)
      fire(target, 'dragover', at)
      await frame()
      fire(target, 'dragover', at)
      last = { target, at }
    },
    async drop(): Promise<void> {
      if (last) fire(last.target, 'drop', last.at)
      fire(draggableElement, 'dragend', last?.at ?? { clientX: 0, clientY: 0 })
      moveOn(last?.at ?? { clientX: 0, clientY: 0 })
      await frame()
    },
    /** Esc, or releasing outside the window: no drop event, only dragend. */
    async cancel(): Promise<void> {
      if (last) fire(last.target, 'dragleave', last.at)
      fire(draggableElement, 'dragend', { clientX: 0, clientY: 0 })
      moveOn({ clientX: 0, clientY: 0 })
      await frame()
    },
  }
}

export async function dragTo(source: Element, target: Element, point?: { x: number; y: number }): Promise<void> {
  const drag = await startDrag(source)
  await drag.over(target, point)
  await drag.drop()
}
