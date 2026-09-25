# ADE domain context

The current application is a Rust/GPUI prototype. The planned successor uses an
Electron/React frontend with independent Rust state and execution processes.
Specifications describe intended behavior, not verified implementation status.

| Term | Meaning |
|---|---|
| Host | Stable identity of the machine where a resource executes |
| Profile | Host-scoped accounts, settings, history, plugins and browser data; not a same-user security sandbox |
| Project | Registered repository or ordinary folder |
| Workspace | Independent stable identity for a checkout/directory on an execution host |
| Conversation | Agent interaction bound to workspace, provider session and explicit account context |
| Operation | Identified command with payload fingerprint, admission state and outcome evidence |
| Execution attempt | A particular runtime-owned run, fenced by incarnation/turn identity |
| Provider | Adapter preserving an agent's native protocol and declared capabilities |
| Account | Provider identity with host-owned native/credential state; refresh does not change identity |
| Plugin activation | One running activation of a pinned plugin artifact; separate from its data schema |
| HostResources | Cooperating runtimes' host-local physical resource claims and OS guards |
| Terminal | Runtime-owned PTY/execution with an attached xterm presentation adapter |
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
