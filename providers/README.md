# Provider tests

Run all deterministic adapter tests with `pnpm test:providers`. The same command is part of
`pnpm check:static`. Node runs Claude and opencode tests; Bun runs OMP tests. Install workspace
dependencies with pnpm; Bun is needed as a test runtime, not as the package manager.

Use `pnpm test:providers --list` to inspect file selection without running tests. To focus a
provider and test name, use:

```sh
pnpm test:providers --provider claude --test-name-pattern 'task|subagent'
```

The Claude and OMP package `test` commands use the same selection. All provider-root
`*.test.mjs` files join deterministic acceptance except `live.test.mjs` and `loopback.test.mjs`.
Those files need a real installed provider or credentials and remain separate acceptance.
New directory layouts need an explicit discovery update; the ownership validator is tracked
in testing infrastructure ticket 03.

The deterministic runner clears `ADE_OPENCODE_LIVE_BIN`, `ADE_OPENCODE_LOOPBACK_BIN`,
`ADE_OMP_LIVE` and `ADE_OMP_LOOPBACK` even if the calling shell opts into external tests.
It preserves runner failures, stops before subsequent providers after a failure, and forwards
SIGINT/SIGTERM to the current runner and fixture process group with bounded teardown.
Correctness retries are not enabled. Name filters narrow this run and do not replace full acceptance.

Runner arguments follow the official [Node test runner](https://nodejs.org/api/test.html)
and [Bun test runner](https://bun.sh/docs/test) interfaces. This wrapper exposes provider
selection, listing and the shared `--test-name-pattern` option; it rejects unknown arguments.

## Installed-provider loopback acceptance

`pnpm test:providers:installed` runs Codex, Claude, OpenCode and OMP against local HTTP
fixtures with scratch homes and placeholder credentials. OpenCode and OMP also run their
`live.test.mjs` installed CLI checks: startup, empty sessions and queued-input recovery without
model calls. These filenames do not imply hosted authentication, which remains unverified.
The default run also checks active Codex and Claude turns across three daemon boots.
`pnpm test:providers:handoff` runs that joint check alone. It holds each local HTTP stream open
until the restarted daemon has reported its runtime inventory, then verifies the same agent,
runtime and native thread plus one completed user turn.
Use `--provider codex|claude|opencode|omp` to select one, or `--list` to inspect selection.
The ordinary deterministic gate does not launch these installed-provider checks.

Install workspace dependencies with pnpm. Install the provider executables separately; OMP uses
the workspace package. Codex also needs `pnpm build:backend` to supply debug daemon/runtime
binaries. The debug daemon uses a scratch file secret store. The command checks executables and
workspace dependencies before launching tests; missing prerequisites fail with an explicit
category and leave the selected providers unexecuted.

Each run writes `prerequisites.json`, a stage summary and bounded logs under
`test-results/runs/providers-installed-<id>/`. OpenCode and OMP retain native JUnit reports.
The existing Python Codex/Claude probes retain their command outcomes and JSON assertion
summaries in logs; they do not supply individual native test-case records. Failed assertions
remain failures, and the runner does not retry correctness checks.
