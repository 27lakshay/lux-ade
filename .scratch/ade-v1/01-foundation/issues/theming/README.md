# Theming implementation tickets

Status: ready-for-agent
Type: implementation ticket index

The user approved this 24-ticket breakdown and its direct blocking edges. Each ticket is a separate vertical slice of the [theming specification](../../theming.md). Publication prepares agent work; it does not authorize implementation or a commit.

The ticket numbers are local to this theming set. They live beneath the foundation domain’s issues directory so existing foundation ticket numbers stay intact. F013/F014, F056 and F082 retain their original domain ownership.

## Work order

**01–06 are complete. Ticket 07 awaits production code/file/diff surfaces.** Core switching, recovery, all 12 palettes, startup, independent terminal bindings, cursor/selection colors and durable readability policies have acceptance evidence in their ticket Comments. Ticket 06 now also proves color-import preference isolation and explicitly accepted Ghostty policy proposals. Ticket 07 has independent syntax settings and Shiki/Pierre/CodeMirror adapters; its production consumers remain unbuilt. Tickets 08 and 09 have accepted their own preview and library criteria, including conflicts, atomic files, packs, removal and structured failures; their statuses remain in progress through the approved 07 → 08 → 09 chain. Ticket 10 has verified Ghostty parsing, safe import, fidelity preview, independent policy proposals and deterministic export through public operations and the built desktop. Cell-relative cursor fills and complete pixel evidence remain open. Take any ticket whose listed blockers are complete and continue useful independent preparation on accepted behavior. The table retains all approved direct blockers. The complete theming goal remains open.

| Ticket | Blocked by |
|---|---|
| [01 — Switch Graphite and Chalk across the app and terminal](01-core-switch.md) | None |
| [02 — Preserve terminal appearance through recovery and races](02-terminal-recovery.md) | [01](01-core-switch.md) |
| [03 — Ship all 12 palettes with system switching and correct startup colors](03-palettes-system-startup.md) | [01](01-core-switch.md) |
| [04 — Choose independent terminal themes and per-terminal overrides](04-terminal-bindings.md) | [03](03-palettes-system-startup.md) |
| [05 — Render complete terminal cursor and selection colors](05-cursor-selection.md) | [01](01-core-switch.md) |
| [06 — Control terminal contrast and bold-color behavior](06-terminal-contrast-bold.md) | [05](05-cursor-selection.md) |
| [07 — Theme code blocks, previews and diffs independently](07-code-diff-themes.md) | [03](03-palettes-system-startup.md) |
| [08 — Preview appearance safely before applying it](08-safe-preview.md) | [04](04-terminal-bindings.md), [05](05-cursor-selection.md), [07](07-code-diff-themes.md) |
| [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md) | [08](08-safe-preview.md) |
| [10 — Import and export Ghostty theme files](10-ghostty-files.md) | [09](09-ade-theme-library.md) |
| [11 — Import installed Ghostty configuration](11-ghostty-config.md) | [10](10-ghostty-files.md) |
| [12 — Browse an offline terminal catalog with favorites and commands](12-offline-catalog.md) | [10](10-ghostty-files.md) |
| [13 — Import local VS Code theme collections](13-vscode-import.md) | [09](09-ade-theme-library.md) |
| [14 — Discover and import themes from Open VSX](14-openvsx-import.md) | [13](13-vscode-import.md) |
| [15 — Import Warp terminal themes](15-warp-import.md) | [09](09-ade-theme-library.md) |
| [16 — Customize typography, density and terminal cursor behavior](16-fonts-density-cursor.md) | [05](05-cursor-selection.md), [07](07-code-diff-themes.md) |
| [17 — Apply accessible appearance preferences across the workbench](17-accessible-appearance.md) | [03](03-palettes-system-startup.md), [05](05-cursor-selection.md), [07](07-code-diff-themes.md) |
| [18 — Edit complete custom themes](18-advanced-editor.md) | [09](09-ade-theme-library.md) |
| [19 — Inspect tokens and report contrast problems](19-token-contrast-inspector.md) | [17](17-accessible-appearance.md), [18](18-advanced-editor.md) |
| [20 — Generate themes from a surface and accent](20-simple-theme-generator.md) | [19](19-token-contrast-inspector.md) |
| [21 — Watch linked theme files as drafts](21-linked-file-drafts.md) | [18](18-advanced-editor.md) |
| [22 — Support declarative plugin themes and safe-mode recovery](22-plugin-themes.md) | [09](09-ade-theme-library.md) |
| [23 — Back up and restore appearance with profiles](23-appearance-backup.md) | [09](09-ade-theme-library.md), [16](16-fonts-density-cursor.md), [22](22-plugin-themes.md) |
| [24 — Keep theme switching responsive under terminal load](24-appearance-under-load.md) | [02](02-terminal-recovery.md), [06](06-terminal-contrast-bold.md), [12](12-offline-catalog.md), [16](16-fonts-density-cursor.md) |

