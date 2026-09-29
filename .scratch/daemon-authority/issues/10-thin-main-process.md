# 10 — Electron main forwards; it does not decide

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [07](07-desktop-switch-over.md)

Found by the frontend review of 2026-09-29. After tickets 02–07, Electron main still re-checks
requests with its own rules and chains daemon calls. Every rule there is one the CLI and another UI
do not get, and a second copy that can drift from the daemon's.

## Build

1. **Drop the hand-written request checks in main that duplicate the daemon's.** The daemon already
   refuses bad input, and the SDK checks every request against the generated contract before
   sending. Main keeps only what protects the window boundary: the sender is an app window, the
   operation is one the renderer may call, and IDs are well-formed. Remove:
   - account identity shapes for `account.verify` (`main/conversations/ipc.ts`, about 60 lines per
     provider; the daemon checks the identity against the inspected account);
   - script name and run ID patterns and output limits (`main/services.ts`; the daemon has
     `scripts::valid_name`);
   - review anchor, path, revision and token patterns and the file search limits
     (`main/review.ts`, `main/files.ts`);
   - prompt size and question-answer size limits that the contract or daemon already bound.
   Where the daemon does not check something main checks, move the check to the daemon first.
2. **`conversation.create` in one call.** Main lists providers first to check the provider exists;
   the daemon must refuse an unknown provider itself with a typed code.
3. **Review feedback in one call.** Main's `reviewPrompt` and `reviewBatchPrompt` read
   `review.status` and `review.diff_page` to refuse a stale anchor, then build the prompt. Lane B's
   `review.feedback.send` does all of it; main forwards (ticket 03, step 6, extended 2026-09-29).
4. **Window selection is the daemon's.** `main/workspaces.ts` keeps `selectedWorkspaces` per window
   and polls the catalog for up to 3 s before accepting a selection; review requests are allowed
   only for the selected workspace (`activeReviewContext`). With lane A, the window record says
   what it shows: main reads it instead, and the guard checks the window record.
5. **Keybindings are settings.** `APP_COMMAND_KEYS` and the palette's key bindings are fixed in
   code. F015 needs them configurable: read them from the daemon's `settings` (lane B leaves room
   for keybindings); the menu and the palette apply what the daemon returns.

## Stays in the desktop

Native menus and their accelerators (bound from the settings), notification presentation and its
focus and age policy, crash recovery and safe mode, the diagnostics export (it bundles the
daemon's own redacted report with this app's logs), the folder pickers, and the stream bridge.

## Acceptance

- `main/` contains no request-shape rule the daemon also enforces; a test sends each previously
  checked bad request through the IPC channel and gets the daemon's typed refusal.
- `conversation.create`, review feedback and workspace selection are one daemon call each.
- Changing a keybinding with `ade settings set` changes the menu and the palette without a restart.

## Comments
- 2026-09-29 — Steps 1 and 2 done. Main no longer re-checks script, service, file, account or
  conversation-creation requests: it keeps the window boundary (allowed operation, request is an
  object, no change lands during a profile switch, the window's selected workspace for file and
  review requests) and forwards; the SDK checks each request against its contract. Checked in the
  dev app through the real IPC channel: a bad script name, an oversized output limit, a `../..`
  path, an empty search, a page limit of 5000, a 200-character service name and an unknown provider
  each came back with the daemon's own refusal; listing and previewing files still work. Not done:
  the daemon refuses an unknown provider with an untyped message ("Unknown provider: …"), not a
  typed code; step 3 (review feedback through `review.feedback.send`) waits for the legacy E2E port,
  which is moving the specs that drive that path; steps 4 and 5 wait for ticket 07's window records
  and a keybindings setting.
- 2026-09-29 — Step 4 done by ticket 07 (`e99cf45`): `selectedWorkspaces` is gone and review fencing reads the window record's `workspace_id`.
