# contracts-scaffold

Status: returned
Type: slice evidence
Branch: claude/wf_3f97c965-a4e-2
Worker: ADE parallel build, Phase 0 foundation, contracts-scaffold
Requirements: none (foundation for D02)

## Outcome

`ade_core::contract` is now the single authority for wire contracts. It has one submodule per domain (`workspaces`, `conversations`) and a small `DOMAINS` registry. The `ade-contracts` binary prints a JSON Schema 2020-12 bundle. `pnpm contract:generate` turns the bundle into `packages/contracts`: the committed schema, TS types from json-schema-to-typescript, and Ajv standalone validators. `pnpm contract:check` fails on any drift and runs in `check:static` after rustfmt. The 4 daily-use operations and 2 feed frames are ported with the same wire shapes. The daemon handlers now decode and encode the typed structs. `@ade/client` uses `@ade/contracts` and keeps its public exports. The hand-written `protocol/daily-use.json`, its generator and `packages/client/src/generated.ts` are gone.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `catalog.get` | query | `CatalogGetRequest` | `CatalogFrame` |
| `conversation.get` | query | `ConversationGetRequest` | `ConversationSnapshot` |
| `agent.send` | effect command | `AgentSendRequest` | `Ack` |
| `agent.answer` | effect command | `AgentAnswerRequest` | `Ack` |

Feed frames: `catalog` (`CatalogFrame`) and `conversation_changed` (`ConversationChanged`).

Wire rules in the bundle:

- A request schema adds `op` as a const and closes the object (`additionalProperties: false`). The old client validator also rejected unknown request fields. The daemon still ignores them.
- Reply and frame schemas stay open to extra properties, as the old `additional: true` did.
- Integers are capped to ±(2^53 − 1), which matches the old `Number.isSafeInteger` check, and the Rust `format` names are dropped.
- Fields that the old contract typed as `unknown` stay unconstrained: `provider_config`, `content`, `review_feedback`, `rpc_id`, `params`, `answers` and the catalog `windows`.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, Clippy, legacy Rust tests)
- `pnpm contract:check`: pass. It fails when a generated file is edited by hand.
- In-process tests added: `crates/ade-core/src/contract/tests.rs`. These are schema round trips. Each typed value is serialized, validated against the generated schema with `jsonschema`, and deserialized back.
- E2E: not run, as the test policy requires.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 0 | 10 | 0 |

## References

- schemars 1.2.2 docs, `SchemaSettings` and `SchemaGenerator` (docs.rs). Pattern.
- Ajv 8 standalone code docs (ajv.js.org/standalone.html). Pattern.
- json-schema-to-typescript 16.0.0 README (GitHub). Pattern.
- `.scratch/parallel-build/research/04-wire-typing.md`: studied. It cites opencode-v2's `check:generated` drift pattern, which this slice follows. No reference-repo code was copied.
- None of the three tools publishes an llms.txt or agent guide.

## Open

- Behaviour change on malformed requests only. A request field with the wrong JSON type now fails with `Invalid request: <serde message>`. Before, it read as `Missing <field>`, or an invalid `limit` or `before` was silently ignored. A field that is absent or empty still gets `Missing <field>`. A missing `agent.send` `text` now reads `Missing text`, not `Missing prompt text`.
- `answers: null` on `agent.answer` now reaches the handler as absent. The fingerprint is unchanged.
- Schemars ignores `#[serde(tag)]` on structs. Tagged replies therefore carry the tag as a field with a one-value enum (`wire_tag!`).
- The `jsonschema` dev-dependency adds crates that `cargo metadata --offline` (the architecture check) needs. `scripts/worker-bootstrap.sh` now runs `cargo fetch --locked`. The main checkout needs one `cargo fetch --locked` before its next `check:static`.
- The packaged CLI now stages `@ade/contracts` next to `@ade/client` (`scripts/package-macos.mjs`, `electron-builder.yml`). This was not exercised, because packaging is E2E.
- Shared files: the `.scratch/ade-v1/decisions.md` D02 row could name `pnpm contract:generate` and `contract:check`. `THIRD-PARTY-NOTICES.md` needs no change, because no code was copied.