## Delivery rules

- Use the parent specification and D06/D18/D19/D20 for scope, terminal ownership, daemon authority and current-format compatibility. These tickets divide the work without changing that contract.
- Complete each behavior across applicable persistence, typed public operations, CLI/SDK, desktop controls and tests. Query/idempotent/effect tiers and revision conflicts use existing architecture.
- Read current code and the owning domain guidance before implementation. Reuse existing modules and dependencies; check official agent resources and pinned APIs before integrating a package. Make necessary small preparatory changes at the start of the slice.
- Use stock shadcn compositions for unapproved provisional appearance UI and retain the approved shell. Keep handoff colors exact; a failing required contrast combination needs an explicit palette revision before acceptance.
- Prove backend behavior over real daemon/runtime processes and visible behavior in the built desktop using scratch profiles. Pure parser/resolver tests and renderer browser tests support those boundaries. Use deterministic network fixtures for imports.
- Run `pnpm check:static` for changes and the relevant protocol/desktop E2E acceptance. Record commands, results and limitations with the ticket. Native Ghostty must be bootstrapped for the full Rust gate; the initial documentation-only worktree lacked its native archive.
- Check actual plugin, backup and file/diff prerequisites when taking those tickets. If a required capability is absent, record its concrete external blocker rather than replacing production acceptance with a mock surface.
- Every ticket includes its own tests, CLI/SDK parity where applicable, failure behavior and evidence. Ticket 24 adds workload acceptance; it does not defer correctness to a final hardening stage.
- A shared TH row passes only after all listed contributing tickets supply the required evidence. The coverage table is traceability, not a claim of implementation. Preserve broader feature statuses until their complete owning-domain acceptance passes.
- Append implementation findings under a ticket’s Comments section. Leave the parent specification unchanged unless the user separately approves a scope revision. Commit only when asked.

## Acceptance coverage

All TH01–TH32 rows are unverified. Contributions may overlap because an end-to-end acceptance row spans several independently useful capabilities. Each ticket states the portion it must prove; the parent matrix remains authoritative.

