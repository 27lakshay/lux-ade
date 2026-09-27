# phase2-sdk-sync-core

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-2
Worker: Phase 2 parallel build, slice sdk-sync-core (ticket 10, part 2)
Requirements: R010 and 03-S18, partial (client catch-up and snapshot completion states); none closed

## Outcome

Feed catch-up moved out of the renderer's `ConversationView` into
`packages/client/src/sync.ts`, exported as `@ade/client/sync`. The module has no
`node:` imports. It holds a pure reducer (`reduceFrame`) and a projection
(`startConversationProjection`) that takes an injected snapshot fetcher and frame
source and reports `loading`, `current` and `stale`. The renderer now feeds it
through `window.adeHost.conversations.request('conversation.get')` and
`onFeedFrame`.

Behaviour is the same as before, with one intended change. The snapshot now asks
`conversation.get` for `CONVERSATION_WINDOW` (200) messages instead of the
daemon's default 50, and merged deltas keep the same 200. The daemon's store
already caps a page at 200.

## Operation tiers

No operation added or changed. `conversation.get` (query) now receives an explicit
`limit`, which its contract already allows.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `packages/client/src/sync.test.mjs` (reducer: apply,
  window cap, advance, duplicate, gap, boot change, reload; projection: buffering
  and replay, stale during repair, failed load). No existing runner covers
  JavaScript tests in `check:static`, so they are not wired in. Run them with
  `pnpm --filter @ade/client test` (builds, then `node --test`); 8 pass. The
  package script also makes the file a Fallow entry point.

## Verified statically only

- The renderer's use of the projection (typecheck and `electron-vite build`).
- That the `@ade/client/sync` subpath resolves in the renderer bundle.

## Needs E2E later

- `desktop-incremental-feed`: no transcript polling at rest, at most 6 snapshot
  reads, and a resnapshot after a dropped revision.
- The 200-message snapshot page against a long conversation.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 25 | 5 | 15 | 0 |

## References

- t3code, `packages/client-runtime/src/state/threads-sync.test.ts`, studied (Effect-based
  snapshot loader and stream; only the idea of a transport-injected sync core transferred). No code copied.

## Open

- The projection takes no cursor scope yet. Research note 06 suggests one so the
  API does not change when the daemon gains a durable feed position; nothing is
  persisted today because the revision restarts with each `boot_id`.
- History paging past the 200-message window is not in the SDK yet.
