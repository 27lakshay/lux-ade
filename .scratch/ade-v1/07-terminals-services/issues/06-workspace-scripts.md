# Workspace scripts (F090)

Status: supervised execution and output-coverage slices implemented; full F090 remains open
Type: implementation ticket

## Contract

The profile daemon discovers valid visible scripts from a workspace root's
`package.json` and checked-in `.ade/scripts.json` schema version 1. The ADE
manifest maps names to `{ program, args?, cwd? }` recipes with explicit argv
and workspace-relative directories. Discovery rejects duplicate names between
the manifests, malformed recipes and directories that escape through symlinks.
`script.list` reports the definitions. `script.start` executes a discovered
package name with the project's declared package manager or starts an ADE recipe directly under the selected workspace and
returns a run identity. The Rust supervisor owns its process group, PTY and
bounded durable output. `script.inspect` reports observed runtime state and
bounded live/durable output; `script.stop` waits for verified process exit.
Script run status separates successful exit, nonzero exit, signal termination
and unknown wait/reap outcome; the actual code or signal is retained.
`script.inspect` keeps execution status separate from `output_coverage`. Full
returned-output coverage requires a verified exit, no durable capture error or
gap, no spool retention overflow, matching producer/capture byte offsets, and a
tail starting at offset zero. A running process reports pending coverage until
capture loss is known, then incomplete coverage; a successful exit can also
report incomplete output. The public terminal tail
reports its retained start offset and retention overflow separately from a
caller-selected tail limit.
`script.runs` lists retained runtime runs. `script.retire` releases an exited
run and its spool so repeated use does not exhaust the runtime terminal limit.
The run's terminal membership is committed in the workspace before launch and
reconciled at daemon startup, so both running and exited runs survive daemon
handoff. All commands require an existing workspace ID and use the authenticated
public protocol.

## Acceptance and limits

- A real daemon discovers a workspace package script, runs it in that workspace,
  and observes its side effect and output. Another workspace cannot inspect it.
- A plain workspace with no `package.json` runs a checked-in ADE recipe with
  explicit argv and relative cwd, then reports actual exit code 0, nonzero
  code and signal termination. Duplicate names and symlink-escaping cwd fail.
- Two profile daemons opening the same physical checkout have distinct run
  identities; one cannot inspect or stop the other's run through its profile.
- A long-running script produces output, appears in the run catalogue, and an
  authenticated stop reports exit only after the supervisor observes it. A
  running run cannot be retired; an exited run can be retired and disappears.
- Restart only the daemon. The running script keeps its process and stop control;
  the exited script keeps its retained output. The supervisor identity is stable.
- With a Finder-like inherited `PATH`, resolve the applicable monorepo root's
  exact `packageManager`, lockfile, `.node-version`/`.nvmrc`, and `engines.node`.
  A child inheriting its root declaration succeeds; conflicting declarations
  fail before launch. Run installed npm, pnpm, Yarn, and Bun through real
  daemon processes. The ADE repository permits a checked-in root
  `.ade/scripts.json` while continuing to ignore its generated `.ade` files.
- A real recipe emits more than the 1 MiB durable spool. Inspection reports
  retention overflow and incomplete output while preserving its actual exit
  status and allowing stop and retirement.
- Discovery currently reads the opened workspace's `package.json` and
  `.ade/scripts.json` only. Nested package discovery remains open; opening a
  child package inherits its monorepo toolchain configuration.
- A supervisor restart still loses its in-memory run catalogue; durable output
  remains bounded by the existing service spool. The `unknown` state is
  surfaced when process reaping fails, but a lost supervisor does not yet
  preserve a durable interrupted run record for public inspection.
- Descendants that deliberately leave the supervised
  process group are not verified or stopped. These limits prevent declaring
  all F090 complete.

Evidence: `e2e/specs/workspace-scripts.spec.ts` exercises public commands with
real ADE processes, including a daemon handoff and crash between runtime and
catalogue retirement. Focused run after spool saturation: 7/7 on macOS,
including a plain workspace, nonzero and signaled exits, relative argv,
duplicate/escape rejection, two-profile isolation, and a successful process
that emits 1.3 million bytes while reporting incomplete retained output. Stop
and retirement still work after overflow. The old PATH case used a
deterministic pnpm/node fixture, and the old packaged app bundled ADE's pnpm.
The project-toolchain correction supersedes that behavior. Its focused source
E2Es run installed npm, pnpm, Bun and Yarn, verify monorepo inheritance under
a Finder-like PATH, and reject conflicting declarations. Packaged verification
remains required before closing the correction. `git check-ignore` confirms the root recipe manifest is
trackable while generated `.ade` content remains ignored. The backend slice is
`c787274`, the CLI/Electron surface is `207ec62`, and packaging is `b365be1`.
Named CLI and hidden Electron flows passed
`e2e/specs/workspace-scripts-cli.spec.ts` and
`e2e/specs/desktop-scripts.spec.ts` in the 64/64 source suite. The 5/5 packaged
suite passed on Apple M4/macOS 26.6.1; all these checks use real ADE processes.
