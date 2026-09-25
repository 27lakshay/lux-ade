# Electron and Rust monorepo initialization plan

Status: implementation plan, 26 September 2026. The pnpm/Electron foundation and
read-only daemon attachment are implemented; terminal, CLI, and provider migration
remain open.
The [proposed architecture](proposed-architecture.md) defines the product and
ownership requirements. This plan establishes its first runnable vertical slice.
The [complete v1 specifications](../.scratch/ade-v1/README.md) define the full
release scope; completing this initialization plan does not complete all of v1.

## Outcome and scope

Initialize a pnpm/Cargo monorepo with a macOS Electron application, React frontend,
independent Rust daemon/runtime, xterm.js terminal surface, and an end-to-end test
harness. Keep the existing GPUI prototype runnable during migration.

Initialization is complete when a developer can install dependencies, start the
desktop with renderer HMR, run and reconnect to a real runtime-owned terminal,
exercise the same resource through the CLI, and run the documented checks from
the repository root. Provider support then expands through Claude Code, Codex,
and Oh My Pi to complete the daily-use milestone. This does not shrink the wider
v1 scope recorded in the architecture proposal.

## Decisions and package policy

| Status | Choice | Responsibility |
|---|---|---|
| Agreed | Electron, React, TypeScript | Desktop shell and web UI |
| Agreed | xterm.js | Terminal presentation; Rust retains PTY ownership |
| Agreed | pnpm workspaces and Cargo workspace | JS/TS and Rust dependency management |
| Agreed | Fallow, replacing Knip | JS/TS dead-code analysis |
| Agreed | End-to-end tests only | All new behavioral test coverage |
| Retained | Rust, Serde, rusqlite, portable-pty, tracing | Existing backend foundations, subject to reuse audit |
| Proposed default | Vite, electron-vite, React Vite plugin | Renderer HMR and Electron builds |
| Proposed default | Playwright Test | Desktop and public-interface end-to-end runner |
| Proposed default | Oxlint and Oxfmt | JS/TS lint and formatting |
| Proposed default | electron-builder and electron-updater | Packaging and later controlled updates |
| Proposed default | Node LTS for general plugin hosts | Headless execution independent of Electron |

Resolve exact versions at implementation time. Verify each package's current
official documentation, agent guidance, license, platform support and compatibility.
Pin the package manager and toolchain versions; commit a root pnpm lockfile and
retain Cargo.lock. Do not copy prerelease versions or forks from reference projects
without a specific reason. Do not install the entire candidate catalog on day one.

The existing Oh My Pi bridge uses Bun. Preserve provider-specific runtime
requirements until its adapter passes the same behavior on another runtime.
Using pnpm to install packages does not require every provider to execute in Node.

### Packages added as their feature enters the slice

| Feature | Candidate / selection | Admission condition |
|---|---|---|
| Terminal | `@xterm/xterm`, fit, search, web-links, WebGL addons | Pin a compatible set; prove restoration and fallback rendering |
| UI primitives | Base UI | Proposed; verify keyboard/focus behavior in the application |
| Styling | Tailwind, CSS design tokens, selected shadcn source | Proposed; plugin themes depend on tokens, not utility classes |
| Animation | Motion plus CSS transitions | Proposed; preserve reduced-motion behavior |
| Icons / drag ordering | Lucide / dnd-kit | Add when actual controls need them |
| Composer | Tiptap | Prove IME, paste, context nodes, draft restoration and plugin removal |
| Markdown | react-markdown/unified; compare Streamdown | Decide with streaming, sanitization and large-output scenarios |
| Diffs / highlighting | Pierre Diffs / Shiki | Validate worker use, annotations, large files and lazy grammar loading |
| Long lists | TanStack Virtual; compare Legend List for chat | Prove prepend anchoring and streaming-height changes |
| Docking | Evaluate Dockview | Prove terminal lifetime, focus and custom panel lifecycle before selection |
| Client state | Evaluate Zustand vanilla | One synchronized projection owner; separate React bindings |
| Wire schemas | Evaluate ts-rs and Schemars | Generated bindings and runtime validation agree on real wire payloads |

Do not add Vitest, Testing Library, unit-test frameworks, or a component-test suite.
Storybook remains an optional development preview, not a separate behavioral test
strategy. Effect is not required by the public SDK. An editor, marketplace, mobile
app, and relay are outside initialization scope.

## Target repository structure

The repository already has a Cargo workspace and two independent provider package
roots. Extend it in place. The following is the target map, not an instruction to
create empty packages before they have behavior.

