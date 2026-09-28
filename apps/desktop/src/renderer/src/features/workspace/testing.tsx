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
export async function dragTo(source: Element, target: Element, point?: { x: number; y: number }): Promise<void> {
  const from = source.getBoundingClientRect()
  const to = target.getBoundingClientRect()
  const at = { clientX: to.left + (point?.x ?? to.width / 2), clientY: to.top + (point?.y ?? to.height / 2) }
  const dataTransfer = new DataTransfer()
  const fire = (element: Element, type: string, position: { clientX: number; clientY: number }): void => {
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...position }))
  }
  // The browser fires dragstart on the draggable element itself, even when a child was pressed (a
  // drag handle); the pointer position says where the drag began.
  const draggableElement = source.closest('[draggable="true"]') ?? source
  fire(draggableElement, 'dragstart', { clientX: from.left + from.width / 2, clientY: from.top + from.height / 2 })
  await frame()
  fire(target, 'dragenter', at)
  fire(target, 'dragover', at)
  await frame()
  fire(target, 'dragover', at)
  fire(target, 'drop', at)
  fire(draggableElement, 'dragend', at)
  await frame()
}
