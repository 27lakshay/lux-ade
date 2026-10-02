# OpenCode plugin provenance

This plugin is ADE-authored. It talks to OpenCode v2 over OpenCode's own HTTP/SSE API and
copies no OpenCode implementation code. The upstream MIT notice is retained verbatim in
`LICENSE-opencode` because the reduced schema fixture below is derived from OpenCode's
API contracts; packaging ships that file with the plugin.

## Origin of each part

| Part | Origin |
|---|---|
| `src/native/transport.mjs`, `session-api.mjs`, `transcript.mjs`, `text-stream.mjs` | Moved from ADE's former bundled adapter (`providers/opencode`, removed with this plugin). ADE-authored against the OpenCode API. |
| `src/native/engine.mjs` | ADE-authored; derived from the former bundled `providers/opencode/bridge.mjs`, rewritten for the public provider worker contract. |
| `src/native/tool.mjs` | Copy of ADE's `providers/tool.mjs` tool-content shape, so the artifact is self-contained. |
| `src/*.ts` | ADE-authored Effect service, worker and Promise/AsyncIterable client over `@ade/provider-sdk`. |
| `test/fixtures/protocol-fixture.mjs` | ADE-authored reduced schema fixture derived from OpenCode API contracts (see below). |
| `test/fixtures/mock-opencode.mjs`, `fixture.mjs` | ADE-authored deterministic OpenCode servers for tests; not shipped. |

## Audited OpenCode sources

The reduced fixture was derived from `anomalyco/opencode` at
`2c369a21c976c190cfc3a9550d4c41c18a66ce52`:

- `packages/protocol/src/groups/session.ts`: session, prompt, interrupt, message, inbox and
  session form routes.
- `packages/protocol/src/groups/permission.ts`: session permission routes.
- `packages/schema/src/permission.ts`: `Permission.Reply` enum (`once`, `always`, `reject`).

Source: https://github.com/anomalyco/opencode/tree/2c369a21c976c190cfc3a9550d4c41c18a66ce52

The text-fragment numbering used by `transcript.mjs` (a `session.text.*` event's `ordinal`
counts text fragments of one assistant message, separately from reasoning and tools) was
checked against the study copy of OpenCode v2 at `7ef4a1a`
(`packages/core/src/session/runner/publish-llm-event.ts`, `fragments`) and against a live
OpenCode 2.0.22 transcript. No code was copied.

## Installed schema captures

- OpenCode v2.0.3: the original fixture input. Its captured schema and checksum were not
  retained.
- OpenCode v2.0.22 (`~/.opencode/bin/opencode`, executable sha256
  `af29b0b1b0291dbf2471c66c89d2e055b6afa9c41a950e052fa609c3295e2a75`): `GET /openapi.json`
  from `opencode serve --stdio` with scratch configuration, re-serialized with
  `JSON.stringify(spec, null, 1)`, sha256
  `e1a95887547bb239ad03550b2c1f91fd4eb40557d33350f6fc3d4c82a16f72ac` (432,535 bytes). The
  plugin's contract check (`protocol()` in `session-api.mjs`) selects `decision`, `resume`
  and form `DELETE` for this version.

The fixture's `current` switch covers both protocol shapes (`decision`/`reply`,
`resume`/`continue`, form DELETE/POST cancel). Preserve each schema capture and its
version and hash when updating these fixtures.
