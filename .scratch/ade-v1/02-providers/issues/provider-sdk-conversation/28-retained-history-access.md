# 28 — Retain access to history after provider removal

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Read, search, export and back up retained conversations when their provider is removed or unavailable, without claiming unsupported execution continuity.

**Blocked by:** [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC17, PC22, PC29. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Retained core envelopes and registered blobs remain readable without native executable, credentials or custom renderers.
- [x] Integrate existing search/export/backup paths with the new content and history boundaries; do not duplicate stores or broaden unrelated backup scope.
- [x] Imported or restored histories disclose whether native resume is supported and retain lineage/source identity; readability alone cannot authorize native execution.
- [x] Exports and backups disclose missing, expired, native-private or unregistered plugin data. Current-format restore follows D19 without prelaunch compatibility shims.
- [x] Inspect and export bounded retained content through public APIs and desktop controls with explicit unavailable/missing distinctions.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Remove or make unavailable a provider, then read/search/export and round-trip registered retained data through real processes and built desktop; assert omitted-data disclosure.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

What existed: retained messages, search and the managed backup (F050, `e2e/protocol/backup`) read without a provider; imported native histories are read-only and refuse resume; a CLI export (`ade-conversation-history-v1`, newest first, built on `conversation.get` pages).

Decisions and changes:
- New query `conversation.export`: one bounded page (at most 32 messages, cut to a 4 MiB reply budget, never empty) of retained messages oldest first, each with its attachments' payload state (`live`, `reclaimed`, or `missing`), plus a continuity disclosure: whether the provider is installed in this profile, the recorded native session, whether native resume is possible (never for imported histories), and the reason; what the export does not include (native history ADE never retained, private reasoning). Pages carry `boot_id`, `revision` and `history_epoch` so a reader detects a history that changed.
- One export writer in the SDK (`@ade/client/export`), used by the CLI `conversation export ID FILE` and the desktop. Under D19 the file format is now `ade-conversation-export-v1` (oldest first, `continuity` header, message entries with attachment state); the old format is not kept. The writer still never overwrites, leaves no partial file, and refuses a history that changes while it reads.
- Desktop (provisional): "Export conversation" saves through a native save dialog.
- `scripts/api-parity.mjs` exempts `conversation.export` from a literal CLI call, with the reason: the CLI reaches it through the SDK writer.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-4406d299-b04a-4620-aa33-8dc090099526`).
- Real processes: `ops3/export.spec.ts` 2/2 (260 messages across pages, oldest first; imported history disclosed as read-only; no overwrite; durable after a daemon crash; a changing history is refused with no file left); `adapters/plugin-providers.spec.ts` (after a provider plugin is uninstalled, the export reads the history and says the provider is not installed and nothing can continue it).
- Built Electron: `e2e/desktop/export.spec.ts` (`test-results/runs/desktop-a8d640d2-a9dd-405a-a2cc-68c9d91cbed0`).

Not covered: plugin-private data in backups beyond the existing backup disclosures; a desktop view of export contents (the file is the deliverable).
