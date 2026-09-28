# ADE domain context

The current application is a Rust/GPUI prototype. The planned successor uses an
Electron/React frontend with independent Rust state and execution processes.
Specifications describe intended behavior, not verified implementation status.

| Term | Meaning |
|---|---|
| Host | Stable identity of the machine where a resource executes |
| Profile | Host-scoped accounts, settings, history, plugins and browser data; not a same-user security sandbox |
| Project | Registered repository or ordinary folder; every workspace belongs to exactly one. Its kind is `repository` or `folder` |
| Workspace | Independent stable identity for a checkout/directory on an execution host |
| Workspace kind | `primary_checkout`, `linked_worktree` (a worktree) or `folder`; a branch is an attribute of a workspace, not a record |
| Remove from ADE | Hide a workspace and stop its terminals without touching its files; opening its folder again restores the same workspace |
| Conversation | Agent interaction bound to workspace, provider session and explicit account context |
| Attention | Whether a conversation needs the person: `idle`, `running`, `needs_you` or `error`, reported by the daemon |
| Operation | Identified command with payload fingerprint, admission state and outcome evidence |
| Execution attempt | A particular runtime-owned run, fenced by incarnation/turn identity |
| Provider | Adapter preserving an agent's native protocol and declared capabilities |
| Account | Provider identity with host-owned native/credential state; refresh does not change identity |
| Plugin activation | One running activation of a pinned plugin artifact; separate from its data schema |
| HostResources | Cooperating runtimes' host-local physical resource claims and OS guards |
| Terminal | Runtime-owned PTY/execution owned by a workspace; presented in the window by Ghostty |
| Busy terminal | A terminal whose foreground process is not its shell; closing it asks first |
| Window | A daemon record of one app window: which workspace it shows and its view state |
| Layout | A window's sidebars, panes and tabs for one workspace, owned by the daemon |
| Pane | One area of a layout that holds tabs; panes split side by side or stacked |
| Tab | One entry in a pane; its tab target names what it shows |
| Tab target | What a tab shows: a conversation, terminal, browser tab, file, diff or a new conversation |
| Browser session | Explicit profile/host identity with frontend or background ownership |
| Activity | Durable application event used by the feed and notification delivery |
| E2E | Observable behavior through running Electron, CLI or public protocol using real ADE processes |

Use the [v1 spec index](.scratch/ade-v1/README.md) and
[requirements register](.scratch/ade-v1/requirements.md) for scope. Use the
[architecture proposal](docs/proposed-architecture.md) for ownership and recovery
rules, and [current architecture](docs/architecture.md) to locate existing code.
Record later material decisions in the spec's decision register and relevant
specification; never silently infer that a package candidate or prototype behavior
settles a product requirement.
