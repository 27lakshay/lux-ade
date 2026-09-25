# Project instructions

- Use pnpm for JavaScript and TypeScript packages. Keep Rust dependencies in Cargo.
- Write end-to-end tests only. Do not add unit tests, isolated component tests, or
  isolated integration tests in any language. Exercise behavior through the running
  application, CLI, or public protocol with real ADE processes. Type checking,
  linting, formatting, and static analysis remain required checks.
- Existing prototype tests are legacy coverage. Do not delete them or add to them
  as part of new work; migrate required behavior to end-to-end coverage before
  retiring their test gates.
- Before initializing or restructuring the monorepo, read
  [the initialization plan](docs/monorepo-initialization-plan.md). Before changing
  process ownership, protocols, providers, or plugins, read
  [the proposed architecture](docs/proposed-architecture.md). These describe the
  planned successor; [the current architecture](docs/architecture.md) describes
  the GPUI implementation.
- React, xterm.js, and Fallow are selected. Keep terminal output outside React
  state. Keep the client SDK independent of React and Electron. Use Fallow for
  JavaScript/TypeScript dead-code analysis.
- The user authorized commits for the active ADE v1 build goal. Keep commits
  focused and report their hashes. Pushing, opening a PR, and merging into another
  branch still require separate instructions. A design discussion or plan alone
  is not an implementation order.

## Agent skills

- Issue tracker: use the local Markdown tracker described in
  [issue-tracker guidance](docs/agents/issue-tracker.md). Start v1 work from the
  [spec index](.scratch/ade-v1/README.md) and its complete requirements register.
- Triage: published specs use `ready-for-agent`; see
  [triage labels](docs/agents/triage-labels.md).
- Domain: read [CONTEXT.md](CONTEXT.md) and follow
  [domain guidance](docs/agents/domain.md) before changing shared terminology or contracts.