| Spec acceptance | Contributing tickets |
|---|---|
| TH01 | [01](01-core-switch.md), [03](03-palettes-system-startup.md) |
| TH02 | [04](04-terminal-bindings.md), [07](07-code-diff-themes.md) |
| TH03 | [01](01-core-switch.md), [02](02-terminal-recovery.md), [03](03-palettes-system-startup.md) |
| TH04 | [12](12-offline-catalog.md), [24](24-appearance-under-load.md) |
| TH05 | [08](08-safe-preview.md) |
| TH06 | [03](03-palettes-system-startup.md) |
| TH07 | [03](03-palettes-system-startup.md), [09](09-ade-theme-library.md), [22](22-plugin-themes.md) |
| TH08 | [23](23-appearance-backup.md) |
| TH09 | [09](09-ade-theme-library.md) |
| TH10 | [10](10-ghostty-files.md), [11](11-ghostty-config.md) |
| TH11 | [01](01-core-switch.md), [10](10-ghostty-files.md) |
| TH12 | [05](05-cursor-selection.md) |
| TH13 | [01](01-core-switch.md) |
| TH14 | [01](01-core-switch.md), [02](02-terminal-recovery.md) |
| TH15 | [02](02-terminal-recovery.md), [04](04-terminal-bindings.md) |
| TH16 | [02](02-terminal-recovery.md), [24](24-appearance-under-load.md) |
| TH17 | [06](06-terminal-contrast-bold.md) |
| TH18 | [10](10-ghostty-files.md) |
| TH19 | [13](13-vscode-import.md), [14](14-openvsx-import.md) |
| TH20 | [11](11-ghostty-config.md), [13](13-vscode-import.md), [14](14-openvsx-import.md) |
| TH21 | [15](15-warp-import.md) |
| TH22 | [18](18-advanced-editor.md), [19](19-token-contrast-inspector.md), [20](20-simple-theme-generator.md) |
| TH23 | [17](17-accessible-appearance.md), [19](19-token-contrast-inspector.md), [20](20-simple-theme-generator.md) |
| TH24 | [21](21-linked-file-drafts.md) |
| TH25 | [07](07-code-diff-themes.md) |
| TH26 | [06](06-terminal-contrast-bold.md), [16](16-fonts-density-cursor.md), [17](17-accessible-appearance.md) |
| TH27 | [22](22-plugin-themes.md) |
| TH28 | [01](01-core-switch.md), [04](04-terminal-bindings.md), [09](09-ade-theme-library.md) |
| TH29 | [01](01-core-switch.md), [02](02-terminal-recovery.md), [24](24-appearance-under-load.md) |
| TH30 | [09](09-ade-theme-library.md), [12](12-offline-catalog.md) |
| TH31 | [03](03-palettes-system-startup.md), [17](17-accessible-appearance.md) |
| TH32 | [12](12-offline-catalog.md), [24](24-appearance-under-load.md) |

## Comments

2026-09-30: Ticket 10's Ghostty preview layout is verified on the corrected built desktop. Regression checks caught long-path horizontal overflow and scrollbar obstruction; text wrapping and a plain spacing wrapper fixed both while preserving the stock kit. Final full static passed (313 operations, 253 JavaScript tests, 341 renderer tests, 871 Rust tests, one existing skip), alongside 8 public-process and 7 desktop tests. The inspected screenshot shows complete controls and wrapped diagnostics. Cell-relative cursor fills, independent policy proposals, complete pixel evidence and approved prerequisites remain open; aggregate TH statuses are unchanged.

2026-09-29: Published the user-approved breakdown. No implementation work or completion claims were added.

2026-09-29: Accepted ticket 01 after its protocol, built-desktop and full static checks. All shared TH rows remain unverified until their complete contributing-ticket evidence is reconciled.

2026-09-29: Accepted ticket 02 after the final protocol, rebuilt desktop and static gates. Ticket 03 is next. Shared TH rows remain unverified pending complete contributing-ticket reconciliation.

2026-09-29: Accepted ticket 03 after the final static gate, 12 real-process protocol tests and 19 built-desktop/development-server appearance tests. Ticket Comments record managed-profile and corrupt-cache regressions and their fixes. Continue with ticket 04; shared TH rows remain unverified pending full contributing-ticket reconciliation.

2026-09-29: Accepted ticket 04 after the complete static gate, 24 real-process protocol tests and 23 built-desktop/development-server tests. Continue with 05. Corrected the work-order summary: ticket 17 still depends on 05 and 07, as its unchanged dependency edges state. Shared TH rows remain unverified pending complete contributor reconciliation.

2026-09-29: Accepted ticket 05 after real Ghostty width correction, shipped-font pixel tests, reverse-video and selection-isolation evidence, 26 protocol tests, 24 built-desktop tests and the final static gate (326 renderer tests, 863 Rust tests, 1 existing skip). Continue with 06. Shared TH rows remain unverified pending final matrix reconciliation.

2026-09-30: Ticket 09 is in progress. Its versioned ADE definition validation criterion passes through the daemon, CLI/SDK and built desktop. Installation, definition revisions, file import and all library mutations/export remain open. The final static gate passed (870 Rust tests, 340 renderer tests), alongside 4 protocol and 5 desktop tests. Details and limitations are in ticket 09; shared TH09/TH28 remain unverified as aggregates.

