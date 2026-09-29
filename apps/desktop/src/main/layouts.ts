import { DaemonRequestError, type Layout, type LayoutAction, type LayoutRecord } from '@ade/client'
import type { BusyTerminal, LayoutOutcome } from '../shared/bridge/layouts'
import { daemonCall } from './daemon-call'
import { handle } from './ipc'
import { validId } from './validation'
import { recordOf } from './windows'

// A window's layout requests: each acts on the sender's own window record (windows.ts), never on
// one the renderer names. The SDK checks every request against its contract before it is sent. The
// daemon's refusals a window acts on come back as values; others are thrown.

const REFUSALS = new Set([
  'layout_conflict',
  'tab_close_required',
  'tab_target_missing',
  'invalid_layout',
  'terminal_busy',
  'window_not_found',
  'workspace_not_found',
  'workspace_removed',
])

function workspace(value: unknown): string {
  if (!validId(value)) throw new Error('Invalid workspace')
  return value
}

function object<T>(value: unknown, what: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${what}`)
  return value as T
}

function revision(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid layout revision')
  return value as number
}

const busyTerminals = (value: unknown): BusyTerminal[] =>
  Array.isArray(value)
    ? value.flatMap((item: Record<string, unknown> | null) =>
        item && typeof item.terminal_id === 'string'
          ? [
              {
                terminal_id: item.terminal_id,
                foreground: typeof item.foreground === 'string' ? item.foreground : null,
              },
            ]
          : [],
      )
    : []

/** Runs a layout command, turning the daemon's expected refusals into outcomes. */
async function outcome(request: () => Promise<{ layout: LayoutRecord; changed: boolean }>): Promise<LayoutOutcome> {
  try {
    const reply = await request()
    return { ok: true, layout: reply.layout, changed: reply.changed }
  } catch (error) {
    if (error instanceof DaemonRequestError && error.replied && REFUSALS.has(error.code))
      return { ok: false, code: error.code, message: error.message, terminals: busyTerminals(error.details.terminals) }
    throw error
  }
}

export function registerLayoutIpc(): void {
  handle('ade:window-id', (event) => {
    try {
      return recordOf(event.sender.id)
    } catch {
      return null
    }
  })
  handle('ade:layout-get', async (event, workspaceId: unknown) => {
    const reply = await daemonCall('layout.get', {
      window_id: recordOf(event.sender.id),
      workspace_id: workspace(workspaceId),
    })
    return reply.layout
  })
  handle('ade:layout-apply', (event, workspaceId: unknown, action: unknown, expected: unknown) =>
    outcome(() =>
      daemonCall('layout.apply', {
        window_id: recordOf(event.sender.id),
        workspace_id: workspace(workspaceId),
        action: object<LayoutAction>(action, 'layout action'),
        expected_revision: revision(expected),
      }),
    ),
  )
  handle('ade:layout-replace', (event, workspaceId: unknown, layout: unknown, expected: unknown) =>
    outcome(() =>
      daemonCall('layout.replace', {
        window_id: recordOf(event.sender.id),
        workspace_id: workspace(workspaceId),
        layout: object<Layout>(layout, 'layout'),
        expected_revision: revision(expected),
      }),
    ),
  )
  handle('ade:tab-close', (event, workspaceId: unknown, tabId: unknown, force: unknown) => {
    if (!validId(tabId)) throw new Error('Invalid tab')
    return outcome(() =>
      daemonCall('tab.close', {
        window_id: recordOf(event.sender.id),
        workspace_id: workspace(workspaceId),
        tab_id: tabId,
        force: force === true,
      }),
    )
  })
  handle('ade:pane-close', (event, workspaceId: unknown, paneId: unknown, force: unknown) => {
    if (!validId(paneId)) throw new Error('Invalid pane')
    return outcome(() =>
      daemonCall('pane.close', {
        window_id: recordOf(event.sender.id),
        workspace_id: workspace(workspaceId),
        pane_id: paneId,
        force: force === true,
      }),
    )
  })
  handle('ade:window-show-workspace', async (event, workspaceId: unknown) => {
    const reply = await daemonCall('window.show_workspace', {
      window_id: recordOf(event.sender.id),
      workspace_id: workspace(workspaceId),
    })
    return reply.window
  })
  handle('ade:window-collapse', async (event, projectIds: unknown) => {
    if (!Array.isArray(projectIds) || projectIds.length > 512 || !projectIds.every(validId))
      throw new Error('Invalid project list')
    const reply = await daemonCall('window.set_view_state', {
      window_id: recordOf(event.sender.id),
      collapsed_projects: projectIds,
    })
    return reply.window
  })
}
