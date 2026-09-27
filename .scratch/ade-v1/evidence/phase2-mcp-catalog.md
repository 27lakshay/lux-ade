# phase2-mcp-catalog

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-5
Worker: Phase 2 round B workflow, slice mcp-catalog
Requirements: F131 (advanced, not accepted); decision D14; architecture section 9

## Outcome

The profile now has one MCP catalog. It lives in the profile state database
(`sessions.sqlite`, table `mcp_servers`, created on first use with
`CREATE TABLE IF NOT EXISTS`; no numbered migration). Each entry records its
installation, transport configuration, credential references, workspace scope
and provider selection once. `mcp.resolve` turns the catalog into the native
configuration document for Claude Code, Codex or Oh My Pi, and names every
entry it leaves out with a reason.

No provider reads the projection yet. Every reply says `wired: false`, so a
caller cannot mistake the projection for what a provider actually loaded.

The pure core lives in `crates/ade-core/src/mcp.rs`, where provider adapters in
`ade-runtime` can read it: `validate_name`, `validate`, `applies` (scope
resolution), `project` (per-provider shape) and `resolve`. Storage and the
revision guard (`decide_update`) live in `crates/ade-daemon/src/sessions/mcp.rs`.

### Entry model

| Part | Shape |
|---|---|
| Name | 1 to 64 of `a-z 0-9 - _`; the entry's identity and the key in every provider's config |
| Installation | `manual`, `package {registry: npm/pypi/oci, identifier, version}` or `remote`. The version must be exact; ranges and tags are refused. ADE records it and installs nothing. |
| Transport | `stdio {command, args, env, cwd}`, `streamable_http {url, headers}` or legacy `sse {url, headers}` |
| Setting value | `{"literal": "..."}` or `{"env": "VARIABLE"}` |
| Scope | `profile`, `workspaces {workspace_ids}` or `repositories {repository_ids}` |
| Providers | `all` or `only {provider_ids}` |

### Fail-closed rules

- A literal value under a credential-like name (Authorization, Cookie, or a name
  containing token, secret, password, api_key, credential, private_key,
  access_key or auth) is refused. The caller must store an env reference.
- Arguments like `--api-key=x`, or `--token x`, are refused.
- URLs must use HTTPS, or plain HTTP to a loopback host. Embedded userinfo and
  credential-named query parameters are refused.
- `${` is refused in every stored string. Claude Code and Oh My Pi expand it,
  so it would mean different things in different providers.
- Unknown fields are refused (`deny_unknown_fields`), so a mistyped secret field
  cannot be stored silently.
- A scope that names an unknown workspace or repository is refused, except for
  IDs the stored entry already names.
- A stored row that no longer decodes fails the whole read. The catalog never
  reports a partial list.

### Provider projection

| Provider | Format | Delivery path (planned) | Refused when | Wired now |
|---|---|---|---|---|
| Claude Code (`claude`) | `claude_mcp_json`: `{"mcpServers": {...}}`, env refs as `${VAR}` | `--mcp-config` with `--strict-mcp-config` | `cwd` is set (no such field); a header references a variable Claude blanks in remote headers (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, `NPM_TOKEN`) | No (stub) |
| Codex (`codex`) | `codex_config_toml`: `{"mcp_servers": {...}}` as JSON for the TOML tables. `env` for literals, `env_vars` for references, `http_headers` or `env_http_headers` | `config.toml` in the account's `CODEX_HOME`, or `-c` overrides | legacy SSE; an env reference whose variable name differs from its key (`env_vars` forwards only under the same name) | No (stub) |
| Oh My Pi (`omp`) | `omp_mcp_json`: `{"mcpServers": {...}}` with `type`, env refs as `${VAR}` | `mcp.json` under the account's agent directory | a literal env or header value that starts with `!` (OMP runs it as a shell command) or is a bare variable name (OMP substitutes it) | No (stub) |
| OpenCode and others | none | none | always: `unsupported` | No |

Every projection is a direct provider configuration (`delivery: "direct"`). The
provider negotiates protocol version, capabilities and authorization with each
server on its one leg. ADE runs no gateway, so the both-leg negotiation in D14
does not apply yet.

### Protocol versions targeted

