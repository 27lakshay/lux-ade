# App, terminal and code theming

Status: ready-for-agent
Type: specification
Scope: ADE v1; F013, F014, F056 and the appearance portion of F082; integration with F008, F015, F016, F019, F073 and F074
Decision: D20
Approved: 2026-09-29; the user accepted the research recommendations and requested this specification.
Implementation status: unimplemented against this specification; source inspection and design calculations are not acceptance evidence.

## Problem Statement

Users need a comfortable, consistent appearance across ADE's shell, conversations, code, diffs and persistent terminals. They should be able to use an existing Ghostty theme without losing its ANSI colors, cursor or selection behavior. They also need to choose different app, terminal and code colors, switch with the system, share themes, and recover from a broken custom theme without interrupting work.

ADE currently stores an appearance mode but has no installed theme library. Its terminal wrapper applies only foreground, background and cursor defaults, with a selection background overlay. Mounted terminal views do not subscribe to appearance changes. The native terminal core answers color-scheme queries as dark regardless of the visible app. A CSS-only change would leave terminal programs and their views disagreeing about colors.

The Pen handoff supplies 12 palettes with 73 color declarations each. Some roles have no consumer yet. A successful implementation must connect the colors to their owners and prove behavior across startup, live changes and recovery.

## Solution

Provide one profile-owned theme library with independently selectable app, terminal and syntax appearance. Ship all 12 ADE palettes. Default to system mode, Graphite for dark appearance and Chalk for light appearance. Terminals and syntax follow the app by default; users can select separate themes without changing the shell.

Support Ghostty color themes, a bundled offline terminal catalog, ADE theme import/export, VS Code theme conversion and Open VSX theme discovery. Provide previews, favorites, recent selections, an editor and a contrast report. Expose the same durable operations through the desktop, CLI and SDK.

Keep one effective terminal appearance for each terminal, shared by all its views and its native query responder. Apply changes without restarting processes, losing output or rebuilding editor state. Preserve application-supplied terminal color overrides. Keep typography, density and motion as explicit preferences independent of imported color themes.

## User Stories

### Selection and daily use

1. As a user, I want Graphite and Chalk as the default dark and light palettes, so that ADE starts with a complete appearance in either mode.
2. As a user, I want all 12 ADE palettes available, so that I can choose among the approved color candidates.
3. As a user, I want light, dark and system modes, so that appearance follows my preference or my operating system.
4. As a user, I want to choose my light and dark app palettes independently, so that system switching uses the pair I prefer.
5. As a user, I want terminal colors to follow the app by default, so that new terminals fit the workbench.
6. As a user, I want separate light and dark terminal choices, so that I can use familiar terminal palettes with any app palette.
7. As a user, I want a fixed terminal theme independent of app mode, so that I can keep a dark terminal inside a light app.
8. As a user, I want syntax colors to follow the app or use separate choices, so that code remains comfortable without forcing another shell palette.
9. As a user, I want search and mode filters in the theme library, so that I can find themes in a large catalog.
10. As a user, I want favorites and recent selections, so that I can return to themes without searching again.
11. As a user, I want names, modes, source and credits visible, so that I know what I am selecting.
12. As a user, I want keyboard-accessible theme commands, so that I can select a theme, change mode or restore defaults without opening settings.
13. As a user, I want each profile to keep its own appearance, so that unrelated profiles do not change together.
14. As a user, I want committed changes to reach every window in the profile, so that windows stay consistent.
15. As a user, I want ordinary browser pages to retain their own appearance, so that an ADE theme does not alter websites or their content.

### Preview, persistence and recovery

16. As a user, I want to preview app colors before applying them, so that I can compare choices without overwriting my saved selection.
17. As a user, I want a realistic terminal sample with ANSI, truecolor, selection and cursor states, so that I can inspect a terminal theme without disturbing a running program.
18. As a user, I want cancel to restore the latest committed appearance, so that a preview does not overwrite a change made in another window.
19. As a user, I want to preview both modes and code/diff samples, so that a theme's inactive variant is not a surprise later.
20. As a user, I want the native window and first page paint to match the selected palette, so that startup does not flash another color.
21. As a user, I want theme changes without intermediate color fades, so that text and controls remain readable throughout the switch.
22. As a user, I want my themes and preferences to survive daemon and desktop restarts, so that appearance does not depend on a window remaining open.
23. As a user, I want a visible fallback when a selected theme is missing or invalid, so that ADE remains usable and explains the change.
24. As a user, I want a core restore-defaults action available in safe mode, so that a faulty theme extension cannot block recovery.
25. As a user, I want save failures and conflicting edits explained, so that a preview is not mistaken for a persisted setting.
26. As a user, I want theme definitions included in supported profile backup and restore, so that restored selections can resolve without the original import files.

### Ghostty compatibility and terminal behavior

