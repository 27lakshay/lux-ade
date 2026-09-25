# Apply conversation deltas without refetching the transcript

Status: ready after 01-local-conversation and desktop draft slice
Type: implementation ticket
Owner: unassigned
Requirements: F031, 03-S17, 03-S18 (stream/recovery slice)

Problem: the daemon already publishes ordered `conversation_changed` frames
with changed messages, requests and queue state. The current Electron view
refetches the last 200 messages after every client revision and also polls every
2 seconds. During streaming this grows protocol and renderer work with the
history length instead of the changed content.

Outcome: expose versioned per-conversation changes through the framework-neutral
client. Begin from `conversation.get` snapshot with boot ID and revision, apply
only contiguous later events for that conversation, and resnapshot on a gap,
boot change or reconnect. Keep history-page reads separate from live-feed
position. Preserve message identity and visible reading position when updates
arrive. Terminal bytes remain outside React state.

E2E acceptance: run a real daemon/fixture stream with a populated transcript,
observe ordered streaming content and one native dispatch in Electron, interrupt
the subscription and recover without lost/duplicated messages, then force a
feed gap and observe a fresh snapshot. Capture request/byte counts to show the
view no longer refetches the full 200-record transcript for each delta. Use no
new unit tests.

Do not mark F031 or 03-S17/18 complete from this slice alone; pagination,
unsupported content and other surface behavior still need acceptance.
