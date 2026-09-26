# Managed profile backup and restore

Status: ready-for-agent
Type: implementation ticket
Requirements: F050, R014, R015 (partial); F092 and F138 dependencies
Depends on: profile/runtime identity, core and review stores, browser session ownership, pending-send recovery

Outcome: A user can create a versioned, consistent profile backup while ADE continues accepting ordinary work, inspect exactly what it includes, and restore it into a disposable profile. A missing or unsupported component never becomes a published backup or partially changes the restore target.

The current durable state spans three owners. The daemon data directory contains the core SQLite store (including attachment BLOBs), review and worktree lifecycle databases, service proxy records, service logs and provider-native homes. The profile runtime home contains the data binding and browser-tab metadata. Electron user data contains browser cookies and the shared pending-send journal. The profile registry supplies stable identity and selection. Copying only `sessions.sqlite`, or copying live WAL files, does not meet this ticket. The `8c75551` runtime-adoption fix allows current schema-v10 stores to be rebound and rejects a future schema before writing a binding.

Implementation sequence:

1. Define a `managed-backup-v1` manifest with profile identity, included components, independent format/schema versions, SHA-256 and byte size for each file, and explicit exclusions. Keep provider credentials/native homes, private plugin files, external repositories and unregistered raw logs out of automatic restore. Record whether active pending sends and session cookies are included; do not silently promise them.
2. Snapshot each managed SQLite database with its online backup API while its owner runs. Coordinate non-SQLite manifests and Electron tab/cookie capture with their owners. Stage all bytes, validate them, fsync, then publish one complete backup marker. An interrupted stage is not restorable.
3. Validate the entire source and target before restore: format/schema compatibility, hashes, path safety, SQLite integrity, referenced artifacts, profile identity and an empty disposable target. Restore through a durable staged publish with registry last. Any validation failure leaves the target and registry unchanged.
4. Build retention against the same ownership model. Preview reclaimable bytes and reasons for protected data. Never sweep backup stages still in use, referenced attachments, active browser sessions, execution resources or unresolved worktree claims.

E2E acceptance through running ADE processes, Electron and public CLI/protocol:

- Back up while messages, attachments and browser tabs/cookies are being written. Restore into a disposable profile; read the conversation, attachment, review data and tab/cookie through public interfaces. Check the manifest's exclusions against actual behavior.
- Kill backup at staged write boundaries. A partial backup cannot be selected for restore and later attempts can proceed without deleting the last complete backup.
- Corrupt a manifest or use a future supported-component schema. Restore rejects before changing any target file or profile registry entry.
- Run retention during backup, blob finalization, active agent/browser execution and unresolved resource claims. Reclaim only verified unreferenced data and report estimates and failures.

Evidence: `8c75551` fixes current-store adoption and its real-process E2E reads a conversation after rebinding the store, then rejects schema 11 before writing `runtime.json`. Commit `5455362` adds a deliberately scoped backend snapshot. Its real-process E2E backs up during daemon draft writes, restores conversations, draft and attachment references, and verifies that restored accounts are unverified, stable service routes are absent, and source-owned worktrees cannot be removed by the restored daemon. It rejects corrupt and future-schema backups before target creation. Each SQLite database is independently consistent; this is not yet a coordinated profile backup. Electron browser sessions, tab metadata, cookies, pending-send journal and window identity, profile registry, and runtime binding still need owner-coordinated capture and restore. No retention sweep exists yet: attachment uploads lack a durable lease or expiry, so an apparently unreferenced upload can still be held by a client before draft save. R014/R015 and F050 remain open.
