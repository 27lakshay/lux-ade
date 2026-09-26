# ADE v1 specification index

Status: ready-for-agent
Type: specification index

These specifications are published to the repository's local Markdown issue
tracker. The user approved the Electron application, CLI and public protocol as
E2E test interfaces backed by real ADE processes. No implementation is authorized
merely by publication, and no feature is marked complete by this specification.

Delivery-process planning for a faster parallel build lives in the
[parallel build map](../parallel-build/README.md); it is not a v1 feature.

## Start here

1. Read the [requirements register](requirements.md): all 140 original features,
   including 107 v1 requirements, 10 deferred items and 23 exclusions.
2. Read [shared reliability and release requirements](13-reliability/spec.md).
3. Read the domain specification for the work being planned or implemented.
4. Resolve relevant [delivery decisions](decisions.md) and record the supported
   scope before claiming a feature is complete.

| Spec | Feature IDs | Delivery relationship |
|---|---|---|
| [Desktop and profiles](01-foundation/spec.md) | F001–F020 | Foundation; remote-only behavior also needs remote execution |
| [Providers and accounts](02-providers/spec.md) | F021–F030 | Public commands, runtime, plugin contract; prove primary three before freezing it |
| [Conversations and history](03-conversations/spec.md) | F031–F050 | Foundation and provider vertical slice; backup also needs storage reliability |
| [Trusted plugins](04-plugins/spec.md) | F051–F060 | Extract contracts alongside working providers/UI, then prove independent extension |
| [Projects and worktrees](05-workspaces/spec.md) | F061–F070 | Foundation, HostResources, creator-owned lifecycle |
| [Files and Git](06-files-git/spec.md) | F071–F080 | Workspace identity; conversation feedback needs provider integration |
| [Terminals and services](07-terminals-services/spec.md) | F081–F090 | First real execution slice; xterm restoration is an early gate |
| [Browser and devices](08-browser-devices/spec.md) | F091–F100 | Foundation and host capabilities; ordinary browser preview enters daily loop |
| [API and coordination](09-api-orchestration/spec.md) | F101–F113 | API/CLI foundation first; delegation follows providers/workspaces |
| [Notifications and activity](10-notifications/spec.md) | F114–F120 | Durable activity and desktop integration |
| [Remote execution](11-remote/spec.md) | F121–F130 | Proven local command/runtime behavior before direct/SSH distribution |
| [MCP, skills and operations](12-integrations-operations/spec.md) | F131–F140 | Dev/E2E tooling first; catalogs follow adapters; retention follows ownership |
| [Shared reliability](13-reliability/spec.md) | R001–R020 | Applies throughout; never postpone correctness to a final hardening phase |

Feature ranges include deferred/excluded entries for traceability; each spec's
user stories and acceptance table identify its selected work. Splitting specs by
domain does not imply twelve independent implementation projects or a dependency
cycle: build the smallest working vertical contracts, then deepen their modules.

## Delivery checkpoints

| Checkpoint | Completion evidence |
|---|---|
| Initialize | Reproducible pnpm/Cargo workspace; Electron/React HMR; public command connection; E2E runner; Rust-owned xterm terminal with correct reconnect |
| Daily use | Profile/project/workspace/account selection; all three primary agents; messages/tools/approvals; persistent terminal; diff; dev service/browser preview; matching CLI controls |
| Reliable extension | Recovery and resource failure scenarios; independent backend/UI extension; active provider version retention; safe mode |
| Full v1 | Every F-series item marked V1 and every R-series requirement has declared support, E2E evidence and resolved material decisions, including selected remote/device/catalog capabilities |

Initialization and daily use are subsets of v1, not alternative release definitions.
No estimated dates or implementation-complete percentages have been established.

## Authority and supporting documents

- [Domain glossary](../../CONTEXT.md) supplies stable terminology.
- [Architecture proposal](../../docs/proposed-architecture.md) explains ownership
  and the audit findings. These specs supply item-level scope and acceptance.
- [Initialization plan](../../docs/monorepo-initialization-plan.md) describes the
  first implementation sequence and package candidates.
- [Current architecture](../../docs/architecture.md) describes existing code.

Later explicit user decisions override these documents. Record a scope change in
the register and its owning spec together; do not infer completion from the prototype
or treat a recommended package as an agreed requirement.
