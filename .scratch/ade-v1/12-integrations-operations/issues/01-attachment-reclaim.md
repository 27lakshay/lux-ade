# Reclaim an explicitly discarded attachment

Status: implementation in review
Type: implementation ticket
Owner: ADE v1 coordinator
Requirements: F138, R015 (partial)
Dependencies: durable attachment rows, drafts, queued prompts, send intents, messages, managed SQLite backup

Problem: an uploaded attachment may never be sent, but ADE cannot reclaim its
payload. A generic orphan sweep would delete uploads held only in a client
before it saves a draft.

Outcome: the daemon exposes `attachment.reclaim.preview` and
`attachment.reclaim.apply` for one explicitly selected ID. Preview reports the
reusable payload estimate and durable reasons for protection. Apply requires
the upload generation and rechecks all durable references in one SQLite write
transaction. Successful reclaim clears the BLOB but retains a tombstone, so a
stale client cannot reuse the ID after deletion. This is an explicit discard;
there is no automatic sweep of client-held uploads.

E2E acceptance: use real daemon/runtime processes to upload multiple images,
discard one, verify the other remains usable, and reject stale-generation
reclaim and ID reuse. Protect images referenced by drafts, queued prompts,
send intents and committed messages. Race draft save against reclaim; exactly
one succeeds and the resulting state remains readable. Create a managed SQLite
backup while reclaim runs; both the live profile and snapshot validate, and
the restored daemon sends the protected image bytes to a provider fixture.
Cancelled prompts and aborted send intents stop protecting an upload after the
remaining draft references are cleared. A real daemon migrates a v10 profile
with a referenced attachment to v11 without losing its payload.

This is not full F138/R015 acceptance. It does not configure an age/size policy,
release per-client leases, reclaim non-SQLite artifacts, shrink the SQLite file,
or coordinate browser/runtime resource cleanup. Reported bytes are reusable
payload bytes inside SQLite; filesystem bytes reclaimed are zero without a
separate compaction. Automatic retention requires explicit client lease/release
semantics and a backup coordination policy for non-SQLite data.
