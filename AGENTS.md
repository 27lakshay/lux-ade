# Project instructions

ADE is in its UI phase. The backend (Rust daemon and runtime, contracts, SDK, CLI) is built and
proven headlessly; the work now is the Electron desktop app in `apps/desktop`. Read
[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) before changing anything there.

## Working rules

- Work on `main`. Commit each finished step with a focused message and report its hash. Pushing,
  opening a PR and merging into another branch need a separate instruction.
- Use pnpm for JavaScript and TypeScript packages. Keep Rust dependencies in Cargo.
- A design discussion or plan alone is not an implementation order.
- Every change passes `pnpm check:static`. It runs formatting, lint, typecheck, dead-code and
  boundary checks, the in-process tests and the legacy Rust tests; keep them all passing.
- When agents repeat a mistake, add a lint rule or a test that catches it, with a test of the rule
  itself. Do not rely on a written reminder alone.
- A lint suppression states its reason; unused suppressions fail the lint.

## Design workflow

Visual design happens in Pen (`~/Documents/ade.pen`). Code is where motion, interaction mechanics,
performance and accessibility behaviour are worked out. Use the terms in [CONTEXT.md](CONTEXT.md)
in UI copy.

- A surface with an approved Pen design (the shell and the conversation, from the baseline frames)
  is built to that design.
- A surface without one is built from the stock shadcn kit, with stock compositions and blocks and
  no custom styling, under `src/renderer/src/provisional/`. It moves out when its Pen design is
  approved and built.
- The kit uses the Nova preset with ADE's Graphite colours in `shadcn.css` (Pen: Base "Graphite";
  replaced stock Stone on 2026-09-28). Surfaces separate by fill, not borders. Change colours in
  the theme, never by restyling kit components.

## Tests

- Backend behaviour is proven by headless E2E: real daemon and runtime processes driven through the
  CLI, the SDK or the public protocol, with no Electron, in `e2e/protocol/`, run with
  `pnpm test:e2e:protocol`. Write specs on the shared fixtures described in
  `e2e/protocol/README.md`. A backend feature is accepted only when its register acceptance passes.
- Renderer stores and components are tested with Vitest in browser mode, beside the code.
- Deterministic in-process tests stay allowed for pure cores: fingerprints, reducers, codecs,
  schema round-trips and reconciliation deciders, kept beside the code they test.
- `e2e/specs` holds legacy CLI and daemon specs that `e2e/protocol` does not cover yet. Port one
  into `e2e/protocol`, then delete it.

## Architecture

- Operations fall into three tiers: query, idempotent command and effect command. Only effect
  commands carry an operation ID, a daemon-computed payload fingerprint, a receipt and
  reconciliation. Declare each operation's tier in its contract. See section 4 of
  [the proposed architecture](docs/proposed-architecture.md).
- Before changing process ownership, protocols, providers or plugins, read
  [the proposed architecture](docs/proposed-architecture.md). [docs/architecture.md](docs/architecture.md)
  describes the removed GPUI prototype; do not write code for it or its Python scripts.
- Contracts: add an operation's typed request and response to
  `crates/ade-core/src/contract/<domain>.rs` with a declared tier, then run
  `pnpm contract:generate`. Never edit the generated files in `packages/contracts` by hand.
  Effect commands use `crates/ade-daemon/src/receipts.rs`.
- Keep terminal output outside React state. Keep the client SDK independent of React and Electron.

## Reference code

Reference repos in `~/work/ade-evaluation-2026-09-24` may be copied with attribution under their
MIT or Apache-2.0 licences; see the [licence and path table](.scratch/parallel-build/research/08-reference-map.md).
A copied file carries a `Portions adapted from <repo> <path> (<licence>)` header and gets an entry
in `THIRD-PARTY-NOTICES.md`. GPL-licensed files and vendored third-party directories there are
study-only.

## Agent skills

- Issue tracker: the local Markdown tracker in [issue-tracker guidance](docs/agents/issue-tracker.md).
  Start v1 work from the [spec index](.scratch/ade-v1/README.md) and its requirements register.
- Triage: published specs use `ready-for-agent`; see [triage labels](docs/agents/triage-labels.md).
- Domain: read [CONTEXT.md](CONTEXT.md) and follow [domain guidance](docs/agents/domain.md) before
  changing shared terminology or contracts.
- Libraries: before writing a utility, hook, parser or UI mechanism, find its task in
  [docs/agents/libraries.md](docs/agents/libraries.md) and use the package it names.
- Library notes: Electron and Tailwind v4 publish no agent docs; read the verified notes in
  `docs/agents/` before using their APIs. The terminal (Ghostty as WebAssembly) is described in
  [docs/agents/terminal.md](docs/agents/terminal.md).
