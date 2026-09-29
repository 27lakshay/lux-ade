import { useState } from 'react'
import { useLocalStorage } from 'usehooks-ts'
import { useStore } from 'zustand'
import { IconButton } from '@/components/IconButton'
import { INDENT, Row } from '@/components/Row'
import { Status } from '@/components/Status'
import { Caption, Meta } from '@/components/Typography'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Icon } from '@/icons/Icon'
import type { IconName } from '@/icons/icons'
import { WINDOW_NAME } from '../../../app/window-name'
import { useDaemon } from '../../../state/hooks'
import { layoutStore } from '../model/layout-store'
import { conversationState, navigatorTree, type NavigatorProject, type NavigatorWorkspace } from './navigator-tree'
import { deleteWorktree, newWorkspace, removeWorkspace, renameWorkspace } from './workspace-actions'
import { selectWorkspace, useWorkspaceSync } from './workspace-selection'

// The navigator's list: projects, their workspaces and each workspace's conversations, built from
// the daemon's catalog (navigator-tree.ts). Rows are the Pen "Project row", "Workspace row" and
// "Conversation row"; the section header is "Section header" (its add button is the sidebar
// footer's "Add project", one control for one action). Choosing a workspace shows its layout.
// A repository project adds workspaces (new worktrees); a workspace is renamed in place, removed
// from ADE, or, in a repository, has its worktree deleted (workspace-actions.ts).

/** A row's actions: shown on hover or keyboard focus, beside the row rather than inside its button. */
const HOVER_ACTIONS =
  'absolute inset-y-0 end-1 flex items-center opacity-0 group-hover/row:opacity-100 has-focus-visible:opacity-100 has-data-popup-open:opacity-100'

interface MenuAction {
  label: string
  icon: IconName
  run: () => void
  destructive?: boolean
}

function workspaceActions(workspace: NavigatorWorkspace, rename: () => void): (MenuAction | 'separator')[] {
  // The daemon's own workspace cannot be removed; only a worktree ADE made can be deleted.
  const removal: MenuAction[] = [
    ...(workspace.default
      ? []
      : [
          {
            label: 'Remove from ADE',
            icon: 'remove' as const,
            run: () => void removeWorkspace(workspace.id, workspace.name),
          },
        ]),
    ...(workspace.deletableWorktree
      ? [
          {
            label: 'Delete worktree',
            icon: 'delete' as const,
            destructive: true,
            run: () => void deleteWorktree(workspace.id, workspace.name, workspace.root),
          },
        ]
      : []),
  ]
  return [
    { label: 'Rename', icon: 'rename', run: rename },
    ...(removal.length ? ['separator' as const, ...removal] : []),
  ]
}

