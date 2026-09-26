# Export complete conversation history through the CLI

Status: history export implemented; F050 backup remains open
Type: implementation ticket
Owner: ADE v1 coordinator
Requirements: F050 (readable history export slice)
Dependencies: durable conversation messages and paginated `conversation.get`

Problem: `conversation inspect` returns only the latest 50 messages. A user cannot
retain a complete, human-readable conversation through the public CLI.

Outcome: `ade --socket PATH conversation export ID FILE` creates a new JSON file
containing conversation metadata and all persisted messages. The CLI reads
bounded pages, preserves structured message content and native provenance,
checks identity, ordering, boot and revision across pages, and does not publish
a partial file on failure. A concurrent revision change requires a retry.

E2E acceptance: with a real daemon and external provider fixture, reconcile a
native transcript longer than 200 messages, export through the CLI, read the
file, and verify old/new content, unique identities and order. Reject an
inconsistent daemon page, leave no output, and refuse to overwrite a prior
export.

This ticket does not complete F050. Managed backup/restore, blob verification,
and disclosure of excluded native/private data remain in the reliability and
storage work. The history file is an export, not a restorable profile backup.

Evidence at `eeda9db` on macOS arm64: `pnpm --filter @ade/cli typecheck`,
`pnpm --filter @ade/cli build`, and
`pnpm exec playwright test e2e/specs/history-export.spec.ts e2e/specs/local-cli.spec.ts`
passed 6/6. The export E2E reads 222 native-fixture messages through a real
daemon, compares the archive with every public history page, refuses an
existing destination, and corrupts the second page to prove no partial archive
is published. This is deterministic-provider evidence, not live-account proof.