```text
apps/
  desktop/                  Electron main, preload, packaging entry
  cli/                      Thin TS CLI using the public client SDK
packages/
  contracts/                Generated wire types, schemas, compatibility metadata
  client/                   Commands, queries, projection, reconnect, subscriptions
  client-react/             React bindings to the framework-neutral client
  ui/                       React workspace UI, tokens, components, composition
  terminal/                 xterm adapter, no React dependency
  plugin-api/               Framework-neutral extension contracts
  plugin-host/              Headless backend extension host
providers/
  claude/                   Existing bridge, migrated incrementally
  omp/                      Existing bridge; preserve required execution runtime
  codex/                    Add only when extracting its actual provider worker
crates/
  ade-core/                 Rust contracts and shared types
  ade-daemon/               Durable state and application operations
  ade-runtime/              Processes, PTYs, execution and resource ownership
  ade-platform/             Native support and diagnostics
  ade-client/               Legacy GPUI client during transition
e2e/
  fixtures/                 Isolated profiles, repositories, external test peers
  specs/                    Desktop, CLI, recovery and lifecycle scenarios
scripts/                    Root development/build orchestration
docs/
package.json                Private root workspace scripts
pnpm-workspace.yaml          apps/*, packages/*, providers/*
pnpm-lock.yaml
Cargo.toml
Cargo.lock
```

Use private `@ade/*` package names and explicit package exports. Export generated
contracts without importing Rust implementation code. `client` and `plugin-api`
must not depend on Electron or React. `ui` uses `client-react`; `terminal` exposes
an imperative mount/dispose adapter. The CLI talks to the daemon through `client`.
Rust binaries remain independent executables, not renderer-loaded native addons.

React-to-Solid replacement would preserve contracts, client logic and backend
ownership, but still require replacing React components and UI plugin bindings.
Do not introduce a homegrown UI framework to promise a cost-free replacement.

## Ordered implementation work

### 1. Preserve the prototype and consolidate dependency ownership

- Inventory provider launch paths, native build assets, scripts and CI before edits.
- Add a private root pnpm workspace, pinned toolchain declarations and root scripts.
- Migrate the provider lockfiles into the root lockfile while preserving resolved
  versions where possible, native packages and intentional release-age exceptions.
- Update bootstrap/build scripts that install inside provider directories. Remove
  nested workspace/lockfile ownership only after root installation works.
- Keep the GPUI executable and existing native build targets available. Do not
  relocate Rust crates or provider scripts merely for visual directory symmetry.

Done: a clean checkout has one documented JS install route, existing providers
still launch, and the legacy build paths remain valid.

### 2. Establish package contracts and the development supervisor

- Introduce only the contracts/client/desktop/UI packages needed for the first view.
- Audit serialization: IDs, tagged unions, absent/null fields, large integers and
  byte payloads. Generate runtime schemas and TS bindings from one authority.
- Establish authenticated local connection, version handshake, profile identity,
  structured errors and cancellation. Keep a transport adapter for later remotes.
- Give development its own profile directory and ownership markers. Attach to
  existing compatible development processes without starting duplicate owners.
- Renderer HMR must preserve backend work. Main/preload reload may restart Electron;
  the daemon and runtime continue. Backend changes require explicit compatible
  restart/reconciliation, not an indiscriminate process-tree kill.
- Expose dev-server location through the existing Worktrunk development workflow.
  Read the machine worktree rules before starting or registering servers.

Done: the Electron shell displays real daemon connection/profile state, reconnects
after a UI reload, and visibly reports incompatible or unavailable backends.

### 3. Establish end-to-end infrastructure before feature expansion

- Use Playwright Test to launch the actual Electron application and Rust processes.
- Use isolated temporary profiles, repositories, credential fixtures and ports.
  Track and clean only processes and resources owned by that test run.
- Exercise CLI/public protocol scenarios through running processes. Do not import
  internal reducers, services or parsers to test them in isolation.
- A deterministic provider executable may stand in for an external service at its
  protocol boundary. Keep actual ADE admission, storage, transport and rendering.
  Distinguish this from live-provider coverage, which requires explicit credentials.
- Inject failures by stopping owned processes or using controlled external peers;
  keep test-only controls unavailable in production builds.
- Collect bounded logs, traces, screenshots, operation IDs and process ownership
  evidence on failure. Redact secrets and keep fixtures away from personal accounts.

Done: one root command starts the real stack, observes a user-visible result,
collects useful failure evidence, and reliably cleans its own resources.

### 4. Prove xterm and terminal recovery

- Retain Rust PTY/process ownership. Feed bytes directly to the terminal adapter,
  with bounded delivery and completion acknowledgements outside React state.
- Add fit/search/links and WebGL with fallback; coordinate resize and input ownership.
- Resolve the existing `ghostty-snapshot-v1-herdr-9c96f7d` snapshot incompatibility.
  xterm cannot directly restore it. Define and implement a negotiated recovery
  format or another bounded restoration strategy before claiming reconnect works.
- Preserve terminal modes, alternate screen and parser continuity as required by
  supported workloads. A visible-cell dump or arbitrary output tail is insufficient.
