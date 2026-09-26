# Research: how wire messages are typed today, and which schema tool fits

Ticket: [04-wire-typing](../issues/04-wire-typing.md) · Researched 2026-09-27 · Research only; no code was changed.
Code read at `aae7cf3` (`codex/architecture-proposal`) in the `claude-parallel-build` worktree.

## Answer

- **No operation has a typed request or response today.** Every one of the 96 daemon
  operations is dispatched on `request["op"]` as a `serde_json::Value`. Handlers read fields
  one at a time (`request["x"].as_str()`) and build replies with `json!`. Only nested
  payloads (about 45 `ade-core` model types such as `WindowRecord`, `Attachment` and
  service `Config`) are serde-derived.
- **Framing is newline-delimited JSON, not length-prefixed.** One JSON object per `\n`
  line on a Unix socket. Requests are capped at 128 KiB (12 MiB for `attachment.put`);
  replies at 32 MiB.
- **The TypeScript side has almost no response validation.** `packages/client` validates
  only `hello`, `catalog` and `conversation_changed` frames. The rest is `as` casts in the
  renderer and ad hoc `typeof` checks in Electron main. Each operation's shape is written
  by hand 2–3 times; none of those copies is generated.
- **Recommendation: Schemars as the single authority.** Derive `JsonSchema` on typed
  request and response structs, commit the generated JSON Schema into `packages/contracts`,
  generate TS types with `json-schema-to-typescript`, and generate runtime validators with
  Ajv standalone code. A regenerate-and-`git diff --exit-code` step is the drift check.
  It is the only option that gives one schema, TS types and TS runtime validation from
  stable, maintained tools, which is what D02 asks for.