27. As a Ghostty user, I want to import a theme file, so that ADE uses the terminal colors I already know.
28. As a Ghostty user, I want to import my installed configuration through an explicit preview, so that named themes and color overrides are resolved in their proper order.
29. As a Ghostty user, I want separate named light and dark themes imported, so that my system-mode pairing is retained.
30. As a terminal user, I want all 256 indexed colors supported, so that themes with extended palette entries render correctly.
31. As a terminal user, I want cursor color and cursor text color supported, so that block cursors remain readable over different cells.
32. As a terminal user, I want selection foreground and background supported, so that selected text matches my theme and stays readable.
33. As a Ghostty user, I want supported named and cell-relative colors interpreted correctly, so that imports do not silently substitute another meaning.
34. As a terminal user, I want color queries to match the terminal's effective colors, so that terminal programs choose an appropriate appearance.
35. As a terminal user, I want light/dark query responses and supported change notifications to match terminal mode, so that full-screen programs can adapt.
36. As a terminal user, I want program-supplied color overrides preserved across theme changes, so that application rendering remains intentional.
37. As a terminal user, I want color reset sequences to reveal the current theme defaults, so that a reset does not resurrect an old palette.
38. As a terminal user, I want truecolor output preserved when changing ANSI themes, so that literal RGB content is not recolored accidentally.
39. As a user, I want all views of one terminal to agree on its appearance, so that attaching another window does not change what the process believes it is displaying.
40. As a user, I want an optional appearance override owned by a terminal, so that a specialized terminal can differ from profile defaults while its views remain consistent.
41. As a user, I want hidden, detached and newly mounted terminals to receive the latest appearance, so that reopening a tab shows current colors.
42. As a user, I want snapshot recovery to preserve appearance and program overrides, so that reconnecting changes neither process identity nor terminal meaning.
43. As a terminal user, I want selected ligatures, wide characters and combining marks to retain their geometry, so that selection and cursor colors do not distort text.
44. As a terminal user, I want optional contrast correction and bold-color behavior, so that I can improve readability while retaining a fidelity setting.
45. As a user, I want unsupported Ghostty settings listed, so that importing a color theme does not imply support for unrelated fonts, shaders or window effects.
46. As a Ghostty user, I want to export the compatible terminal colors, so that I can reuse an ADE terminal theme in Ghostty.

### Libraries, imports and authoring

47. As a user, I want a bundled terminal theme catalog available offline, so that choosing colors does not require a service or installed Ghostty application.
48. As a user, I want ADE theme files with version and provenance information, so that I can share reproducible themes.
49. As a user, I want an import preview with precise diagnostics, so that I can see applied, unsupported and invalid values before saving.
50. As a user, I want equivalent supported values after export and reimport, so that sharing does not change a theme's appearance.
51. As a user, I want stable theme identities independent of names, so that renaming a theme does not break selections.
52. As a user, I want duplicate and replacement choices for conflicting imports, so that an import cannot silently overwrite my edits.
53. As a VS Code user, I want local color-theme import, so that I can reuse workbench, terminal and syntax colors where ADE can map them.
54. As a user, I want Open VSX theme search and import, so that I can discover themes without installing executable extensions.
55. As a user, I want imported theme families grouped and ambiguous pairings left explicit, so that similar names do not select the wrong mode.
56. As a Warp user, I want a later YAML theme importer using the same terminal library, so that another source does not create a separate settings system.
57. As a user, I want to duplicate a built-in theme before editing it, so that catalog updates preserve the original and my custom version.
58. As a user, I want a simple surface-and-accent editor, so that I can create a usable draft without editing every semantic role.
59. As a theme author, I want an advanced editor for semantic, terminal and syntax colors, so that I can control the complete appearance.
60. As a theme author, I want to inspect which token colors an element, so that I can change the right role without searching source code.
61. As a theme author, I want a contrast report on real combinations and states, so that I can find unreadable text, focus and controls.
62. As a user, I want explicit reset and save-as actions, so that experimentation does not destroy a working theme.
63. As a theme author, I want optional watching of a deliberately linked theme file, so that edits can refresh a draft while malformed saves retain the last usable version.
64. As a user, I want theme deletion and catalog updates to explain affected selections, so that my appearance changes predictably.

### Code, accessibility and extension surfaces

