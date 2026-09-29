# ADE language

These terms name ADE's resources and actions across the desktop, CLI and SDK.

## Place and identity

**Host**: A machine where ADE runs a resource.

**Profile**: A host-scoped collection of accounts, settings, history and installed plugins.

**Project**: A registered repository or ordinary folder that groups its workspaces.

**Workspace**: A checkout or folder with its own stable identity within a project. A repository
project can have a primary checkout and linked worktrees; a folder project has one workspace.
_Avoid_: using project, branch or worktree for every workspace.

**Remove from ADE**: Hide a workspace from ADE while retaining its files, so opening the folder
again can restore its identity.

## Agent work

**Conversation**: One agent interaction bound to a workspace, provider session and account context.
_Avoid_: chat when naming this ADE resource.

**Provider**: An adapter to an agent's native protocol and declared capabilities.

**Account**: A profile-owned provider identity whose native login can be used by conversations.

**Account context**: The login a conversation's agent uses: a managed profile account or the
provider's ambient login on its host.

**Attention**: Whether a conversation is idle, running, needs the person, or has an error.

**Unread**: Whether a conversation has a reply or notice newer than the person's seen mark. A
conversation can be unread without needing attention.

**Execution attempt**: One run of an agent, distinct from the conversation it serves.

**Activity**: A durable event about agent work or a request for the person, available in the
activity feed.

## Commands

**Operation**: A named query or command available through ADE's application API.

**Effect command**: A command whose external or nonrepeatable effect needs an operation ID,
outcome evidence and reconciliation before an uncertain result can be retried.

**Receipt**: The durable record of an effect command's admission and outcome.

## Workspace views and processes

**Terminal**: A workspace-owned shell, service or script execution that a view can attach to.

**Busy terminal**: A terminal whose foreground process is doing work beyond its own shell or
managed program.

**Window**: One app window, including the workspace it shows and its view state.

**Layout**: The arrangement of sidebars, panes and tabs for one workspace in one window.

**Pane**: One area of a layout with a strip of tabs. Panes can be split side by side or stacked.

**Tab**: An entry in a pane that points at the content shown there. It is distinct from the
resource it displays; two tabs can point at the same resource.

**Browser tab**: A browser page resource scoped to a profile. Workspace ownership is planned in
[browser ticket 09](.scratch/daemon-authority/issues/09-browser-tab-records.md).

**Browser partition**: A profile-scoped store of a browser's site data, separate from other
partitions in that profile.

**Plugin activation**: One running instance of an installed plugin artifact.
