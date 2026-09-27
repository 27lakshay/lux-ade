# e2e-omp-mcp

Status: returned
Type: slice evidence
Branch: claude/wf_5d2276b8-0c2-1
Worker: ADE parallel build, slice omp-mcp
Requirements: F131 (advanced; acceptance is a coordinator decision, see "F131 acceptance")

## Outcome

Oh My Pi launches and resumes now receive the resolved profile MCP catalog, as
Claude and Codex already did. Oh My Pi takes MCP servers only from files, so
the bridge writes the resolution as the `.mcp.json` of an ADE-owned extension
package and names it with `--extension`. ADE never writes the user's
`mcp.json`. `mcp.resolve` and `mcp.inspect` now report Oh My Pi as
`wired: true`, with `delivery: direct`.

## How Oh My Pi takes MCP configuration

Checked against `@oh-my-pi/pi-coding-agent` 18.3.0, the version
`providers/omp` pins. The reference checkout is at 6ee309d, 2026-09-24.

- Oh My Pi has no RPC command, CLI flag or environment variable that carries
  an MCP server definition. The RPC protocol (`docs/rpc.md`) has none.
- It discovers servers from files (`docs/mcp-config.md`), in this order:
  native `.omp/mcp.json` and `~/.omp/agent/mcp.json`, then "OMP extension
  packages that declare MCP servers", then Claude Code, Codex and the others.
- An extension package named with `--extension <dir>` contributes its sibling
  `.mcp.json` (`docs/extension-loading.md`, "sibling capability roots from
  explicitly named extension packages";
  `docs/plugin-manager-installer-plumbing.md`). The source is
  `src/discovery/omp-plugins.ts`, provider priority 90, and `main.ts` →
  `injectOmpExtensionCliRoots`.
- That file keeps its server names as written. Discovery expands `${VAR}`
  placeholders the same way as in the native `mcp.json`, and the same
  pre-connect `env` and `headers` resolution follows. The existing
  `omp_mcp_json` projection, including its `omp_literals` guard, therefore
  applies unchanged.
- A package directory that holds no extension module loads no code
  (`loader.ts` `discoverExtensionPaths`), so ADE's package contributes only the
  `.mcp.json`.
- Verified against the real library: a scratch Bun script imported the
  installed 18.3.0 discovery code and loaded only the `omp-plugins` provider,
  under a scratch home. It returned both servers from the package, with names
  kept as written and `${FIXTURE_TOKEN}` expanded from the environment. It
  called no model and never started the Oh My Pi CLI.

Alternatives rejected:

- Writing `~/.omp/agent/mcp.json` or `.omp/mcp.json` edits user-owned files.
- `PI_CODING_AGENT_DIR` moves the whole agent directory.
- `--plugin-dir` prefixes every server name with `<plugin>:` and treats
  environment values differently.

## Changes

- `crates/ade-core/src/mcp.rs`: `WIRED_PROVIDERS` now includes `omp`.
- `crates/ade-runtime/src/omp.rs`: `configure_mcp` stores the `mcpServers`
  map, and `open` passes it to the bridge as `mcp_servers`. This covers the
  first launch and every resume, because the daemon resolves the catalog at
  each launch (`sessions/mcp.rs` `launch_servers`).
- `providers/omp/bridge.mjs` (`mcpExtension`):
  - It writes `<data>/omp/mcp/<sha256(session id)>/.mcp.json`, or the same
    path under the account home's `ade-sessions` for a managed account. The
    write is atomic, with mode 0600 in a 0700 directory.
  - It adds `--extension <dir>` to the launch arguments.
  - When no server applies, it removes the directory and adds no flag.
  - A path-like command such as `./tools/x` is resolved against the session's
    working directory. Oh My Pi would otherwise resolve it against the package
    directory, whereas a native `mcp.json` resolves it against the session's
    working directory.
- `providers/omp/mock-cli.mjs` (fixture Oh My Pi CLI): when
  `ADE_MOCK_OMP_DIR` is set, it records each launch's arguments and working
  directory in `calls.jsonl`. It also records the `.mcp.json` of each
  `--extension` package, exactly as written.

## Acceptance criteria