65. As a user, I want syntax colors shared across code blocks, file previews and diffs, so that the same language constructs remain recognizable.
66. As a user, I want diff text, changed-word backgrounds and gutters themed together, so that additions and removals remain readable.
67. As a user, I want diagnostics, search results, selections and editor overlays included in the token contract, so that auxiliary code states do not retain unrelated colors.
68. As a user, I want UI, code and terminal font preferences separate, so that each surface can suit its reading task.
69. As a user, I want size, density and terminal line-height preferences, so that I can adapt readability without importing a different layout.
70. As a user, I want cursor shape and blink preferences, so that the terminal suits my visual needs.
71. As a user, I want reduced-motion and high-contrast preferences respected, so that appearance changes and focus remain accessible.
72. As a user, I want status information expressed through labels or icons as well as color, so that attention, errors and success remain distinguishable.
73. As a user, I want imported colors to leave my fonts, density and motion alone, so that a theme changes only the preferences I selected.
74. As a plugin author, I want declarative theme contributions with stable tokens, so that my theme works across built-in and extension surfaces.
75. As a user, I want removing or disabling a theme plugin to restore usable defaults, so that the profile remains operable without the plugin.
76. As a CLI or SDK user, I want to list, inspect, validate, install, select and export themes through public operations, so that automation has the same authority as the desktop.
77. As a user, I want appearance updates to preserve terminal processes, editor state and scroll positions, so that customization does not interrupt work.
78. As a user, I want large catalogs and rapid previews to stay responsive, so that theme discovery does not freeze the workbench.

## Implementation Decisions

### 1. Defaults, selections and scope

- Ship Graphite, Carbon, Chalk, Linen, Obsidian, Ink, Midnight, Onyx, Porcelain, Pearl, Ice and Quartz. Preserve all 73 handoff roles and their color values; normalized representations must paint equivalent sRGB colors.
- The profile defaults to system mode, Graphite in dark mode and Chalk in light mode. App light/dark slots accept matching-mode variants. Theme identity and mode are separate; variants are not inferred by mechanically inverting colors or matching names.
- Terminal binding has three explicit choices: follow the app, use separate light/dark terminal variants, or use one fixed terminal variant. Fixed terminal mode follows that variant, independently of app mode. Syntax has the same independent binding concept.
- Terminal overrides belong to terminal records, not tabs or panes. A terminal without an override follows the profile's terminal binding. A fixed override remains fixed through profile changes until reset. Restarting the same terminal record preserves its override.
- Typography, density, motion, cursor behavior and contrast policy are separate settings. Imported color data cannot implicitly change them. Optional appearance-setting import is an independently selected action with its own preview.
- Workbench themes apply to ADE-owned surfaces. Embedded websites and external application content retain their own styles and security boundaries.
- Ship macOS behavior within the existing v1 platform scope. Preserve portable contracts and adapters without claiming Windows/Linux release support.

### 2. Theme data and resolution

- A versioned definition has a stable namespaced ID, display name, supported mode or variants, app/terminal/syntax sections as applicable, origin, source version or digest, and author/license metadata when available. A terminal-only definition does not pretend to be an app theme. A coordinated pack groups compatible sections without forcing users to select them together.
- The theme library distinguishes bundled, imported, user-authored and plugin-provided definitions. Names may collide; IDs may not. Bundled definitions are immutable. Editing creates a custom definition or explicit overrides.
- Definitions, appearance preferences, resolved appearance, startup cache and preview are separate values. Store selections and normalized data in the daemon; keep temporary preview state in the requesting window.
- Resolve each selected section into a complete value before applying it. Explicitly declared defaults fill optional roles. Required app roles must be complete after validation. Nothing inherits from whichever theme was previously visible.
- Preserve every handoff role even when no consumer exists yet, and track its consumer or pending extension. Keep semantic names distinct when colors happen to match. The destructive-button preview sample remains a compositing reference, not a universal component background.
- Add terminal selection foreground and cursor text, richer syntax roles, code surface/selection/search/diagnostic roles, diff context/gutter/changed-word/conflict roles, and accessible control/focus roles as versioned extensions. Extend where a consumer needs them; do not guess values and claim Pen approval.
- Use the existing color library for parsing, derivation, contrast and gamut handling. Canonical stored colors are literal normalized sRGB values, with alpha or symbolic cell-relative values only in roles that explicitly support them. Preserve original import data separately for diagnostics where useful.
- Built-in and imported theme colors remain exact after declared normalization. Contrast repair or app-palette generation is an explicit authoring action that produces a draft. It never silently rewrites a source palette.
- Keep the resolver independent of React, Electron and the DOM. CSS is a projection. Computed browser colors are validation evidence, not the authority for native terminal defaults.
- Version the current format and reject unsupported versions visibly. D19 still applies: prelaunch schema changes do not require legacy migration chains, aliases or historical theme-format readers. Current-format export/import and current-profile backup remain mandatory.

### 3. Ownership and public interfaces

