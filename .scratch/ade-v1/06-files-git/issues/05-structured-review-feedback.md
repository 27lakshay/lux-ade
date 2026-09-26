# Structured review feedback and anchor history

Status: complete
Type: implementation ticket
Requirements: F074, R010, R011
Depends on: F074 paged diff, atomic review admission and durable send intent

Outcome: The selected workspace can send several notes on selected diff lines or
ranges in one request. The daemon admits every anchor against one current Git
state before the provider turn. The accepted user message retains the structured
notes so conversation history can show and search them after restart.

## Acceptance

- In a running Electron app with a real daemon and fixture provider, select two
  ranges in a changed file, add distinct notes, send once, and observe one provider
  turn and structured feedback in the resulting conversation message.
- Change any selected line before admission. The entire send fails stale with no
  provider turn and retains note text. After refreshing the changed diff, the
  user selects new anchors and sends a new request ID. An uncertain outcome for
  the original anchor retains its original ID until reconciled.
- Crash and reopen Electron after journaling or accepted admission. The original
  request ID and complete note set recover; retry never duplicates the provider
  turn.
- Read conversation history after a daemon restart and find the stored anchors,
  range endpoints and notes. Exercise the public protocol as well as the app.
- Run only real-process E2Es and affected static checks during the slice. The
  integrated source suite runs once after code freeze; packaged checks run at
  the delivery checkpoint because installed Electron behavior changes.

## Evidence

The public-protocol E2E rejects an altered note anchor and an actual file edit
after selection without admitting a provider turn. It verifies a range and a
second note, then searches the stored anchors after a daemon restart. Electron
E2Es cover selection, one-note and multi-note history search, lost replies,
pre-dispatch crash recovery and the original request ID. The integrated source
suite passed 170 with one existing host skip; packaged macOS checks passed 6/6.

## Ownership

- Coordinator: daemon admission, durable message/history contract, Electron main
  journal/send path and integration.
- `/root/f074_batch_ui`: renderer selection and note UI, focused Electron E2E.
- Independent review: assign after implementation. Fix current-slice acceptance
  and safety findings; queue unrelated improvements.