- **Rust handlers must move from `Value` to typed structs first.** No tool can describe a
  `json!` literal. Migration: about 96 operations, about 74 response `type` tags, and
  roughly 150–250 new Rust types, across about 9 domains. Wire bytes do not change, so the
  existing E2E suite is the regression net. See [Migration size](#migration-size).

## What is uncertain

- **Option and `required` details in Schemars 1.x were not confirmed from the docs.** The
  docs confirm `Option<T>` becomes `anyOf [T, null]` and that a `contract` setting
  (default `Deserialize`) switches between serialize and deserialize schemas. Whether an
  `Option` field without `#[serde(default)]` is left out of `required` in each contract
  needs a short spike on real ADE types.
- **The u64 output format is from memory.** I recall Schemars emits
  `{"type":"integer","format":"uint64","minimum":0}`, and Ajv in strict mode rejects
  unknown formats. The spike must confirm this and register the formats, or strip them with
  a Schemars transform.
- **`json-schema-to-typescript` output quality for internally tagged unions is untested
  here.** It turns `oneOf`/`anyOf` into TS unions, but the exact output for `$defs` and
  `const` tags must be checked on real ADE schemas.
- **Operation counts are lower bounds.** I counted string literals. The CLI and desktop
  sometimes pass `op` through from a variable, so a few call sites may be missed.
- **typeshare's 64-bit rule comes from an issue and my memory of its behaviour, not the
  current book.** The book pages I fetched did not state it.

## Current wire protocol

### Transport and framing

| Link | Framing | Limits | Source |
|---|---|---|---|
| Client (CLI, Electron main, GPUI) → daemon command socket | NDJSON: one JSON object per `\n` line | Request 128 KiB, `attachment.put` 12 MiB; replies ≤ 32 MiB | `crates/ade-daemon/src/bin/daemon/server.rs` `read_request`, `handle_connection`; `packages/client/src/request.ts` |
| Client → `session.subscribe` event stream | Same socket, NDJSON frames with `boot_id` and a gap-free `revision` | 32 MiB per frame | `server.rs` L820; `packages/client/src/index.ts` `applyFrame` |
| Client → terminal stream (any op without a `.`) | Daemon writes the first line to the runtime and then copies bytes both ways without parsing | 32 MiB | `server.rs` L920–940; `crates/ade-runtime/src/bin/supervisor/terminal_host.rs` |
| Daemon → runtime supervisor | NDJSON (`read_frame` / `write_frame`) | `MAX_CONTROL` | `crates/ade-runtime/src/runtime.rs` L31–48 |

Each client connection starts with `{"op":"hello"}`. The TS client then requires
`application_protocol == "ade-application-v1"` and `session_protocol == "ade-sessions-v1"`
before it sends the real request (`request.ts` L88). Errors come back as
`{"type":"error","code"?,"message"}` via `ade_core::error::error_envelope`.

### Protocol version strings

| String | Where set | Who checks it |
|---|---|---|
| `ade-application-v1` | `ade-core/src/protocol.rs` (and duplicated in `ade-runtime/src/runtime.rs` and `ade-daemon/src/bin/control/main.rs`) | TS client, control binary |
| `ade-runtime-v8` | Same three places | Daemon ↔ runtime, control binary |
| `ade-sessions-v1`, `ade-worktrees-v1`, `ade-review-v1` | Literals in the daemon `hello` (`server.rs` L843) and the terminal host `hello` | TS client checks only `ade-sessions-v1` |
| `daemon-v1` | `response_owner` in the daemon and terminal-host `hello` and in snapshots | GPUI client (`terminal_stream.rs`) |
| `ghostty-snapshot-v1-herdr-9c96f7d`, `xterm-replay-v1` | Terminal snapshot formats in `hello` | Terminal clients |
| `ade-review-feedback-v1`, `ade-discard-v1`, `ade-conversation-history-v1` | Payload format tags | Review and export code |

The version strings are literals repeated in 3–5 files, not one constant.

### Dispatch

`handle_connection` in `server.rs` reads `op`. It then:

1. Handles `runtime.prepare_restart`, `runtime.status` and `session.subscribe` itself.
2. Handles `hello`, `service.proxy.*` (8), `terminal.stop|retire|restart` and `browser.*` (5)
   in an `if`/`else if` chain.
3. Hands every other dotted op to `Sessions::command` (`sessions.rs` L778). That function
   applies prefix-based guards (`worktree.`, `review.`, `file.`, `script.`, `service.`,
   `agent.`) and then either forwards the request to `Worktrees::command`,
   `Review::command`, `Files::command` or `scripts::command`, or matches it in one large
   `match` (47 arms).
4. Streams any op without a dot to the runtime as a terminal connection.

The runtime supervisor (`crates/ade-runtime/src/bin/supervisor/server.rs`) has its own
string `match` blocks for control (`proxy.*`, `terminal.*`, `owner.*`), agent
(`agent.*`) and connection (`hello`, `runtime.stop`, `owner.claim`, `terminal.connect`)
operations.

### Operation count

| Surface | Ops | Examples |
|---|---|---|
| Daemon, handled in `server.rs` | 20 | `hello`, `runtime.status`, `session.subscribe`, `service.proxy.*`, `terminal.restart`, `browser.inspect` |
| Daemon, `sessions.rs` match | 47 | `account.*`, `agent.*`, `attachment.*`, `draft.*`, `queue.*`, `service.*`, `workspace.*`, `window.*` |
| Daemon, `review.rs` | 10 | `review.status`, `review.diff_page`, `review.commit`, `review.feedback.search` |
| Daemon, `worktrees.rs` | 10 | `worktree.adopt`, `worktree.switch`, `worktree.remove`, `worktree.rebind` |
| Daemon, `scripts.rs` | 6 | `script.start`, `script.inspect` |
| Daemon, `files.rs` | 3 | `file.list`, `file.search`, `file.preview` |
| **Daemon public total** | **96** | |
| Terminal stream (runtime `terminal_host.rs`) | ~8 | `subscribe`, `input`, `resize`, `ping`, `snapshot_binary` |
| Runtime supervisor (daemon ↔ runtime only) | 28 | `proxy.ensure`, `terminal.ensure`, `agent.events`, `owner.claim` |
| Distinct response `"type"` tags built with `json!` (daemon + runtime) | 74 | `catalog`, `conversation_snapshot`, `ack`, `browser_owner` |

Consumers of the 96 daemon ops: the TS CLI uses 45, desktop uses 62, and 34 are used by
both. The legacy GPUI client uses 42. 75 are used from TypeScript.

### Typed versus `Value`

- **Requests: 0 of 96 typed.** No op deserializes into a request struct. A few handlers
  deserialize one nested field with `serde_json::from_value` (`service.configure` config,
  `worktree.configure` config, `window.save` window, `agent.send` attachments).
- **Responses: 0 of 96 typed envelopes.** All are `json!({"type":…, …})`. Many embed
  serde-derived `ade-core` records (`Conversation`, `WindowRecord` and so on). `json!` call
  counts: `sessions.rs` 122, `worktrees.rs` 28, `server.rs` 31, `scripts.rs` 26,
  `review.rs` 17, `files.rs` 8; runtime crates about 180 more.
- **Serde-derived types that exist: about 45 in `ade-core`.** They already use the forms a
  schema tool must handle: `#[serde(tag = "type")]` and `#[serde(tag = "kind")]` internal
  tagging, `skip_serializing_if = "Option::is_none"`, `#[serde(default)]` and
  `deny_unknown_fields`.

### Serialization hazards found

| Hazard | Where |
|---|---|
| Internally tagged unions (`type`, `kind`) | Every response envelope, transcript and provider events, script specs |
| Absent versus `null` | `Workspace.repository_id` arrives as absent or `null`; the TS parser maps both to `null`. `Conversation.account_id` keeps absent separate from `null`. |
| u64/i64 as JSON numbers | `runtime_cursor`, `generation`, `credential_id` (u64), `revision`, `sequence`, `updated_at` (i64), `agent.events` cursors. All are small in practice; nothing enforces < 2^53. TS has 42 hand `Number.isSafeInteger` checks. |
| Bytes in 3 encodings | Base64 strings (`terminal_snapshot_base64`, `bytes_base64`, `attachment.put` `data`); decimal byte arrays (`terminal_snapshot_bytes`, terminal `input.bytes: number[]`), kept for compatibility (`ade-core/src/protocol.rs` `decode_snapshot`) |

### How the TS side parses

| File | Request side | Response side |
|---|---|---|
| `packages/client/src/request.ts` | `requestDaemon(socket, op: string, fields: Record<string, unknown>)` with no per-op types | Checks only that `type` is a string and that errors are shaped right; returns `Record<string, unknown>` |
| `packages/client/src/index.ts` | — | 4 hand parsers (`parseWorkspace`, `parseConversation`, `parseCatalog`, `eventPosition`) for the subscription feed only |
| `apps/desktop/src/main/index.ts` | 37 `requestDaemon` calls. Hand-built allow-lists and field validators per IPC channel (94 `typeof` checks), for example `ade:script-request` | Mostly passed to the renderer unchanged |
| `apps/desktop/src/renderer/src/*.tsx` | Loose objects through `window.adeHost.request*` | 54 local `interface`/`type` declarations and about 44 `as` casts, for example `as ReviewStatus`; 33 `typeof` checks |
| `apps/cli/src/index.ts` | 58 `requestDaemon` calls with hand-built fields and argument parsers | Mostly printed as JSON; 35 `typeof` checks |

**Hand-written copies per operation:** a typical op used by both CLI and desktop has its
request shape written 3 times: the Rust field reads, the CLI builder and the desktop-main
validator. Its response shape is written 1–2 times: a renderer `interface` plus
occasional `typeof` checks. Only 3 frame types, not operations, have a real validating
parser. Nothing in CI checks that these copies agree.

## Tool comparison

All four tools read `#[serde]` attributes. Versions and dates come from crates.io and npm
on 2026-09-27.

| | ts-rs | Schemars → JSON Schema → TS + validator | typeshare | specta |
|---|---|---|---|---|
| Version / licence | 12.0.1 (2026-01-31), MIT | schemars 1.2.2 (2026-07-27), MIT; json-schema-to-typescript 16.0.0 (2026-08-28), MIT; Ajv 8.20.0 (2026-04-24), MIT | typeshare 1.0.5 (2026-01-02), CLI 1.13.4 (2025-12-11), MIT OR Apache-2.0 | specta 2.0.0-rc.25 (2026-05-07; stable is 1.0.5), specta-typescript 0.0.12, MIT |
| Maintenance | Active; last commit 2026-08-30; 30 open issues | Very widely used (177 M recent downloads); last commit 2026-07-27; 122 open issues | Last commit 2026-01-02; 92 open issues | Very active; last commit 2026-09-22; 2.0 has been in release candidates for months |
| Output | `.ts` types only | A language-neutral schema file, then TS types and validators | TS/Swift/Kotlin types | TS types; Zod and JSON Schema exporters marked "partial" |
| Tagged unions | `tag`, `content`, `untagged` supported | `tag`, `content`, `untagged` supported; emitted as `oneOf` | Algebraic enums need adjacent tagging (`tag` + `content`). **The internally tagged `{"type":…}` envelope that ADE uses everywhere does not fit.** | Supported through `specta-serde` |
| Optional vs null | `Option<T>` → `T \| null` by default; `#[ts(optional)]` → `t?: T`; `optional = nullable` → `t?: T \| null` | `Option<T>` → `anyOf [T, null]`; required-ness follows serde defaults and a serialize/deserialize `contract` setting | `Option<T>` → optional field | Supported; less documented |
| u64 / large ints | Emits `bigint` by default (`TS_RS_LARGE_INT`); `JSON.parse` never yields a bigint, so ADE must set `number` or override per field | JSON Schema `integer` (+ `format`, `minimum`). TS sees `number`. A range cap can be added with a transform. | Rejects 64-bit types unless `serialized_as` or a type mapping is given ([issue #24](https://github.com/1Password/typeshare/issues/24)) | **Fails the export by default** (`BigIntExportBehavior`); you choose `number` or `bigint` explicitly |
| Bytes | `Vec<u8>` → `Array<number>`; override with `#[ts(type = "string")]` for base64 | `Vec<u8>` → integer array; override with `#[schemars(with = "String")]` or `schema_with` | Needs `serialized_as` | Override via specta attributes |
| TS runtime validation | **None** | **Yes**: Ajv standalone (draft 2020-12) or Zod `z.fromJSONSchema()` (experimental) | **None** | `specta-zod` 0.0.3, partial |
| CI drift check | Export runs as a `cargo test` side effect (`#[ts(export)]`, `TS_RS_EXPORT_DIR`), then `git diff --exit-code` | A small `cargo run` exporter, then the TS generators, then `git diff --exit-code`. The schema file itself is a reviewable contract artifact. | Run the CLI, then `git diff` | Exporter binary, then `git diff` |
| Agent guidance | No llms.txt or AGENTS.md found | No llms.txt; Zod has [llms.txt](https://zod.dev/llms.txt) | None found | [specta.dev/llms.txt](https://specta.dev/llms.txt) and a repo [AGENTS.md](https://github.com/specta-rs/specta/blob/main/AGENTS.md) |
| Main cost for ADE | Types only, so D02's runtime validation still needs a second tool or hand guards | Two npm dev deps plus one Rust dep; generated TS types are plainer than ts-rs output; format handling needs a spike | Cannot express ADE's envelopes without changing the wire format | Pre-1.0 exporters and an RC core; the validator path is partial |

### Reference: how opencode-v2 and t3code do it

- **opencode-v2** (`packages/client/script/build.ts`) inverts the direction. The
  authority is an Effect `HttpApi` plus Effect Schema in `@opencode/protocol` and
  `@opencode/schema`. Its private `@opencode/httpapi-codegen` has three steps:
  `compile(ClientApi)` reflects the API into a contract, `emitPromise` generates a
  zero-dependency Promise client, and `emitEffect*` generates a rich Effect client with
  runtime schemas. Generated source is committed. `check:generated` regenerates and runs
  `git diff --exit-code`. The README states the rule: "Commit generated source for
  review; CI regenerates and fails when the worktree changes." ADE should copy this drift
  pattern, not the Effect authority, because ADE's authority is Rust and the plan says the
  public SDK must not require Effect.
- **t3code** `packages/contracts` defines 144 `Rpc.make` operations in Effect Schema
  (`src/rpc.ts`), with reusable refinements such as `NonNegativeInt` and `PortSchema`.
  It is a good model for a per-operation input/output/error contract, but its server is
  TypeScript, so it has no cross-language step.

## Recommendation

**Schemars as the single authority, with generated TS types and Ajv validators, committed
and diff-checked.**

1. Add a `contracts` module or crate in Rust. Per operation, add a
   `#[derive(Serialize, Deserialize, JsonSchema)]` request struct. Collect the requests in
   one `#[serde(tag = "op")] enum Request` with the current dotted names via `rename`, so
   the wire bytes do not change. Add one `#[serde(tag = "type")] enum Response` over the
   74 response tags.
2. Add `JsonSchema` to the existing `ade-core` model types.
3. An exporter binary writes `packages/contracts/schema/*.json`: request schemas with the
   deserialize contract and response schemas with the serialize contract. It also writes
   an operation map (op → request schema, response schema, protocol version).
4. `json-schema-to-typescript` generates `.d.ts`. Ajv standalone generates plain-JS
   validators, so the SDK has no runtime schema compiler and no framework dependency.
   `requestDaemon` becomes `request<Op>(op, input: Input<Op>): Promise<Output<Op>>` and
   validates every reply.
5. Encode wire rules once. u64/i64 get `maximum: 2^53−1` through a Schemars transform,
   with a matching serialize-time check in Rust. Genuinely unbounded values become
   strings. Bytes use a `Base64` newtype that emits `type: string, contentEncoding: base64`.
   The legacy decimal byte arrays stay as a documented compatibility variant.
6. `pnpm contracts:check` regenerates and runs `git diff --exit-code`. It is a static
   check under the E2E-only rule, as the map's standing choice allows.

**Trade-offs.**

- *For:* one schema that remote clients, plugins and compatibility fixtures can read (D02,
  D13); the only stable path to runtime validation; Schemars is the most used and
  best-maintained of the four.
- *Against:* TS types are plainer than ts-rs output, for example no per-field `?:`
  versus `| null` control beyond what the schema says. Ajv strict mode needs the integer
  formats handled. There are three generator steps instead of one.
- **Fallback if the spike finds poor TS output:** derive both `TS` (ts-rs, with
  `TS_RS_LARGE_INT=number`) and `JsonSchema` on the same structs. ts-rs then produces the
  types and Schemars → Ajv produces the validators. Both read the same serde attributes, so
  there is still one Rust authority; the cost is two derives per type.
- **Rejected:** typeshare cannot express the internally tagged envelopes. specta's
  validator exporters are partial, and its core is still a release candidate.

## Migration size

| Work | Size | Notes |
|---|---|---|
| Rust request structs | ~96 (fewer where ops share shapes, such as `queue.*` and `account.inspect|verify`) | Each replaces 2–8 `request["x"].as_…()` reads. Field validation such as ranges and ID syntax stays in handlers or moves to `garde`/`validator` attributes, which Schemars reads. |
| Rust response types | ~74 envelope variants plus about 20–40 nested payloads now built inline with `json!` | Replaces ~230 `json!` sites in the daemon |
| Existing `ade-core` types | ~45 | Add `JsonSchema`; check `Option` and default behaviour |
| Subscription and terminal frames | ~8 terminal ops plus the `session.subscribe` event variants | Same pattern |
| Runtime supervisor protocol (28 ops) | Optional for D02 | Rust ↔ Rust only; type it later with shared structs; no TS generation needed |
| TS consumers | 95 `requestDaemon` calls (desktop 37, CLI 58); ~54 renderer type declarations and ~44 casts; ~170 hand `typeof` checks | Replace with generated types and validators. Keep IPC-boundary input checks in Electron main, reusing the generated validators. |

**Yes: handlers must move from `Value` to typed structs first**, at least at the
boundary. A handler can deserialize into its struct and keep its internal logic at first.
The work splits along the existing module seams into about 9 domain slices: sessions/agent/draft,
account/provider, attachment/queue, service/listener/proxy, review, worktree, file,
script, and browser/runtime/terminal. Plus 1 setup slice for the exporter, generator and
drift check. Two shared points will cause merge conflicts in parallel work: the central
`Request`/`Response` enums and the generated output. Mitigate this with per-domain enums
and per-domain generated files (input to [05](../issues/05-hot-file-seams.md) and
[09](../issues/09-schema-tool.md)).

## Sources

- Code: `crates/ade-daemon/src/bin/daemon/server.rs`, `crates/ade-daemon/src/{sessions,review,worktrees,files,scripts}.rs`,
  `crates/ade-core/src/protocol.rs`, `crates/ade-runtime/src/runtime.rs`,
  `crates/ade-runtime/src/bin/supervisor/{server,terminal_host}.rs`, `packages/client/src/*.ts`,
  `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/*.tsx`, `apps/cli/src/index.ts`
- Plans: `docs/monorepo-initialization-plan.md` ("Wire schemas | Evaluate ts-rs and Schemars"; stage 2 audit list), `.scratch/ade-v1/decisions.md` D02
- References: `/Users/lakshyakumar/work/ade-evaluation-2026-09-24/opencode-v2/packages/client/script/build.ts`, `…/opencode-v2/packages/httpapi-codegen/README.md`, `…/t3code/packages/contracts/src/rpc.ts`
- ts-rs: [docs.rs crate root](https://docs.rs/ts-rs/latest/ts_rs/), [TS trait attributes](https://docs.rs/ts-rs/latest/ts_rs/trait.TS.html), [README](https://github.com/Aleph-Alpha/ts-rs)
- Schemars: [docs](https://graham.cool/schemars/), [attributes](https://graham.cool/schemars/deriving/attributes/), [SchemaSettings](https://docs.rs/schemars/latest/schemars/generate/struct.SchemaSettings.html)
- typeshare: [book](https://1password.github.io/typeshare/), [README](https://github.com/1Password/typeshare), [issue #24 (i64/usize)](https://github.com/1Password/typeshare/issues/24)
- specta: [README](https://github.com/specta-rs/specta), [specta-typescript docs](https://docs.rs/specta-typescript/latest/specta_typescript/), [BigIntExportBehavior](https://docs.rs/specta-typescript/latest/specta_typescript/enum.BigIntExportBehavior.html), [llms.txt](https://specta.dev/llms.txt), [AGENTS.md](https://github.com/specta-rs/specta/blob/main/AGENTS.md)
- Zod: [JSON Schema page (`z.fromJSONSchema` is experimental)](https://zod.dev/json-schema), [llms.txt](https://zod.dev/llms.txt)
- Versions and dates: crates.io API and the npm registry, queried 2026-09-27; repository activity from the GitHub API.