- The daemon owns installed theme definitions, profile appearance preferences, terminal overrides, favorites and recent committed selections. Durable appearance state participates in profile backup and restore. Imported definitions remain usable after their source files disappear.
- The runtime owns terminal execution, effective terminal defaults and program-supplied color overrides. The native core is the sole terminal-query responder. The WASM core renders matching state and never writes a second query response.
- Electron main owns native appearance, file pickers and the startup cache. The renderer owns transient previews and semantic CSS application. The CLI and SDK use the same application operations as the desktop.
- Extend the theme library and profile-settings contracts with list/inspect, validation, install/update/remove, selection/reset and export behavior. Include explicit target IDs, definition revisions and appearance revisions so stale edits cannot silently overwrite later changes. Validation and export return data; selecting an existing theme is an idempotent command.
- Queries are read-only. Theme installation with an explicit stable ID and desired content, updates, removals and selection changes are idempotent commands with documented conflict behavior. External effects use the existing effect-command receipt/reconciliation model when applicable; theme records do not invent another operation tier.
- Export serializes a chosen definition or a self-contained resolved pack. Writing a user-selected file is a host action after serialization, with visible overwrite behavior and atomic replacement. No export path writes the user's Ghostty configuration automatically.
- Public responses expose resolved mode, selected IDs, provenance, revision, fallback state and diagnostics. CLI failures return a nonzero result with machine-readable details. Generated contracts remain derived from Rust's typed definitions.
- Apply a validated mutation atomically and publish the resulting revision. On persistence failure, retain the committed value and show the failure. Runtime propagation failures remain visible as pending or failed convergence; do not claim the terminal has adopted colors until its appearance revision agrees.

### 4. System appearance and startup

- Explicit light/dark mode is authoritative. In system mode, the designated desktop owner for the profile's host reports OS appearance to the daemon. Reuse existing host-owner lifecycle machinery where available; terminal view attachment is not appearance authority.
- A headless profile retains the last accepted resolved system mode. With no observation, it uses dark/Graphite. A remote viewer or additional terminal attachment cannot replace that decision merely by connecting. This defines behavior without adding the deferred simultaneous-client product.
- The main process keeps one validated startup snapshot per profile, containing both selected app variants and the metadata needed to choose the initial mode. The snapshot includes the exact initial window/root background, resolved tokens and schema/revision information.
- Apply native light/dark mode, window background and pre-paint tokens before showing a window. In system mode, choose from the cached pair using the current local OS observation, then reconcile with daemon state. Never use a stale fixed color solely because the OS changed while ADE was closed.
- Cache writes are atomic and follow committed daemon state. Preview does not overwrite the persistent cache. Missing or invalid cache data uses Graphite/Chalk and reports a selected-theme problem after connection where applicable.
- Apply color changes as one coherent update with transition suppression. Notify non-CSS consumers explicitly, including same-mode palette changes. Theme changes do not rebuild terminal instances or editor documents.

### 5. Terminal synchronization and rendering

- Resolve one effective appearance per terminal. All views receive the same default palette and terminal mode, even when app chrome differs during local preview. Selection and cursor policies travel with that appearance; selection ranges remain view-local.
- Apply defaults to the native core before a new terminal program can query them. Include appearance revision and required rendering metadata in attachment state and recovery snapshots. Order appearance changes with runtime output processing and stream delivery, so a snapshot or delayed feed cannot revert newer colors.
- Extend the terminal wrapper to accept a complete 256-entry palette, default foreground/background/cursor, cursor-text and selection policies. Use the pinned Ghostty palette setter; do not inject escape sequences to implement user theme defaults.
- Begin from documented pinned Ghostty defaults, apply all explicit indexed entries, and preserve the conventional extended palette for unspecified indexes. Native and WASM implementations must consume identical resolved bytes. Check the pinned ABI rather than assuming another Ghostty package's layout or option numbers.
- Preserve OSC foreground/background/cursor and per-index overrides across default changes and snapshot restore. Resets reveal the newly selected defaults. Literal truecolor output remains unchanged by palette selection.
- Replace hardcoded dark reporting. Answer color queries from effective native state and issue supported light/dark change notifications only as the terminal protocol requires. Derive terminal mode from terminal appearance, including fixed dark terminals inside a light app.
- Maintain the latest requested appearance while WASM initialization is pending. Apply it after creation and after restore. Hidden views retain the revision and repaint when visible. Use the existing dirty/full-paint mechanism to recolor indexed cells without resending PTY history.
- Add selection foreground, cursor text and supported cell-relative colors to Canvas rendering. Preserve shaped text geometry, wide cells, combining marks and ligatures. Resolve symbolic colors against the correct underlying cell after reverse-video handling.
- Support explicit bold color and bright-palette behavior with documented precedence. Treat minimum contrast as a renderer policy, defaulting off for terminal fidelity; expose an opt-in floor and report that it modifies rendered colors. Policy changes must not rewrite stored PTY content or native color-query values.
- Keep font metrics and theme colors separate. Font changes may refit and resize the grid through existing ownership rules; color-only changes do not. Preserve process identity, selection and scroll position whenever the underlying change does not require their adjustment.

### 6. Ghostty import/export