2026-09-30: Accepted ticket 09's import-preview/atomic accepted-set and stable-ID/replacement criteria. Definitions now persist in schema 23; list/inspect/install/rename/export have CLI/SDK/desktop paths. Final checks passed: 871 Rust tests, 340 renderer tests, 16 protocol tests and 8 built-desktop tests. Selecting/removing custom definitions, active-update propagation, custom color-preview revisions, coordinated packs and atomic export files remain open. All shared TH rows remain unverified as aggregates.

2026-09-30: Ticket 09 now supports explicit CLI pack-member installation and atomic CLI/SDK pack file export. Seven integrated real-process files passed 29 tests. Desktop pack export controls and final complete-operation reconciliation still prevent closure. Shared TH rows remain unverified pending all contributing tickets.

2026-09-30: Ticket 09's definition/pack export criterion is accepted. The desktop now supports paged member selection, captured revisions, explicit conflict review, data export and native atomic file publication with overwrite confirmation. Final full static, 29 real-process protocol tests and 19 rebuilt-desktop tests passed. Structured desktop error transport and complete-operation reconciliation still prevent ticket closure. Shared TH rows remain unverified as aggregates.

2026-09-30: All ticket 09's own acceptance criteria now pass, including structured desktop failure parity and CLI definition-revision selection fences. Final checks: full static gate, 30 real-process protocol tests and 52 rebuilt-desktop tests. Its status remains in progress to preserve the approved dependency on open ticket 08, which still awaits ticket 07's production code/file/diff consumers. Independent Ghostty file import preparation can proceed on the accepted library behavior; do not treat it as closure of those edges or aggregate TH rows.


2026-09-30: Ticket 10 is in progress as independent preparation on 09's accepted library behavior; its approved dependency stays open. Ghostty color-only file validation and explicit installation now run through native parsing, the common library, CLI/SDK and built desktop. Full static passed (312 operations, 253 JavaScript tests, 341 renderer tests, 871 Rust tests, one existing skip), with 13 real-process and 6 desktop checks. Native queries and WASM cells agree for imported extended entries and recovery preserves the shell. Cell-relative cursor fills, deterministic Ghostty export, uninstalled visual previews, optional policies and complete pixel acceptance remain open. All shared TH rows remain unverified.


2026-09-30: Ticket 10's deterministic Ghostty export criterion now passes through the daemon, CLI/SDK and native desktop file flow. Export discloses omitted data, round trips all supported terminal tokens, preserves opaque alpha as RGB and refuses stale revisions before publication. Full static passed (313 operations, 253 JavaScript tests, 341 renderer tests, 871 Rust tests, one existing skip), with 12 real-process and 9 built-desktop checks. Uninstalled visual previews, cell-relative cursor fills, optional policy proposals and complete pixel acceptance remain open. Approved dependency edges and aggregate TH statuses are unchanged.


2026-09-30: Ticket 10 now previews valid uninstalled Ghostty candidates using daemon-resolved colors and the shared isolated terminal sample. Invalid candidates have no preview. Full static passed (313 operations, 253 JavaScript tests, 341 renderer tests, 871 Rust tests, one existing skip), with 8 real-process and 7 desktop checks including a candidate background pixel and existing preview/cache/native-query isolation. Imported policy proposals, cell-relative cursor fills and complete pixel acceptance remain open. Dependency edges and shared TH statuses remain unchanged.


2026-09-30: Accepted ticket 06 after Ghostty color-import preference isolation, separate optional setting previews/acceptance, CLI/SDK parity, cancellation and conflict recovery. Full static passed (313 operations, 253 JavaScript tests, 341 renderer tests, 871 Rust tests, one existing skip), with 30 integrated public-process and 39 built-desktop tests. Ticket 10's common-library/preview/optional-policy criterion now passes, including independent valid settings from invalid colors. Its cursor fill/pixel work and approved prerequisites remain open. TH17 evidence is ready for final matrix reconciliation; shared TH26 and the complete acceptance matrix remain open.
