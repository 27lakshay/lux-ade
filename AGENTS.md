# Project instructions

- Use pnpm for JavaScript and TypeScript packages. Keep Rust dependencies in Cargo.
- Test policy (user decision, 2026-09-27): do no end-to-end work until UI work
  begins. Write no new E2E specs, and do not run the E2E suite as a gate for
  backend slices. Verify backend work with `pnpm check:static` (formatting, strict
  Clippy, the legacy Rust tests, the architecture check, typecheck, Fallow and
  builds). Deterministic in-process tests are allowed for pure cores only:
  fingerprints, reducers, codecs, schema round-trips and reconciliation deciders.
  Keep them beside the code they test. E2E returns when UI work starts.
- Existing prototype and E2E tests are legacy coverage. Do not delete them. Keep
  the legacy Rust tests passing, because `check:static` runs them.
- Operations fall into three tiers: query, idempotent command and effect command.
  Only effect commands carry an operation ID, a daemon-computed payload
  fingerprint, a receipt and reconciliation. Declare each operation's tier in its
  contract. See section 4 of [the proposed architecture](docs/proposed-architecture.md).
- Before initializing or restructuring the monorepo, read
  [the initialization plan](docs/monorepo-initialization-plan.md). Before changing
  process ownership, protocols, providers, or plugins, read
  [the proposed architecture](docs/proposed-architecture.md). These describe the
  planned successor. [The current architecture](docs/architecture.md) describes
  the GPUI prototype. Its client crate was removed on 2026-09-27, and the Python
  scripts that drive it are unmaintained; do not write code for them.
- React, xterm.js, and Fallow are selected. Keep terminal output outside React
  state. Keep the client SDK independent of React and Electron. Use Fallow for
  JavaScript/TypeScript dead-code analysis.
- The user authorized commits for the active ADE v1 build goal. Keep commits
  focused and report their hashes. Pushing, opening a PR, and merging into another
  branch still require separate instructions. A design discussion or plan alone
  is not an implementation order.

## Parallel build

The build runs as one coordinator plus up to 10 workers; see the
[parallel build map](.scratch/parallel-build/README.md) and its
[handoff](.scratch/parallel-build/issues/15-handoff-order.md).

- The coordinator is the Claude session in this checkout. Workers run in their
  own worktrees on `claude/<slice>` branches. The coordinator merges them into
  `codex/architecture-proposal` one at a time, rebasing first, then `--no-ff`.
- Run `scripts/worker-bootstrap.sh` first in every new worker worktree.
- A worker edits only its own domain's modules. Only the coordinator edits the
  shared files: the central contract enums, migration version numbers,
  `AGENTS.md`, `.scratch/ade-v1/progress.md`, `.scratch/ade-v1/decisions.md` and
  `THIRD-PARTY-NOTICES.md`. A worker that needs a change there says so in its
  result.
- Contracts: a slice adds its operations' typed request and response types to
  `crates/ade-core/src/contract/<domain>.rs` with a declared tier, then runs
  `pnpm contract:generate`. Generated files in `packages/contracts` are never
  edited by hand; on a merge conflict the coordinator regenerates them.
  Effect commands use `crates/ade-daemon/src/receipts.rs`.
- Each slice writes `.scratch/ade-v1/evidence/<slice>.md` from
  [the template](.scratch/ade-v1/evidence/TEMPLATE.md). It records the time spent,
  the checks run and a `References:` block.
- Reference repos in `~/work/ade-evaluation-2026-09-24` may be copied with
  attribution under their MIT or Apache-2.0 licences. See the
  [licence and path table](.scratch/parallel-build/research/08-reference-map.md).
  A copied file carries a `Portions adapted from <repo> <path> (<licence>)` header
  and gets an entry in `THIRD-PARTY-NOTICES.md`. GPL-licensed files and vendored
  third-party directories in those repos are study-only.

## Agent skills

- Issue tracker: use the local Markdown tracker described in
  [issue-tracker guidance](docs/agents/issue-tracker.md). Start v1 work from the
  [spec index](.scratch/ade-v1/README.md) and its complete requirements register.
- Triage: published specs use `ready-for-agent`; see
  [triage labels](docs/agents/triage-labels.md).
- Domain: read [CONTEXT.md](CONTEXT.md) and follow
  [domain guidance](docs/agents/domain.md) before changing shared terminology or contracts.
