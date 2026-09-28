import { toast } from '@/components/ui/toast'
import { confirm } from '../../../provisional/ConfirmDialog'
import { askName } from '../../../provisional/NameDialog'
import { selectWorkspace } from './workspace-selection'

// What the navigator's project and workspace menus do. Main runs each action against the daemon
// (main/workspace-actions.ts); a refusal comes back as reasons and is shown as a toast.

/** The message of an error from main, without Electron's "Error invoking remote method" prefix. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

function refused(title: string, reasons: string[]): void {
  toast.add({ type: 'error', title, description: reasons.join('. ') + '.' })
}

function failed(title: string, error: unknown): void {
  toast.add({ type: 'error', title, description: errorMessage(error) })
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  try {
    await window.adeHost.workspaces.rename(id, name)
  } catch (error) {
    failed('Could not rename the workspace', error)
  }
}

export async function removeWorkspace(id: string, name: string): Promise<void> {
  const confirmed = await confirm({
    title: `Remove “${name}” from ADE?`,
    description: 'Its files stay on disk. Open its folder again to bring it back.',
    confirmLabel: 'Remove',
  })
  if (!confirmed) return
  try {
    const outcome = await window.adeHost.workspaces.remove(id)
    if (!outcome.removed) refused(`Could not remove “${name}”`, outcome.reasons)
  } catch (error) {
    failed(`Could not remove “${name}”`, error)
  }
}

export async function deleteWorktree(id: string, name: string): Promise<void> {
  try {
    const check = await window.adeHost.workspaces.checkWorktree(id)
    if (check.reasons.length > 0) return refused(`Could not delete “${name}”`, check.reasons)
    const confirmed = await confirm({
      title: `Delete the worktree “${name}”?`,
      description: `ADE removes the workspace and deletes ${check.path}. Its branch stays.`,
      confirmLabel: 'Delete worktree',
      destructive: true,
    })
    if (!confirmed) return
    const outcome = await window.adeHost.workspaces.deleteWorktree(id)
    if (!outcome.removed) refused(`Could not delete “${name}”`, outcome.reasons)
  } catch (error) {
    failed(`Could not delete “${name}”`, error)
  }
}

/** Asks for a name, creates a worktree of the project named after it, and shows it. */
export async function newWorkspace(projectWorkspaceId: string, projectName: string): Promise<void> {
  const name = await askName({
    title: `New workspace in ${projectName}`,
    description: 'ADE creates a worktree on a new branch named after it.',
    label: 'Name',
    confirmLabel: 'Create',
  })
  if (!name) return
  try {
    const id = await toast.promise(window.adeHost.workspaces.createWorktree(projectWorkspaceId, name), {
      loading: { title: `Creating “${name}”…` },
      success: { title: `Created “${name}”` },
      error: (error: unknown) => ({ title: `Could not create “${name}”`, description: errorMessage(error) }),
    })
    selectWorkspace(id)
  } catch {
    // The toast says why.
  }
}