- Do not replace the Rust parser or silently switch away from xterm if this proves
  costly; present the concrete recovery alternatives and their trade-offs.
- Implement a thin CLI path to inspect/control the same terminal through the public
  commands. UI detachment must not imply process termination.

Done: end-to-end scenarios close/reopen the renderer during interactive work,
resize under output, survive renderer HMR, and show ordered output after reconnect.
Twenty-terminal load and a slow consumer remain bounded; no false exited state.

### 5. Complete the local daily-use flow

- Add profile/project/workspace selection, account readiness and provider selection.
- Adapt one real provider end to end, then Claude Code, Codex and Oh My Pi through
  the same provider contract before declaring it stable.
- Add composer, streaming history, tools, approvals, questions and cancellation.
- Add diff inspection, a managed dev service and an explicitly owned browser preview.
- Exercise daemon restart, duplicate requests, cancellation races and account pinning
  through the public interface. Report unknown effects rather than blindly retrying.

Done: all three providers pass documented real-provider daily flows; fixture-only
coverage is not reported as proof of native SDK/account compatibility.

### 6. Prove extension seams and package the desktop

- Extract actual extension interfaces from working providers and UI features.
- Demonstrate a backend extension and a UI replacement through public registrations.
- Test activation cleanup, missing plugin renderers, retained active provider workers
  and safe-mode recovery from a fresh renderer.
- Package Rust binaries, required native assets, provider artifacts and execution
  runtimes with explicit manifests. Do not assume the user's developer PATH exists.
- Validate a packaged macOS application separately from the Vite development server.
  Introduce signing/updater distribution only with the required identities and a
  defined old-runtime compatibility policy.

Done: the packaged application runs the terminal and provider flow in a clean
environment, and plugin failure does not prevent core recovery.

## Root command contract

These are planned scripts, not commands available in the current checkout.

| Command | Expected behavior |
|---|---|
| `pnpm dev` | Start/attach the isolated development backend and Electron/Vite UI |
| `pnpm build` | Build JS packages and required Rust/native artifacts in dependency order |
| `pnpm typecheck` | Check TS packages and generated binding consistency |
| `pnpm lint` | Run configured JS lint and architectural import checks |
| `pnpm format:check` | Validate formatting without rewriting files |
| `pnpm deadcode` | Run pinned Fallow against declared workspace entry points |
| `pnpm test:e2e` | Run deterministic full-stack scenarios |
| `pnpm test:e2e:live` | Run explicitly configured real-provider scenarios |
| `pnpm check` | Static checks, Rust compile/lint checks and deterministic E2E gates |
| `pnpm package:mac` | Produce a desktop artifact with declared runtime resources |

Use pnpm's workspace ordering and small scripts initially. Add a task orchestrator
only if measured build duplication warrants it. Fallow must know plugin entries,
generated exports, CLI bins and dynamic registrations; findings are reviewed, not
permission to automatically delete code. Verify its pinned CLI/configuration with
its own tool before making it a required gate.

## End-to-end-only verification policy

[AGENTS.md](../AGENTS.md) is the authoritative rule: no new unit, component, or
isolated integration tests. E2E checks observe running application behavior through
UI, CLI or public protocol. Do not relabel an internal function test as E2E.

Existing prototype tests and their scripts remain untouched during planning.
During migration, inventory their protected behaviors and replace required coverage
with end-to-end scenarios before retiring old gates. New routine successor test
commands run E2E only; static analysis, compilation and formatting are not unit tests.

| E2E suite | Required observations |
|---|---|
| Boot / profiles | Real startup, profile isolation, reconnect, compatible ownership |
| Terminal | Shell interaction, input/resize, recovery, Unicode/IME, output saturation |
| Providers | Turns, questions, approvals, cancellation, account identity and restart |
| Workspace / services | Worktree ownership, conflict reporting, cleanup, listener visibility |
| Client synchronization | Catch-up, duplicate commands, stale responses and history restoration |
| Plugins | Activation/disposal, fallback presentation and fresh-renderer safe mode |
| Packaged application | Resource discovery and launch without development tooling |

Playwright's Electron automation is experimental and does not directly cover all
native dialogs. Record native cases needing a platform automation adapter or manual
release check; do not mark them covered by browser-only assertions. Prefer observable
readiness over sleeps, retain first-attempt failures, and keep fixture and live-provider
results separate. Run later fault/load suites as E2E scenarios as well.

## References

- [electron-vite HMR](https://electron-vite.org/guide/hmr-and-hot-reloading)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)
- [Fallow upstream](https://github.com/fallow-rs/fallow/)
- [xterm addons](https://xtermjs.org/docs/guides/using-addons/)
- [Architecture proposal](proposed-architecture.md): full v1 selection, failure
  semantics, reference-project evidence, remote design and future clients.