- Support background, foreground, palette indexes 0–255, cursor-color, cursor-text, selection-background and selection-foreground. Support hex values, Ghostty-compatible X11 names, permitted empty resets, repeated palette assignments and supported cell-relative values according to the pinned format.
- Parse Ghostty's actual key/value grammar. Comments occupy their own lines; a hash in a color is data. Report invalid keys/values with source locations. Use documented precedence for duplicate values and per-index palette overrides.
- Theme-file import reads selected data only. Installed-config import is a separate explicit action that discovers current and legacy config filenames, XDG and macOS locations, named user/resource themes, absolute theme references and conditional light/dark references.
- Resolve theme defaults before explicit config overrides. Follow config includes only within the explicitly selected config-import operation, with cycle detection, depth/size limits and a source list in the preview. Theme files cannot recursively enable unrelated configuration behavior.
- Parse appearance settings such as minimum contrast, bold behavior and cursor opacity into separately selectable import results when supported. Otherwise list them as unsupported. Never interpret command, keybinding, shell or arbitrary executable settings as theme behavior.
- Report generated/harmonious palette options as unsupported until their exact behavior is implemented and tested. Ordinary 16-entry themes must not silently acquire a different extended palette algorithm.
- Export supported terminal values deterministically. List renderer-only policies and unrepresentable data as omissions. Importing an export restores equivalent supported colors, including extended palette entries.

### 7. Catalogs and other imports

- Bundle a pinned normalized snapshot of the Ghostty output from iTerm2-Color-Schemes, preserving names, source revision, attribution and license data. Loading and searching the bundled catalog works without network access or an installed Ghostty application.
- Catalog changes arrive through controlled app/data updates. Preserve user definitions and overrides. If an ID disappears, expose the missing selection and use a same-mode default; do not silently bind it to a different theme with a similar name.
- ADE JSON/JSONC import validates format, values and completeness before any mutation. Preview distinguishes normalization, required errors and unsupported extensions. Batch import reports each item and installs only the explicitly accepted valid set atomically.
- A conflict offers replace with revision checking or import as a distinct ID. Display names are not replacement authority. A theme's mode and section type must be clear before assigning it to a slot.
- VS Code import maps workbench colors, terminal colors and TextMate syntax rules into separate sections. Resolve includes within a bounded import root. Composite alpha against the documented destination surface where an opaque role is required. Keep unsupported semantic-token behavior and unmapped keys visible.
- Open VSX imports theme contributions as data only. Bound network responses, archive entries, expanded size, compression ratio, include depth and theme count; validate paths and sources; retain license/provenance information. Do not execute or install extension code. Search cancellation and download failures leave installed themes untouched.
- Group related imported themes as a collection. Suggest unambiguous light/dark pairs; keep ambiguous variants independent and let the user assign slots explicitly.
- Add Warp YAML import later in the same implementation program, through the common terminal normalization and diagnostics path. It does not introduce another theme store or mode setting.

### 8. Selection UI, preview and authoring

- Build unapproved appearance surfaces from the stock shadcn kit in the provisional UI area. Approved shell/layout geometry remains unchanged. Use ADE terms and semantic tokens; importing a palette is not approval for a new shell layout.
- The library supports search, light/dark and source filters, favorites, recent committed selections, provenance, ANSI swatches and a realistic sample. Use the existing virtual-list and command services where appropriate.
- Preview is local and temporary. It may recolor ADE-owned app chrome and isolated code/terminal samples, but does not mutate real terminal defaults, alter running TUI query responses, persist preferences or broadcast to other windows.
- Apply validates the intended selection against current revisions and commits it. Cancel or closing the preview reapplies the latest committed state, not an obsolete state captured when preview began. Conflicts offer rebase/retry rather than silently replacing a newer edit.
- Supply duplicate, rename, save-as, reset and delete actions. Built-ins are never edited in place. Before removing an active custom theme, show affected selections and the deterministic fallback.
- The simple editor derives a draft from a base surface and accent. The advanced editor exposes semantic roles, terminal palette/policies and syntax roles. Include both-mode samples, token-role inspection and a contrast report. Generated drafts carry no automatic accessibility certification.
- Optional file watching requires an explicitly linked file. It updates a draft using the same parser; malformed or partial saves retain the last valid draft with a diagnostic. Watching does not auto-apply or auto-persist a theme. Deletion, replacement and watcher shutdown are bounded and visible.

### 9. Code, accessibility and plugins

