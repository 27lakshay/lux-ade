import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from 'vitest-browser-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createAppRouter } from '../../app/router'
import { MotionProvider } from '../../app/MotionProvider'
import '../../app/app.css'
import type { RenderContent } from './content/ContentHosts'
import { defaultLayout } from './model/layout'
import { DEFAULT_WORKSPACE, layoutStore } from './model/layout-store'
import { Workspace } from './Workspace'

// Renders the workspace at window size with the app's providers, for browser tests.

export function resetLayout(): void {
  localStorage.removeItem('ade.layouts')
  layoutStore.setState({
    active: DEFAULT_WORKSPACE,
    layouts: { [DEFAULT_WORKSPACE]: defaultLayout('p1') },
    recent: [DEFAULT_WORKSPACE],
    keepMounted: 3,
  })
  document.documentElement.style.setProperty('--titlebar-height', '40px')
  document.documentElement.style.setProperty('--traffic-lights-inset', '80px')
}

export function renderWorkspace(renderContent?: RenderContent) {
  const Screen = () => <Workspace renderContent={renderContent} />
  const router = createAppRouter({ Workspace: Screen, history: createMemoryHistory({ initialEntries: ['/'] }) })
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
