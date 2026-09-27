# browser-diagnostics

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-6
Worker: Phase 2 parallel build, round C, slice browser-diagnostics
Requirements: F096 (browser diagnostics, backend and Electron main), F097 (browser recording, backend and Electron main; decision D11 proposal), 08-S12 (a closed or missing target fails without touching another tab)

## Outcome

Electron main can now capture console messages and network request summaries
for one exact tab through the Electron debugger. Capture is bound to that tab's
page (its WebContents) and is keyed by tab ID. It never follows the selected or
focused tab. Entries are redacted and bounded before they are stored. Capture
never reads headers, cookies or bodies.

Electron main can also record one exact tab into a local artifact for a bounded
window: PNG screenshots, a page-event log, and the console and network entries
captured inside the window. The recording seals a manifest when it stops. A
recording that the running owner is not running is reported `interrupted` and
is never resumed. Every recording reply lists its coverage gaps.

The daemon relays six new typed operations to the browser owner. It forwards
only the typed request fields. It accepts a reply only when the reply names the
same profile, owner and tab or recording. The CLI exposes all six under
`ade browser diagnostics …` and `ade browser recording …`.

No requirement is fully accepted. F096 and F097 need E2E evidence against a real
page. D11 needs the coordinator to record the format decision (see Open).

## Operation tiers

| Operation | Tier | Why |
|---|---|---|
| `browser.diagnostics.attach` | idempotent command | Attaching an attached tab only adds the `caller` holder. |
| `browser.diagnostics.detach` | idempotent command | Detaching a detached tab changes nothing. |
| `browser.diagnostics.read` | query | Reads the in-memory buffer; no effect. |
| `browser.recording.start` | idempotent command | Caller-owned `recording_id`. A repeat with the same tab and scope returns that recording in its current state and never starts it again. The same ID with another tab or scope is a `conflict`. |
| `browser.recording.stop` | idempotent command | Stopping a stopped or interrupted recording returns it unchanged. A failed manifest seal is retried by the next stop; the capture is never re-run. |
| `browser.recording.get` | query | Reads the manifest; for an interrupted recording, counts the files on disk. |

None is an effect command, so none uses `receipts.rs`. A command whose owner
reply is lost returns `outcome_unknown` with the instruction to repeat the same
request, which converges.

## Behaviour and bounds

- Targeting: each operation names `tab_id` or `recording_id`. The owner resolves
  the tab through `browserTabPage`, which reuses the existing `exact()` lookup
  under the live owner lease. A missing tab is `unavailable`. A tab with no live
  page (restored but never shown) is `unavailable`; the owner does not load it.
  The daemon refuses an owner reply that names another tab or recording
  (`protocol` error, nothing reported).
- Debugger: attach fails with `conflict` when another client holds the tab's
  debugger. A detach by the page, DevTools or Chromium is recorded with its
  reason and shown in `attachment.reason`. In-flight requests then end as
  `incomplete`.
- Bounds: console and network each keep 1,000 entries and 512 KiB. At most 256
  requests are in flight per tab. At most 16 tabs keep capture state; the oldest
  idle one is evicted. A read page holds at most 200 entries and 768 KiB, under
  the daemon's 1 MiB owner-reply limit. Text and URLs are cut to 1,024
  characters after redaction.
- Redaction policy `ade-browser-redaction-v1`: header lines (`Cookie`,
  `Set-Cookie`, `Authorization`, `Proxy-Authorization`, `X-API-Key`), labeled
  secrets, bare `Bearer`/`Basic` credentials, provider keys, JWTs, PEM blocks and
  URL user information in text; in URLs, user information and fragments are
  removed, credential-like query values are replaced, `data:` and non-web
  schemes are omitted. Console object arguments appear only as their type
  description. Every read reply lists what capture excludes.
- Recording (D11 proposal): format `ade-browser-recording-v1` under
  `<profile>/browser-recordings-v1/<recording_id>/` with `manifest.json`,
  `frames/NNNNNN.png`, `page-events.jsonl` and `diagnostics.json`. Screenshots
  every 250 ms to 60 s (default 2 s). Window 1 s to 30 min (default 5 min). At
  most 900 frames, 256 MiB, 2,000 page events and 2 running recordings. Stop
  reasons: `requested`, `duration_reached`, `frame_limit`, `size_limit`,
  `target_closed`, `write_failed`, `owner_stopped`. A debugger conflict fails the
  start before any file is created. No video, no input capture, no publishing.

## Checks

- `pnpm check:static`: pass (rustfmt, contract check, architecture, SDK build,
  typecheck, Fallow, JS build, 45 JS pure tests, Clippy, legacy Rust tests).
- In-process tests added:
  - `apps/desktop/src/main/browser-diagnostics-core.test.mjs`: redaction, bounding,
    CDP event normalization, the network reducer, rings and paging.
  - `apps/desktop/src/main/browser-recording-core.test.mjs`: spec validation, the
    idempotent-start comparison, manifest validation, interrupted state, limits
    and coverage gaps.
  - `crates/ade-core/src/contract/browser.rs`: schema round trips.
  - `crates/ade-daemon/src/bin/daemon/server/browser_tools.rs`: target matching
    (a reply for another tab is refused), request bounds and field forwarding,
    reply contract checks.

Verified only statically: the Electron debugger attach, detach and message
handling, `capturePage` on hidden and visible views, the page-event listeners,
the manifest seal and the owner socket dispatch. These need E2E.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 10 | 8 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/main/observability/redactor.ts`, copied (rules adapted) → `apps/desktop/src/main/browser-diagnostics-core.ts` (MIT, © 2026 Lovecast Inc.).
- Orca @ ade-evaluation-2026-09-24, `src/main/browser/cdp-debugger-events.ts`, pattern (per-tab console and network buffering from CDP events; ADE adds redaction, byte bounds and request-ID tracking of redirects and failures).
- Orca @ ade-evaluation-2026-09-24, `src/main/browser/electron-debugger-lease.ts` and `cdp-debugger-lifecycle.ts`, pattern (holder-counted debugger attachment; DevTools conflict on attach).
- Electron 44 `electron.d.ts` (`Debugger`, `WebContents.capturePage`), studied.

## Open

- Coordinator: add a `THIRD-PARTY-NOTICES.md` entry for the Orca redactor rules
  adapted into `apps/desktop/src/main/browser-diagnostics-core.ts` (the Orca MIT
  notice is already recorded for the Round B redactor).
- Coordinator: record D11 in `decisions.md` if the format above is accepted.
- E2E later: attach to a fixture page, read console errors and failed requests,
  confirm no cookie or `Authorization` value appears; open DevTools and see the
  conflict or detach reason; close the tab and see the next read fail without
  touching the newly selected tab (08-S12); record a window, stop it and inspect
  the artifact; kill the app mid-recording and see `interrupted`.
- UI later: a diagnostics panel and recording controls in the renderer.
- Not built: child-frame (OOPIF) and worker capture, response bodies, video,
  input capture, recording retention and deletion, and inclusion of recordings
  in backups.
- `browser.recording.*` resolves through the live owner, so a recording is
  readable only while its profile's browser owner runs.