- Map semantic syntax roles to Shiki TextMate scopes for code blocks and previews, and to Pierre's theme adapter for diffs. Use CSS-variable colors where supported so palette-only changes recolor existing output without retokenizing everything.
- Define a CodeMirror adapter using editor surface styles and highlighting tags for code surfaces that already use CodeMirror or later receive it. This specification does not implement the excluded built-in editor. Declare mapping limits between TextMate scopes and CodeMirror tags.
- Separate syntax colors from editor chrome and diff surfaces. Cover selections, gutters, search, diagnostics, active lines, changed words and conflicts wherever those surfaces exist. Preserve documents, history, caret and scroll state through appearance changes.
- UI, code and terminal typography preferences have independent families and sizes, with readable fallbacks for unavailable fonts. Provide default and compact density presets through existing layout tokens; both must preserve focus, control reachability and the approved shell's structure. Terminal line height, supported font features, cursor shape and blink use the terminal's existing metric/input boundaries.
- Respect reduced motion. Add explicit high-contrast appearance support and stronger focus/control boundaries; consume available OS accessibility preferences, including reduced transparency and non-color differentiation. Preserve labels/icons for attention and other statuses.
- Validate normal text at 4.5:1 and essential non-text marks/control identification at 3:1 on actual adjacent fills. Test translucent states after compositing. ADE requires visible focus at full and kit opacity, but color ratios alone do not establish full WCAG compliance. Focus Appearance is an AAA criterion, not AA.
- Built-in themes must pass required contrast checks. If a required combination fails with the handed-off values, record the failing roles and obtain an explicit palette revision before acceptance; neither silently changing approved colors nor waiving the check resolves that conflict. Custom themes can retain intentional source colors while displaying diagnostics; an explicit repair creates an edited draft. A general contrast setting adjusts semantic roles with recalculated checks, not a whole-window CSS filter. Terminal correction remains separately controllable for fidelity.
- Plugin themes contribute declarative definitions and token metadata through the existing plugin lifecycle. Validate before registration, namespace IDs and remove only the provider's contributions. Theme data does not add arbitrary CSS or execute code.
- Plugin removal/disable and safe mode use same-mode core defaults, preserve enough identity to explain the missing selection, and keep restore-defaults available. Re-enabling a missing theme does not silently override a later explicit user choice.

### 10. Delivery boundaries

| Stage | Deliverable | Completion condition |
|---|---|---|
| 1 | Definitions, library, defaults and startup | All 12 palettes resolve; selections persist; native and first page colors agree. |
| 2 | Native/WASM terminal appearance | One palette change is proven across both cores, color queries, live views and snapshot recovery. |
| 3 | Selection and ADE/Ghostty interchange | Offline catalog, previews, diagnostics, CLI/SDK parity and equivalent exports work. |
| 4 | Code/diff integration and VS Code/Open VSX | Existing code surfaces share theme roles; imports report mapping limits and execute no extension code. |
| 5 | Authoring, plugins and advanced appearance | Editor, inspection, contrast, Warp import, linked-file drafts and plugin recovery pass acceptance. |

These stages order work; they do not remove later capabilities from this specification. The first vertical proof uses one palette across app startup, native terminal queries and WASM recovery before expanding catalog UI.

## Testing Decisions

### Boundaries and prior art

The user approved the research proposal's existing boundaries before this specification was written. Use two acceptance boundaries because neither alone can prove the whole feature:

1. **Public protocol, CLI and SDK over real daemon/runtime processes.** Prove profile isolation, theme mutations, persistence, exports, terminal query behavior, override preservation and recovery. Extend the existing scratch-profile settings tests and native/WASM terminal viewer scenarios.
2. **Built Electron desktop over the same scratch daemon/runtime fixtures.** Prove first paint, native background, visible colors, user interaction, preview cancellation, live terminal rendering and accessibility. Reuse the desktop launch/relaunch fixture and actual controls.

Prefer observable results over internal call counts, private database shapes or exported-symbol tests. Extend existing fixture seams rather than adding a theme-only test server. Use browser tests for computed contrast and renderer interactions, and pure-core tests for parsers, normalization, precedence and schema round trips. Those support, but do not replace, public acceptance.

Network imports use a deterministic HTTP/archive fixture exercising the real importer. Test failures and malformed inputs without live credentials or a mutable marketplace dependency. A live Open VSX smoke check is separate evidence. Tests use scratch homes and profiles, never the user's installed Ghostty configuration.

### Acceptance matrix

All rows begin unverified. Record evidence by acceptance ID when implementation lands.

