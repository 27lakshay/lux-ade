# Browser partitions, import and design context capture

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-8
Worker: Phase 2 parallel build, round D, slice browser-profiles-context
Requirements: F092, F093, F094 (partial each; backend, Electron-main and CLI only). Decision D10 is proposed below for the coordinator to record. No feature ID closes: each needs E2E acceptance.

## Outcome

A profile can now register named browser partitions. A tab opened with `partition_id` lives in its own Electron session storage, so cookies and site storage do not cross partitions. Bookmarks and history import explicitly from Chrome and Safari files that are readable without decryption, into the profile's browser library, in one transaction per import. Everything else is refused with a stated reason. Design context capture takes one element of one exact tab and stores its redacted HTML snippet, computed styles and geometry, plus a screenshot, as two conversation attachments.

The `browser.open` path gains an optional `partition_id` with wire compatibility. An open without it keeps its earlier fingerprint and behaviour.

## Decision D10 as built (for the coordinator to record)

| Source | Class | File | Accepted format | Bound |
|---|---|---|---|---|
| Chrome (macOS), `Default` or `Profile N` | bookmarks | `~/Library/Application Support/Google/Chrome/<profile>/Bookmarks` | JSON, `version` 1 | 64 MiB file, 100,000 bookmarks, folder depth 64 |
| Chrome | history | `…/<profile>/History` | SQLite, `meta.version` 40 to 99, `urls` with `url, title, visit_count, last_visit_time, hidden` | 1 GiB file, 50,000 most recent URLs |
| Safari (macOS), default profile only | bookmarks | `~/Library/Safari/Bookmarks.plist` | bplist00, `WebBookmarkFileVersion` 1 | 64 MiB file, 100,000 bookmarks |
| Safari | history | `~/Library/Safari/History.db` | SQLite with `history_items(id, url, visit_count)` and `history_visits(history_item, visit_time, title)` | 1 GiB file, 50,000 most recent URLs |

- Imported: HTTP(S) URLs only, with title, folder path, and the last visit time and count. A URL carrying user information is skipped, because it can hold a password.
- Refused always, with reasons in every preview and import record: cookies, passwords, autofill and payment data, open tabs and sessions, local storage and IndexedDB, extensions, and individual history visits.
- Safari needs Full Disk Access for ADE. Without it, the class reports `permission_denied`, not `missing`.
- Sources are never written. SQLite sources and their `-journal` and `-wal` files are copied into a private staging directory, which is removed afterwards. The copy must pass `quick_check`; otherwise the class is `unsupported`, with advice to close the browser.
- An import stores every requested class or nothing. A class that is not ready fails the whole run, and nothing is stored.

## Operation tiers

- `browser.partition.list`: query. The profile ID is optional and defaults to this daemon's profile.
- `browser.partition.create`: idempotent command. The caller owns `partition_id`. The same ID and name returns the partition; another name conflicts. The limit is 32 named partitions, and `default` is reserved.
- `browser.import.preview`: query. It reads the source and stores nothing.
- `browser.import.run`: idempotent command. The caller owns `import_id`. The same request returns the stored record without reading the source again; another request conflicts.
- `browser.import.get`: query.
- `browser.context.capture`: idempotent command. The caller owns `capture_id`, which becomes the context attachment ID; the screenshot is `<capture_id>-screenshot`. The daemon holds the checked bytes before storing either attachment. A repeat of a held capture re-stores the identical bytes and never captures again. A completed capture returns its stored reply. The owner is left out of the fingerprint, so a repeat after an owner restart still converges.
- `browser.open` (effect command, changed): optional `partition_id`. The daemon checks it against the registry and appends it to the fingerprinted payload only when present. `default` is treated as absent. `BrowserTabRecord` gains optional `partitionId`.

## Checks

- `pnpm check:static`: pass at the slice commit (rustfmt, contract check, architecture, SDK build, typecheck, Fallow, JS build, JS pure tests, strict Clippy, 460 Rust tests).
- In-process tests added:
  - `crates/ade-core/src/contract/browser.rs`: `partition_import_and_capture_round_trip`.
  - `crates/ade-daemon/src/browser_library/bplist.rs`: 3 tests (Safari fixture, corruption fuzz over every byte, reference cycle).
  - `crates/ade-daemon/src/browser_library/sources.rs`: 9 tests (profile names, refusals, URL filter, epochs, Chrome and Safari bookmarks, bounds, history schema checks, history bounds).
  - `crates/ade-daemon/src/browser_library.rs`: 3 tests (partition IDs, import fingerprint, error codes).
  - `crates/ade-daemon/src/bin/daemon/server/browser_context.rs`: 6 tests (capture document, refusals and bounds, fingerprint, open fingerprint, record URLs, request bounds).
  - `apps/desktop/src/main/browser-capture-core.test.mjs`: 8 tests. `check:static` runs them.

Verified only statically:

- The Electron wiring: partition storage paths, per-tab sessions, flushing every partition, saved-tab persistence of `partitionId`, receipt intent, fingerprint recomputation, and the backup bundle leaving named-partition tabs out.
- The Electron capture: the isolated-world script, the navigation fence, `capturePage` and the crop, resize and encoding.
- The daemon: SQLite staging and reading of real Chrome and Safari databases, the library transactions, the capture hold and attachment writes, and the CLI commands.

Needs E2E later:

1. F092: create two partitions, open a tab in each against a fixture server that sets a cookie, and show that the cookie does not cross partitions or reach `default`. Restart and see the tabs return to their partitions. An unknown partition is refused; an open without `partition_id` behaves as before.
2. F093: using `ADE_BROWSER_IMPORT_HOME` with fixture Chrome and Safari trees, preview and then import. Show the refusals, the source files unchanged by checksum, the same-ID repeat returning the record, a changed request conflicting, a damaged or locked History reported `unsupported`, and a missing class failing the run with nothing stored.
3. F094: capture an element from a fixture page into a conversation. Switch focus to another tab mid-capture and show the capture still reads the named tab. Navigate mid-capture and see it fail. Kill the daemon after the hold and before the attachments, then show the repeat stores identical bytes. A hidden tab reports `screenshot_unavailable: capture_failed`.
4. The renderer needs UI for partitions, import and the element picker; this slice has none.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 10 | 10 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/browser/browser-grab-payload.ts`: pattern. A guest payload is untrusted and is clamped and redacted main-side. No code was copied.
- Orca, `src/main/browser/browser-grab-screenshot.ts`: pattern. The crop scale comes from bitmap width over CSS viewport width. No code was copied.
- Orca, `src/main/browser/browser-cookie-*.ts`: studied. Cookie import was refused under D10, so nothing was used.
- Apple CoreFoundation `CFBinaryPList.c`, format description only: the bplist00 reader is original.

## Open

- Shared files for the coordinator:
  - Record D10 as built (the table above) in `decisions.md`.
  - The backup-coverage slice should cover `browser-library.sqlite3` in the profile directory, or exclude it with a stated reason. Named-partition storage lives under `browser-sessions/<key>.partitions/` in the Electron user data. The browser bundle leaves it out and says so in `excluded_partition_tabs`.
- Named partitions cannot be renamed or removed, and their storage is never cleared.
- Held capture bytes stay in the library if a capture never finishes, for example when its conversation is deleted. Nothing prunes them yet.
- Imported bookmarks and history are stored, but no operation reads them back as a library yet (URL suggestions and a list view), and there is no undo for an import.
- A capture of a page scrolled out of view reports `not_visible`; ADE does not scroll the page to take it.
- A downgraded ADE that predates partitions would open a partition tab in `default` storage.
