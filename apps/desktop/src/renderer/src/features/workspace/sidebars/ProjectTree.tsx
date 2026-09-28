import { useLocalStorage } from 'usehooks-ts'
import { useStore } from 'zustand'
import { Row } from '@/components/Row'
import { Status } from '@/components/Status'
import { Caption, Meta } from '@/components/Typography'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Icon } from '@/icons/Icon'
import { WINDOW_NAME } from '../../../app/window-name'
import { useDaemon } from '../../../state/hooks'
import { layoutStore } from '../model/layout-store'
import { conversationState, navigatorTree, type NavigatorProject } from './navigator-tree'
import { selectWorkspace, useWorkspaceSync } from './workspace-selection'

// The navigator's list: projects, their workspaces and each workspace's conversations, built from
// the daemon's catalog (navigator-tree.ts). Rows are the Pen "Project row", "Workspace row" and
// "Conversation row"; the section header is "Section header" (its add button is the sidebar
// footer's "Add project", one control for one action). Choosing a workspace shows its layout.

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
      <Row
        aria-expanded={!collapsed}
        leading={
          <span className="flex items-center gap-1">
            <Icon name={collapsed ? 'expand' : 'collapse'} size="xs" tone="muted" />
            <Icon name="project" tone="muted" />
          </span>
        }
        onClick={toggle}
      >
        {project.name}
      </Row>
      {!collapsed && (
        <ul>
          {project.workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Row
                depth={1}
                selected={workspace.id === active}
                aria-current={workspace.id === active || undefined}
                leading={<Icon name="branch" tone="muted" />}
                onClick={() => selectWorkspace(workspace.id)}
              >
                {workspace.name}
              </Row>
              {workspace.conversations.length > 0 && (
                <ul>
                  {workspace.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Row
                        depth={2}
                        leading={<Status state={conversationState(conversation.status)} />}
                        onClick={() => selectWorkspace(workspace.id)}
                      >
                        {conversation.title}
                      </Row>
                    </li>
                  ))}
                </ul>
              )}
            </li>
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
  const active = useStore(layoutStore, (state) => state.active)
  const connected = useDaemon((state) => state.status === 'connected')
  const [collapsed, setCollapsed] = useLocalStorage<string[]>(`ade.navigator.collapsed:${WINDOW_NAME}`, [])
  const projects = navigatorTree(
    workspaceIds.map((id) => workspaces[id]!),
    conversationIds.map((id) => conversations[id]!),
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
