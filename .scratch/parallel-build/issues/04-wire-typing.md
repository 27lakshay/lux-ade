# How are wire messages typed today, and which schema tools fit?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

What is the current wire protocol (framing, operation names, protocol version strings, `serde_json::Value` versus typed structs) between client, daemon and runtime? Which schema and binding tools fit it?

Count the operations and say which have typed Rust request or response structs. Compare ts-rs, Schemars with a JSON-Schema-to-TS generator, typeshare and specta on these points: tagged unions, optional versus null, u64 and large integers, bytes, runtime validation in TS, drift checks in CI, and maintenance status. Read `opencode-v2/packages/client/script/build.ts` in `/Users/lakshyakumar/work/ade-evaluation-2026-09-24` for its generated-client approach. Check each tool's current docs, llms.txt or agent guidance. Estimate the migration size for typing all existing operations.

## Comments

- 2026-09-27 — Research: [04-wire-typing](../research/04-wire-typing.md). The wire is NDJSON over Unix sockets. All 96 daemon ops dispatch on `request["op"]` as `serde_json::Value` with `json!` replies, and none has a typed request or response struct. TS validates only the hello and subscription frames; everything else is hand-written casts and `typeof` checks (2–3 hand copies per op). Recommend Schemars as the single authority → committed JSON Schema → json-schema-to-typescript + Ajv standalone validators, with a regenerate-and-diff check. ts-rs+Schemars dual-derive is the fallback. typeshare cannot express the internally tagged envelopes, and specta's validator exporters are partial. Migration: first type the Rust boundary (~96 request structs, ~74 response variants), in about 9 domain slices plus 1 setup slice. The Schemars `Option`/u64 output needs a short spike.