| ID | Scope | Required observable evidence |
|---|---|---|
| TH01 | F013; stories 1–4 | All 12 app palettes resolve complete values; initial system mode selects Graphite/Chalk; chosen pairs switch correctly. |
| TH02 | F013/F082; 5–8, 40 | App, paired and fixed terminal/syntax bindings resolve independently; a fixed dark terminal reports dark inside a light app. |
| TH03 | F013/F008; 13–14, 22 | Two profiles remain isolated; windows in one profile receive committed changes; daemon and desktop restart preserve definitions/selections. |
| TH04 | F013; 9–12, 47, 78 | Search, filters, favorites, recents and keyboard commands work with the bundled catalog offline and remain responsive. |
| TH05 | F013; 16–19, 25 | Preview remains local; no real terminal defaults change; cancel restores the newest committed state; stale apply and persistence failure are visible. |
| TH06 | F013; 20–21 | Cold start and relaunch show matching native/document colors for arbitrary selected palettes; OS changes while closed resolve the cached pair correctly. |
| TH07 | F013/F056; 23–24, 64, 75 | Missing definitions, invalid cache and disabled/removed plugins produce explained fallbacks; safe-mode reset works. |
| TH08 | F013; 26 | Current-profile backup/restore contains imported themes, choices and overrides without requiring their original source files. |
| TH09 | F013; 48–52 | ADE import/export preserves supported values; malformed/unsupported versions fail before mutation; replacement conflicts require current revisions. |
| TH10 | F013/F082; 27–29, 33, 45 | Ghostty files/configs resolve named themes, pairs, duplicate entries and explicit overrides; X11/cell-relative/reset values behave as declared; unsupported keys carry diagnostics. |
| TH11 | F082; 30 | Verify all 256 palette entries through native color queries and the attached WASM view, including custom entries above 15 and omitted-index defaults. |
| TH12 | F082; 31–32, 43 | Cursor and selected text remain legible and geometrically stable on ANSI/truecolor cells, reverse video, wide characters, combining marks and ligatures. |
| TH13 | F082; 34–35 | A real terminal program sees correct colors and scheme before any view mounts, while hidden and after changes; supported notifications are emitted once. |
| TH14 | F082; 36–38 | Set OSC overrides, change theme, query and render retained overrides, reset them and observe new defaults; literal RGB content stays unchanged. |
| TH15 | F082; 39–42 | Two views share terminal appearance; detach/reconnect, daemon replacement and resync preserve process identity, palette, mode and overrides. |
| TH16 | F082; 41, 77 | Change theme while a surface initializes or is hidden; eventual view shows latest colors without terminal restart, output replay or lost selection/scroll. |
| TH17 | F082; 44 | Contrast correction has an off/fidelity mode; bold policy and rendered correction are verified without changing protocol colors or stored output. |
| TH18 | F013/F082; 46 | Ghostty export/reimport preserves every supported terminal value and reports unrepresentable policies. |
| TH19 | F013; 53–55 | VS Code and Open VSX import workbench/terminal/syntax sections, includes, alpha and collections; ambiguous pairings remain explicit. |
| TH20 | F013; 49, 54 | Oversized/malformed archives, path escapes, include cycles, cancellation and failed downloads leave installed data unchanged; no extension code runs. |
| TH21 | F013; 56 | Warp YAML import produces the same terminal model and diagnostics as other sources. |
| TH22 | F013; 57–62 | Duplicate/edit/save-as/reset/delete preserve built-ins; simple and advanced drafts preview correctly; token inspection identifies the affected role. |
| TH23 | F013; 61, 71–72 | Every built-in's text, controls, focus, destructive alpha states, diff and terminal samples meet required contrast; status remains understandable without color alone. |
| TH24 | F013; 63 | Linked-file changes update drafts; partial/malformed saves and deletion retain last usable data and show diagnostics; no automatic apply occurs. |
| TH25 | F013/F073/F074; 65–67 | Existing code blocks, file previews and diff states adopt syntax and surface colors; theme switches preserve document/scroll state; mappings disclose limits. |
| TH26 | F014/F019/F082; 68–73 | Fonts, sizes, density, line height, cursor and motion persist; fallback fonts remain readable; color imports leave these preferences alone. |
| TH27 | F056; 74–75 | A declarative plugin theme reaches built-in and plugin surfaces; disabling/removing it preserves work and exposes core fallback. |
| TH28 | F013/F082; 76 | CLI/SDK validation, installation, selection, reset and export match desktop behavior, including errors and revision conflicts. |
| TH29 | F013/F082; 22, 25, 42 | Race selection changes with output, snapshots and daemon reconnect; no observer reverts a newer appearance revision or reports false convergence. |
| TH30 | F013; 10–11, 51, 64 | Rename, catalog update, duplicate names and ID removal preserve favorites/custom edits or expose explicit fallback; source attribution remains available. |
| TH31 | F013/F019; 15, 71 | App theming leaves browser content untouched; available high-contrast/reduced-motion preferences and keyboard focus remain effective. |
| TH32 | F013/F082; 77–78 | Under the existing multi-terminal workload, color changes keep process IDs and output intact; record switch latency, input latency and memory, including slow consumers. |

Run the repository static gate for changes, headless protocol E2E for backend acceptance and built-desktop E2E for visible behavior. Review the real app's hover, focus, selected text, sidebars, splits, overlays and terminal state. Record unsupported surfaces as dependencies rather than substituting a synthetic showcase for production acceptance. No aggregate feature is complete until its required rows and owning-domain dependencies pass.

## Out of Scope

