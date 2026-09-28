# 01 — Foundation: decisions, contract scaffolds, trees

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: none

Serial work by the coordinator before any lane starts. Everything here touches files that only
the coordinator edits; after it, the lanes never need to.

## Steps

1. **Record the decisions.** Add D18 to [the decision register](../../ade-v1/decisions.md) with
   the map's decision table. Update [the architecture proposal](../../../docs/proposed-architecture.md):
   - §1 responsibilities: Electron main hosts native windows *for daemon window records*; the
     renderer owns drawing, gestures and transient interaction state only; the daemon owns
     windows, layouts, panes and tabs.
   - §3: add Window, Layout, Tab and Terminal to the identity table; replace "expanded rows" in
     the local-state sentence with "hover, drag and scroll"; say per-window view state is
     daemon-owned.
2. **Glossary.** Add to [CONTEXT.md](../../../CONTEXT.md): Window, Layout, Pane, Tab, Tab target,
   Project kind, Workspace kind, Attention, Busy terminal. Change Project to "Repository or
   ordinary folder; every workspace belongs to exactly one".
3. **Contract domains.** Register the new domains in `crates/ade-core/src/contract/mod.rs`
   `DOMAINS` with empty operation lists: `layout` (windows and layouts) and `settings`. The
   legacy `window.save` and `window.close` stay in `conversations.rs`; lane A replaces them.
4. **`TabTarget`.** Define it fully in `contract/layout.rs` now, so lanes A and D build against
   the same shape:
   `conversation {id}`, `terminal {id}`, `browser {id}`, `file {path}`,
   `diff {path, staged}`, `new_conversation`. A `SHARED_TYPES` list in `contract/mod.rs` puts
   it in the bundle before any operation uses it. Run `pnpm contract:generate`.
5. **Migrations.** Schema versions are sequential (`PRAGMA user_version`): a database already
   at a later version would skip an earlier-numbered migration merged afterwards. So numbers are
   not reserved. Each lane writes its migration body as a named function in its own module and
   calls it from a provisional `if version < 18` block; the coordinator assigns the final number
   at merge time (18, 19, 20 in merge order) and widens the supported range.
6. **Trees.** Commit steps 1–5 on `main`. Cut one `wt` tree per backend lane (A, B, C, E) from
   that commit.

## Acceptance

- `pnpm check:static` passes on `main` with the scaffolds.
- The generated `@ade/contracts` exports `TabTarget`.
- Four trees exist, each on a branch named `lane/<letter>-<slug>`.

## Comments
