# 09 — Make browser and Electron failures easy to reproduce

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** A developer can select a failing browser or desktop test, rerun it interactively and inspect both UI and daemon evidence.

**Blocked by:** [04 — Produce trustworthy test reports and fixture timings](04-reports-and-fixture-timings.md)

## Acceptance criteria

- [x] Add matching `@vitest/ui` as a desktop development dependency through pnpm, with explicit focused watch/UI commands that preserve the existing one-shot test command.
- [x] Document focused Playwright UI invocations for protocol and desktop suites; use useful named protocol steps and backend logs.
- [x] Keep terminal and machine-readable reports alongside optional HTML reports. Bound retained artifacts and provide a focused trace reproduction command.
- [x] Start and stop tracing on the actual manually launched Electron context, including failure teardown; do not assume the standard browser page fixture covers it.
- [x] Demonstrate diagnosis of a temporary browser failure and an Electron failure with retained trace/logs, then restore the deliberate defects.
- [x] Default CI and timing runs remain headless. Document existing React/Chrome profiling separately from uninstrumented latency measurement.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.


## Comments

### 2026-09-29 — Implementation and diagnostic evidence

Added exact `@vitest/ui` 5.0.2 as a desktop dev dependency, matching the installed Vitest.
Added focused `test:watch` and `test:ui` commands; the latter disables automatic browser
opening. The one-shot wrapper retains terminal/native JSON and adds optional HTML through
`ADE_TEST_HTML=1`. Playwright uses the same opt-in without opening reports automatically.
Reviewed official Vitest UI/llms.txt and Playwright context-tracing documentation before use.

pnpm initially produced a link missing its peer-qualified store target. A forced reinstall
did not repair the incorrect lockfile reference; `pnpm install --fix-lockfile --no-frozen-lockfile`
did. The final frozen-lockfile installation passes. No hand-written dependency link remains.

Electron fixtures explicitly start context tracing before acquiring the first window and stop
before quit, kill or teardown. Each launch has an archive. Default is off; `on` retains all,
`retain-on-failure` discards passing traces. Native retained trace content is capped at 100 MiB
per test; optional HTML creates another copy, giving at most 200 MiB of trace copies per test.
Intermediate source archives are removed after Playwright copies attachments. Collection
errors remain visible and fail an otherwise passing diagnostic run. Profile/process ownership
and normal hidden windows remain intact; headed windows require explicit opt-in.

Evidence:

- Three window tests, including restarts, passed with tracing on; five valid trace ZIPs were
  inspected (`desktop-df72c7be-7650-44d5-8970-df729056d5a9`).
- The deliberate Electron failure retained one native trace, its HTML copy, runtime log and
  operation log. After removal, all three window tests passed with no retained trace ZIPs.
  Final proof: `test-results/ticket09-trace-verified/evidence.json`, `failure.log`, `success.log`.
- A deliberate browser failure produced terminal output, failed native JSON and HTML:
  `test-results/ticket09-browser-report`. The temporary test was removed.
- The live UI loaded the focused 13-case file. A temporary assertion was selected and its
  source/expected/actual values inspected. Clicking `Run current test` reproduced the failure;
  restoring the original source triggered 13 passing cases. The watcher was stopped with SIGINT
  and its owned API listener closed. Screenshots and redacted logs: `test-results/ticket09-ui-proof`.
- Default desktop acceptance passed all seven cases with tracing unset:
  `desktop-97d85e2f-748b-402d-b91d-683e981f6cbd`.
- The diagnostic-correlation protocol case passed with named steps and optional HTML:
  `protocol-eb70505e-ca2c-4232-8820-a03d22aa5045`.

Documentation covers focused UI commands, trace/report inspection, backend logs and stopping
watchers before uninstrumented timing. React/Chrome application profiling remains a separate
workflow. No speed improvement is claimed from these diagnostic runs. Final static validation
is pending before ticket completion.

Final validation: `pnpm check:static` passed all 25 stages in `static-1f553820-ddd0-4206-9e74-961dc985bfb9` (55.57 seconds). `git diff --check` passes; deliberate probe files are absent and the original browser test and Codex mock have no diff. Ticket 09 is complete.