function RenameField({ workspace, done }: { workspace: NavigatorWorkspace; done: () => void }) {
  const commit = (value: string): void => {
    const name = value.trim()
    if (name && name !== workspace.name) void renameWorkspace(workspace.id, name)
    done()
  }
  return (
    <Input
      aria-label={`Rename ${workspace.name}`}
      defaultValue={workspace.name}
      maxLength={100}
      className="h-7"
      // The name stays where the row drew it: the row's indent, a 16px icon and an 8px gap.
      style={{ paddingInlineStart: 8 + INDENT + 16 + 8 }}
      ref={(input) => {
        // After the menu that opened it has returned focus to its trigger.
        const frame = requestAnimationFrame(() => input?.select())
        return () => cancelAnimationFrame(frame)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value)
        if (event.key === 'Escape') done()
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
    />
  )
}

function WorkspaceRows({ workspace, active }: { workspace: NavigatorWorkspace; active: boolean }) {
  const [renaming, setRenaming] = useState(false)
  const actions = workspaceActions(workspace, () => setRenaming(true))
  return (
    <li>
      {renaming ? (
        <RenameField workspace={workspace} done={() => setRenaming(false)} />
      ) : (
        <div className="group/row relative">
          <ContextMenu>
            <ContextMenuTrigger>
              <Row
                depth={1}
                selected={active}
                aria-current={active || undefined}
                leading={<Icon name="branch" tone="muted" />}
                className="group-hover/row:pe-8 group-has-data-popup-open/row:pe-8"
                onClick={() => selectWorkspace(workspace.id)}
              >
                {workspace.name}
              </Row>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {actions.map((action, index) =>
                action === 'separator' ? (
                  <ContextMenuSeparator key={index} />
                ) : (
                  <ContextMenuItem
                    key={action.label}
                    variant={action.destructive ? 'destructive' : 'default'}
                    onClick={action.run}
                  >
                    <Icon name={action.icon} />
                    {action.label}
                  </ContextMenuItem>
                ),
              )}
            </ContextMenuContent>
          </ContextMenu>
          <span className={HOVER_ACTIONS}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label={`${workspace.name} actions`} />}
              >
                <Icon name="more" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {actions.map((action, index) =>
                  action === 'separator' ? (
                    <DropdownMenuSeparator key={index} />
                  ) : (
                    <DropdownMenuItem
                      key={action.label}
                      variant={action.destructive ? 'destructive' : 'default'}
                      onClick={action.run}
                    >
                      <Icon name={action.icon} />
                      {action.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      )}
      {workspace.conversations.length > 0 && (
        <ul>
          {workspace.conversations.map((conversation) => (
            <li key={conversation.id}>
              <Row
                depth={2}
                leading={<Status state={conversationState(conversation)} />}
                onClick={() => selectWorkspace(workspace.id)}
              >
                {conversation.title}
              </Row>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function ProjectRows({
  project,
  active,
  collapsed,
  toggle,
}: {
  project: NavigatorProject
  active: string
  collapsed: boolean
  toggle: () => void
}) {
  return (
    <li>
      <div className="group/row relative">
        <Row
          aria-expanded={!collapsed}
          leading={
            <span className="flex items-center gap-1">
              <Icon name={collapsed ? 'expand' : 'collapse'} size="xs" tone="muted" />
              <Icon name="project" tone="muted" />
            </span>
          }
          className={project.repository ? 'group-hover/row:pe-8' : undefined}
          onClick={toggle}
        >
          {project.name}
        </Row>
        {project.repository && (
          <span className={HOVER_ACTIONS}>
            <IconButton
              icon="new"
              size="xs"
              label={`New workspace in ${project.name}`}
              onClick={() => void newWorkspace(project.id, project.name)}
            />
          </span>
        )}
      </div>
      {!collapsed && (
        <ul>
          {project.workspaces.map((workspace) => (
            <WorkspaceRows key={workspace.id} workspace={workspace} active={workspace.id === active} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function ProjectTree() {
  useWorkspaceSync()
  const workspaceIds = useDaemon((state) => state.workspaceIds)
  const workspaces = useDaemon((state) => state.workspaces)
  const conversationIds = useDaemon((state) => state.conversationIds)
  const conversations = useDaemon((state) => state.conversations)
  const projectRecords = useDaemon((state) => state.projects)
  const active = useStore(layoutStore, (state) => state.active)
  const connected = useDaemon((state) => state.status === 'connected')
  const [collapsed, setCollapsed] = useLocalStorage<string[]>(`ade.navigator.collapsed:${WINDOW_NAME}`, [])
  const projects = navigatorTree(
    workspaceIds.map((id) => workspaces[id]!),
    conversationIds.map((id) => conversations[id]!),
    projectRecords,
  )
  const toggle = (id: string): void =>
    setCollapsed((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 ps-2">
        <Caption tone="muted">Projects</Caption>
        <Meta numeric>{projects.length}</Meta>
      </div>
      {!connected ? (
        <div className="min-h-0 flex-1" />
      ) : projects.length === 0 ? (
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>Add a repository or folder to start working in it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul aria-label="Projects">
            {projects.map((project) => (
              <ProjectRows
                key={project.id}
                project={project}
                active={active}
                collapsed={collapsed.includes(project.id)}
                toggle={() => toggle(project.id)}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