- Implementing the excluded built-in code editor, PR management or other unrelated file/Git features. CodeMirror receives an adapter boundary; it does not reopen F072.
- Replacing Ghostty with xterm.js or the ghostty-web package, changing process ownership, or moving terminal output into React state.
- Full Ghostty application/config compatibility: shell commands, arbitrary keybindings, shaders, background images, blur/vibrancy and arbitrary theme CSS are outside this spec.
- Automatic extended-palette generation/harmonization. Detect and report these options; add their exact semantics only through a later explicit scope change.
- Automatically recoloring truecolor program output or silently repairing imported source colors. Explicit contrast policy and authoring drafts have their stated scope.
- A theme marketplace backend, cloud account sync, mobile/browser products, simultaneous-client UX or cross-platform release work.
- Automatic changes to the user's Ghostty/Warp files, automatic catalog updates from arbitrary URLs, or executing imported VS Code extensions.
- Layout redesign, changes to the approved shell, and automatic theme-driven changes to fonts, density or motion.
- Legacy prelaunch migrations, historical format compatibility and claims of full accessibility certification based on color calculations alone.

## Further Notes

### Approval, ownership and evidence

The user approved the research choices and requested this specification on 2026-09-29. D20 records the decision. The scope is ready for agent work when implementation is requested; this publication does not implement it, create implementation tickets or authorize a commit.

F013/F014 remain owned by the foundation domain, F056 by plugins, and F082 by terminals. This is their shared detailed appearance contract. Existing F073/F074 acceptance does not prove TH25; their broader implementation status is preserved. D06 governs Ghostty and sole query responses, D18 governs daemon authority, and D19 governs prelaunch compatibility.

The research inspected ADE at efc8ad3 and clean fast-forwarded reference checkouts: Orca 31012aeb, T3 Code d2c9281b and OpenCode GUI v2 7ef4a1a. No reference-app runtime acceptance was performed. Orca's imports and hidden-terminal responder, T3 Code's authoring workflow, and OpenCode's semantic syntax mapping are design references. Their limitations are not ADE's compatibility contract. Copied implementation code requires the repository's attribution and license notice process.

### Local references

- [Palette handoff and all 876 color values](../../../docs/theme-palette-handoff.md). This specification supersedes its unresolved shipping-scope/default decisions; the palette values remain the source data. Reconcile newer Pen revisions explicitly before changing those values.
- [Current architecture](../../../docs/architecture.md), [domain vocabulary](../../../CONTEXT.md), [library choices](../../../docs/agents/libraries.md), and [terminal integration guidance](../../../docs/agents/terminal.md).
- [Decision register](../decisions.md), [foundation](spec.md), [plugins](../04-plugins/spec.md), [terminals](../07-terminals-services/spec.md), and [files/diffs](../06-files-git/spec.md).
- [Protocol E2E fixtures](../../../e2e/protocol/README.md), [desktop E2E fixtures](../../../e2e/desktop/README.md), [settings prior art](../../../e2e/protocol/profiles/settings.spec.ts), and [native/WASM recovery prior art](../../../e2e/protocol/terminals2/screen.spec.ts).

### Primary external references and package decisions

| Source | Application to this specification |
|---|---|
| [Ghostty configuration](https://ghostty.org/docs/config), [themes](https://ghostty.org/docs/features/theme), [option reference](https://ghostty.org/docs/config/reference) | Grammar, precedence, names, variants and compatibility diagnostics. |
| [Ghostty colors](https://ghostty.org/docs/vt/concepts/colors), [OSC 4](https://ghostty.org/docs/vt/osc/4), [OSC 104](https://ghostty.org/docs/vt/osc/104) | Default/override behavior, queries and resets; verify against ADE's pinned ABI. |
| [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) | Pin its generated Ghostty catalog and preserve provenance. |
| [Culori](https://culorijs.org/api/) | Reuse for color mathematics; do not add a second math stack without a concrete missing capability. |
| [Shiki](https://shiki.style/guide/theme-colors), [CodeMirror](https://codemirror.net/examples/styling/), [Pierre Diffs](https://diffs.com/docs) | Reuse the selected code/diff stack and verify pinned APIs. |
| [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme) | Native mode and available accessibility signals. |
| [shadcn theming](https://ui.shadcn.com/docs/theming) | Preserve stock components and semantic CSS roles. |
| [Open VSX](https://github.com/eclipse-openvsx/openvsx), [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | Theme discovery and data parsing; existing ZIP/YAML packages cover additional formats. |
| [react-colorful](https://github.com/omgovich/react-colorful) | Optional small picker for the authoring UI; use native/kit inputs until needed. |
| [Style Dictionary](https://styledictionary.com/reference/hooks/formats/) | Optional build-time export tooling if multiple output targets justify it; not a required runtime dependency. |

Read current official agent resources and pinned APIs before integrating packages. The snapshot does not require copying another app's localStorage preference model or custom color-math implementation.
