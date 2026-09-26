# Workspace package scripts (F090)

Status: first package-script execution slice in review; full F090 remains open
Type: implementation ticket

## Contract

The profile daemon discovers valid visible scripts from a workspace root's
`package.json`. `script.list` reports the names and commands. `script.start`
executes a discovered name with `pnpm run` under the selected workspace and
returns a run identity. The Rust supervisor owns its process group, PTY and
bounded durable output. `script.inspect` reports observed runtime state and
bounded live/durable output; `script.stop` waits for verified process exit.
`script.runs` lists retained runtime runs. `script.retire` releases an exited
run and its spool so repeated use does not exhaust the runtime terminal limit.
The run's terminal membership is committed in the workspace before launch and
reconciled at daemon startup, so both running and exited runs survive daemon
handoff. All commands require an existing workspace ID and use the authenticated
public protocol.

## Acceptance and limits

- A real daemon discovers a workspace package script, runs it in that workspace,
  and observes its side effect and output. Another workspace cannot inspect it.
- A long-running script produces output, appears in the run catalogue, and an
  authenticated stop reports exit only after the supervisor observes it. A
  running run cannot be retired; an exited run can be retired and disappears.
- Restart only the daemon. The running script keeps its process and stop control;
  the exited script keeps its retained output. The supervisor identity is stable.
- With `ADE_PNPM_BIN` configured, launch from a stripped inherited `PATH` and
  observe a sibling `node` executable through the script's output.
- Discovered scripts currently come from the root `package.json` only. Other
  package managers, nested manifests and ADE-defined recipes remain open.
- A supervisor restart loses its in-memory run catalogue; durable output
  remains bounded by the existing service spool. The current interface does
  not expose an exit code. Descendants that deliberately leave the supervised
  process group are not verified or stopped. These limits prevent declaring
  all F090 complete.

Evidence: `e2e/specs/workspace-scripts.spec.ts` exercises public commands with
real ADE processes, including a daemon handoff and crash between runtime and
catalogue retirement. Focused run: 4/4 on macOS after the bundled-bin PATH
change. The PATH case uses a deterministic external pnpm/node fixture. The
packaged macOS app separately passed `e2e/packaged/macos.spec.ts`: the app
launched with a Finder-like `PATH`, ran a `node` package script through its
bundled pinned pnpm, and retained output after app reopen. The backend slice is
`c787274`, the CLI/Electron surface is `207ec62`, and packaging is `b365be1`.
Named CLI and hidden Electron flows passed
`e2e/specs/workspace-scripts-cli.spec.ts` and
`e2e/specs/desktop-scripts.spec.ts` in the 64/64 source suite. The 5/5 packaged
suite passed on Apple M4/macOS 26.6.1; all these checks use real ADE processes.
