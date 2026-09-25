# OpenCode protocol fixture provenance

`protocol-fixture.mjs` is an lux-ade-authored reduced schema fixture derived from
OpenCode API contracts. It does not contain the complete provider implementation.
The upstream MIT notice is retained verbatim in `LICENSE-opencode`; packaging
copies that file with this provider directory.

The evaluated checkout is `anomalyco/opencode` at
`2c369a21c976c190cfc3a9550d4c41c18a66ce52`. Verified matching contract sources:

- `packages/protocol/src/groups/session.ts`: session, prompt, interrupt, message,
  inbox and session form routes.
- `packages/protocol/src/groups/permission.ts`: session permission routes.
- `packages/schema/src/permission.ts`: `Permission.Reply` enum (`once`, `always`,
  `reject`).

Source: https://github.com/anomalyco/opencode/tree/2c369a21c976c190cfc3a9550d4c41c18a66ce52

The original fixture also records an installed v2.0.3 schema as input. Its `current`
switch deliberately covers two protocol shapes (`decision`/`reply`,
`resume`/`continue`, form DELETE/POST cancel). The original captured schema and
its checksum were not retained. The checkout pin above identifies the audited
reference, not proof of the installed binary's build revision. Preserve both
schema captures and their version/hash when updating these fixtures.