| Criterion part | Spec | Result |
|---|---|---|
| Register a server once; an Oh My Pi launch receives exactly the resolution: stdio and Streamable HTTP servers, scope, provider selection, disabled entries, and an ambiguous literal excluded as `unsupported` | `ops3/omp-mcp.spec.ts` first test | pass |
| Credentials go by reference (`${FIXTURE_TOKEN}`, `${FIXTURE_REMOTE_AUTH}`), never by value | same | pass |
| ADE writes its own package under the data directory; the repository and `~/.omp/agent/mcp.json` are left untouched | same | pass |
| Each workspace launches with its own resolution, in its own package | same | pass |
| A resume after a daemon crash (`restartDaemon('kill')`, disconnect, resume) opens the same native session with the current catalog | same | pass |
| No applicable server: no `--extension` flag; a catalog that empties before a resume removes the stale package | `ops3/omp-mcp.spec.ts` second test | pass |
| `mcp inspect` (CLI) reports Claude, Codex and Oh My Pi as wired | same, and `ops3/mcp-launch.spec.ts` third test (updated from `omp: false`) | pass |
| Explicit direct fallback: `delivery: direct` for Oh My Pi | first test, `mcp.resolve` | pass |

### F131 acceptance

The register asks for three things:

- register a server and expose it through compatible adapters, with "both-leg
  capability/auth handling";
- show an explicit direct-provider fallback "when a gateway cannot preserve
  semantics";
- (decision D14) "negotiate protocol versions, capabilities and authorization
  on both gateway legs".

All three adapters now expose the catalog. Every resolution reports
`delivery: direct`. ADE builds no MCP gateway, so there is no second leg:
each provider negotiates protocol version, capabilities and authorization with
the server itself, on its single connection. No spec can observe "both-leg"
handling, because no code implements it. The fallback is not triggered by a
gateway failing to preserve semantics; direct delivery is the only mode.

Whether direct delivery for every provider meets the criterion is the
coordinator's call. The alternative is to rule the gateway leg out of scope in
`decisions.md`. I do not claim F131 as accepted.

## Operation tiers

No operation was added. `mcp.resolve` (query) and `mcp.server.inspect` (query)
now report `wired: true` for `omp`. The contract shape is unchanged, so no
contract regeneration was needed.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3 e2e/protocol/catalogs`: 43 passed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/ops3/omp-mcp.spec.ts --repeat-each 4`: 8 passed.
- `pnpm check:static`: pass (810 Rust tests).
- `bun test bridge.test.mjs` in `providers/omp`: 5 passed.
- In-process tests added: none.
- Machine safety: nothing here calls the Security framework, the `security`
  tool or `hdiutil`. The discovery check loaded only the extension-package
  provider. `pgrep` found no `ade-daemon`, `ade-runtime` or `security` process
  from this worktree afterwards.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 10 | 15 | 5 |

## References

- oh-my-pi @ 6ee309d (2026-09-24) `docs/mcp-config.md`, `docs/extension-loading.md`, `docs/plugin-manager-installer-plumbing.md`, `docs/cli-reference.md`, `docs/rpc.md`: studied.
- `@oh-my-pi/pi-coding-agent` 18.3.0 `src/discovery/omp-plugins.ts`, `omp-extension-roots.ts`, `claude-plugins.ts`, `substitute-plugin-root.ts`, `extensibility/extensions/loader.ts`, `main.ts`: studied.

## Open

- Precedence differs by provider. In Oh My Pi, the user's native `mcp.json`
  entries rank above extension packages, so a user server with the same name
  as a catalog entry wins, and ADE's entry is shadowed. For Codex, ADE's
  per-server override wins over the user's `config.toml`. The spec does not
  cover a name clash.
- Two other Oh My Pi behaviours can also drop a catalog server:
  - it shadows a differently named server whose transport and command match
    a higher-priority definition;
  - while its built-in browser is enabled, it silently drops browser-automation
    servers (such as `playwright`).
  ADE cannot observe either, so it reports neither.
- A package directory stays behind when a Conversation is never launched
  again. Its size is bounded (one small file per native session), and it
  contains only references, never credential values. It is not covered by
  retention.
- The live `@oh-my-pi` CLI was not started. The mechanism was checked against
  the installed library's discovery code and by the fixture CLI.