Checked on 2026-09-27 against modelcontextprotocol.io. The current revision is
**2026-07-28**. It defines the stdio and Streamable HTTP bindings and uses
per-request `_meta` version negotiation. The catalog records
`["2026-07-28", "2025-11-25", "2025-06-18"]`, because handshake-era servers are
still deployed. The legacy HTTP+SSE transport (2024-11-05) is modelled as `sse`
only because Claude Code and Oh My Pi still accept it. ADE itself speaks no MCP
in this slice.

## Operation tiers

| Operation | Tier | Why |
|---|---|---|
| `mcp.server.list` | query | |
| `mcp.server.inspect` | query | Returns the entry and each provider's native object or refusal reason |
| `mcp.server.add` | idempotent command | Creates revision 1. A repeat with the same definition returns the stored entry; a different definition is refused. |
| `mcp.server.update` | idempotent command | Guarded by `expected_revision`. A repeat after a lost reply converges when the stored entry is one revision ahead and equal to the request. |
| `mcp.server.remove` | idempotent command | Guarded by `expected_revision`. Removing an absent entry converges and reports `removed: false`. |
| `mcp.resolve` | query | Needs a known workspace and a known provider ID |

No effect commands: catalog writes change only profile configuration, launch
nothing and carry a revision guard. So no receipts are needed.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, JS pure tests, Clippy, legacy Rust tests 232/232)
- In-process tests added:
  - `crates/ade-core/src/mcp.rs`: 10 tests (names, credential refusal, URLs, installation and version rules, placeholders, scope resolution, per-provider projection, projection refusals, resolution order and exclusions, wire round-trip)
  - `crates/ade-core/src/contract/mcp.rs`: 2 tests (wire shapes, unknown secret field refused)
  - `crates/ade-daemon/src/sessions/mcp.rs`: 1 test (update revision guard)
- Verified only statically: the daemon handlers (SQLite storage, transactions,
  scope-ID existence checks, dispatch from `Sessions::command`) and the CLI
  `mcp` area. No daemon was started, and no request went over the socket.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- MCP specification, modelcontextprotocol.io/specification/versioning and /2026-07-28/basic/transports, fetched 2026-09-27: studied (protocol versions and transports)
- Claude Code docs, code.claude.com/docs/en/mcp, fetched 2026-09-27: studied (`.mcp.json` shape, `${VAR}` expansion, blanked credential variables, `--mcp-config`, `--strict-mcp-config`)
- Codex docs, learn.chatgpt.com/docs/extend/mcp, fetched 2026-09-27: studied (`[mcp_servers.<name>]` fields)
- Oh My Pi, github.com/can1357/oh-my-pi `docs/mcp-config.md` (main), fetched 2026-09-27: studied (file locations, `type` values, `!command` and bare-variable resolution of `env` and `headers`)
- Reference map row "MCP and skills (F131, F132)": OpenCode-v2 `packages/core/test/mcp.test.ts`, t3code `apps/server/src/mcp/McpSessionRegistry.test.ts`: not consulted. Both cover live MCP sessions and OAuth, which this slice does not build.
- No code was copied.

## Open

- **Adapter wiring.** Each provider adapter must read `mcp.resolve` at launch and pass the document: Claude via `--mcp-config` and `--strict-mcp-config`; Codex via the account's `config.toml` or `-c` overrides; Oh My Pi via its agent directory's `mcp.json`. Then set `WIRED_PROVIDERS`. Take care not to overwrite user-owned config files without adoption (D14).
- **Launch environment.** Env references assume the variable is in the provider's launch environment. ADE does not yet check that it is set, or supply it from a secret store. Keychain-backed references are not modelled.
- **Gateway.** There is no ADE-managed gateway, no both-leg negotiation and no OAuth.
- **Installation.** Package installation and verification (npm, PyPI, OCI) are recorded only.
- **Import.** Adopting servers from existing `.mcp.json` or `config.toml` files is not built.
- **Change feed.** Catalog changes emit no feed frame; no UI consumes one yet.
- **E2E later.** F131 acceptance needs E2E evidence: register a server, launch a real provider that loads it, and show the direct-provider fallback.
- **Heuristic limits.** Credential detection by key name can also refuse benign names, such as `AUTHOR` or `--no-auth VALUE`; this is fail-closed by design. An env value that begins with `!` would still run as a command under Oh My Pi's resolver; ADE cannot see values.
- **Shared files.** `crates/ade-daemon/src/sessions.rs` gained `mod mcp;` and one dispatch arm. `apps/cli/src/index.ts` gained an import, a usage entry and a command-area entry (three lines). `crates/ade-core/src/lib.rs` gained `pub mod mcp;`.
