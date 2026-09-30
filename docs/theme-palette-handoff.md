# ADE theme handoff — final 12 palette candidates

Snapshot: 29 September 2026. Source: `/Users/lakshyakumar/Documents/ade.pen`, read through Pen MCP after the token-completion pass.

## Start here

The 12 palettes are complete color-token candidates in Pen. They have not been installed as ADE runtime themes. The user requested this handoff document; it does not authorize selecting a default, changing the app, committing, or publishing.

The remaining product decision is whether to ship one dark/light pair or expose all 12. The earlier recommendation was one pair first, but the user has not selected the pair or approved a theme picker. Six palettes are dark and six are light; no automatic dark/light family pairing has been agreed.

Read the repository and desktop instructions before implementing. Work on `main`, preserve existing uncommitted work, use pnpm, and commit only on request. The working tree already contains shell/navigation changes and an unrelated testing-infrastructure document.

This document contains every final semantic color value: **12 × 73 = 876 values**. “Complete” refers to this color contract. Typography, spacing, radii, motion, component behavior, editor token scopes, and full accessibility certification are outside that claim.

The export was checked against all **44 color aliases** currently exported by shadcn.css; every palette supplies all 44. Each appendix block has the same 73 unique token names. Repository links and exported values were checked when this document was created.

## Decisions and visual intent

- ADE is a dense development environment. Prioritize sustained reading, clear selection, and legible code and terminal output.
- Keep large surfaces close to neutral. The user rejected excessive tint and vibrancy; these values include that reduction.
- Use surface fills to separate chrome, sidebars, panes, and content blocks. Borders remain subtle decoration unless needed to identify a control.
- The selected dark direction gets lighter inward. Light candidates retain a light pane and distinguish surrounding chrome and interaction states; do not mechanically invert dark RGB values.
- Keep status foregrounds distinct from quiet tinted status backgrounds. Use icons and labels alongside color.
- In ADE, amber `attention` means **needs you**. It is not generic decoration.
- Preserve layout decisions separately from palette selection. Palette demo screens include a siderail; current app shell work removed it. Porting a palette is not approval to reintroduce a siderail or replace the shell layout.
- The earlier glass experiments are separate from these 12 opaque palettes. Blur/transparency requires new tests against the actual backdrop.

## Where to read the implementation

Paths below are relative to the repository root.

| File | Responsibility |
| --- | --- |
| [Desktop instructions](../apps/desktop/AGENTS.md) | Desktop workflow and verification |
| [Design rules](../apps/desktop/DESIGN.md) | Stock kit, fill separation, typography, icon and motion rules |
| [Theme CSS](../apps/desktop/src/renderer/src/shadcn.css) | Current shadcn and ADE semantic color variables |
| [Contrast tests](../apps/desktop/src/renderer/src/app/contrast.test.ts) | Computed CSS contrast, opacity, status and button checks |
| [Theme tests](../apps/desktop/src/renderer/src/app/theme.test.ts) | Window/background agreement and appearance behavior |
| [Renderer theme](../apps/desktop/src/renderer/src/app/theme.ts) | Light/dark/system mode and settings calls |
| [Boot script](../apps/desktop/src/renderer/public/theme-boot.js) | Pre-paint mode and color-scheme |
| [Window chrome](../apps/desktop/src/shared/window-chrome.ts) | Electron initial window backgrounds |
| [Main appearance](../apps/desktop/src/main/appearance.ts) | Native appearance and startup cache |
| [Main settings](../apps/desktop/src/main/settings.ts) | Existing settings bridge |
| [Terminal theme adapter](../packages/terminal/src/theme.ts) | Converts rendered CSS colors into Ghostty theme values |
| [Ghostty core](../packages/terminal/src/ghostty/core.ts) | Theme interface and native setters |
| [Terminal API](../packages/terminal/src/index.ts) | Terminal instance and setTheme |
| [Terminal renderer](../packages/terminal/src/ghostty/renderer.ts) | Selection compositing and painted output |

Verified against code on the snapshot date:

- Appearance is `light | dark | system`. The daemon profile owns the setting. Main keeps the startup copy; the renderer follows it. The boot script uses `prefers-color-scheme`. Keep that ownership; do not add a competing localStorage preference.
- `WINDOW_BACKGROUND` is tested against CSS `--background`. A palette change must keep the initial Electron paint in agreement with the page.
- Theme changes suppress intermediate color transitions via `theme-switching`.
- The CSS exports `destructive-foreground` but the inspected current theme definitions omit its value. The palette contract below supplies it.
- Ghostty currently exposes foreground, background, cursor, and optional selectionBackground. Its theme interface has **no ANSI palette field**. The native setter currently sets options 11/12/13 only.
- The terminal adapter currently derives text from CSS `color`, background from the nearest opaque ancestor, cursor from foreground, and selection from foreground at 25% opacity. New terminal CSS variables alone will not change that behavior.
- Syntax variables below are a design proposal for an eventual code-renderer mapping, not evidence of an installed editor theme.

## Token contract

### Names that must not be confused

Pen primitives used `palette-…-accent` for the action/link color. ADE `--accent` means an interaction background. The semantic export below already corrects this.

Pen primitives used `palette-…-sidebar` for navigation. ADE `--sidebar` means outer chrome; `--panel` means the floating left/right sidebar surface.

Use **`theme-…` values**, not the older `palette-…` primitive sets. The original primitives remain in Pen for provenance and can contain the pre-correction focus/destructive values.

### Roles

| Tokens | Intended use |
| --- | --- |
| sidebar, base, panel | Outer chrome, gutters, navigation/inspector surfaces |
| background, foreground | Pane surface and primary text |
| card / card-foreground | Blocks inside a pane |
| popover / popover-foreground | Menus, tooltips, overlays |
| primary / primary-foreground | Main action and its text/icon |
| secondary / secondary-foreground | Secondary action and its text/icon |
| muted / muted-foreground | Quiet interaction fill and supporting text/icons |
| accent / accent-foreground | Selection/interaction fill and its text |
| border | Decorative separators; not a guaranteed accessible control boundary |
| input | Stronger control boundary; validate against actual adjoining fills |
| ring | Focus color, tested at full strength and 50% opacity |
| sidebar-foreground, sidebar-primary, sidebar-primary-foreground, sidebar-accent, sidebar-accent-foreground, sidebar-border, sidebar-ring | Stock sidebar component aliases |
| attention / attention-muted | Needs-you mark/text and quiet background |
| running | Running status mark |
| success / success-muted | Completed/success mark/text and background |
| destructive / destructive-foreground / destructive-muted | Error/destructive foreground, inverse text, quiet background |
| diff-add / diff-add-muted | Added-line text and background |
| diff-remove / diff-remove-muted | Removed-line text and background |
| terminal, terminal-foreground, terminal-selection, terminal-cursor | Terminal surface, text, selected cells, cursor |
| terminal-ansi-0 through terminal-ansi-15 | Proposed ANSI slots: black/red/green/yellow/blue/magenta/cyan/white, then bright equivalents |
| info / info-muted, link | Informational content and link foreground |
| chart-1 through chart-5 | Chart series examples; labels remain required |
| syntax-keyword, syntax-string, syntax-number, syntax-comment, syntax-default | Minimal representative code colors |
| destructive-button-bg | Pen preview of destructive tinted over card; see compositing rule below |

Aliases may intentionally share a value. Keep semantic names even when current values match; do not merge roles just because their hex values are equal.

The 73-token contract includes extensions beyond today's CSS API: success-muted, terminal foreground/selection/cursor/ANSI, info, link, syntax, and the destructive preview token. Add consumers only where needed and inspect existing Tailwind exports before introducing new ones.

### Compositing and state rules

- All exported values below are opaque sRGB hex colors.
- Focus: use the dedicated ring value. The kit draws ring at 50% opacity; the Pen examples also show that treatment. Primary/action color is not an interchangeable focus token.
- Destructive kit buttons use foreground `destructive` over `destructive/10` in light mode or `destructive/20` in dark mode. Retain the actual component compositing rule. `destructive-button-bg` is a flattened Pen sample over `card`, not a universal background to paste onto every surface.
- Status/diff muted values are final opaque sample backgrounds. Do not apply another opacity to them and expect the same contrast.
- Hover, selected, focus, and disabled are different states. Selected rows use accent plus a marker/icon. Disabled samples use reduced opacity, but muted readable content is not disabled.
- ANSI “black” is lifted in dark themes to remain readable; it is a slot name, not literal black.
- The chart palette reuses semantic hues and is not proven categorically distinct. Avoid using an amber series as decorative chrome or implying status accidentally. Label series and test adjacent series if they touch.
- A full syntax theme needs more scopes than the five example roles. Map required scopes explicitly, then test real code.

## Contrast requirements and evidence

Normal text, placeholders, hover text, diff text, and button labels need at least **4.5:1** against their actual backgrounds. Large text has a 3:1 exception, but dense ADE UI should use the 4.5:1 target. Values just below the threshold cannot be rounded into a pass. [W3C: Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Essential icons, control identification, and meaningful graphical objects need **3:1** against adjoining colors where applicable. Decorative separators are a different case. A palette calculation does not establish which boundaries are essential in a rendered UI. [W3C: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

ADE's focus test checks 3:1 at full strength and 50% opacity across eight fills. Focus area, visibility, and obstruction also need runtime review. **WCAG 2.2 Focus Appearance (2.4.13) is AAA**, not AA; the current test comment loosely groups it with AA. Passing color ratios alone does not demonstrate that criterion. [W3C: Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html).

### Final Pen audit

The final audit ran **1,596 checks, zero failures**: 133 per palette.

| Pairings per palette | Count | Threshold |
| --- | ---: | ---: |
| foreground and muted-foreground across eight fills | 16 | 4.5 |
| attention, running, success, destructive across eight fills | 32 | 3 |
| diff-add and diff-remove across eight fills | 16 | 4.5 |
| ring at full and 50% strength across eight fills | 16 | 3 |
| Primary/secondary labels; destructive preview; attention, success, destructive, info, and both diff pairs | 9 | 4.5 |
| Supporting text on four status backgrounds | 4 | 4.5 |
| 16 ANSI colors on terminal and terminal-selection | 32 | 4.5 |
| Five chart colors on pane background | 5 | 3 |
| Destructive foreground on its actual tint over background, card, popover | 3 | 4.5 |

Eight fills: sidebar, base, panel, background, card, popover, muted, accent.

The calculation used WCAG relative luminance, sRGB compositing for opacity, and rounded blended channels to 8-bit hex. Browser computed-color tests should recheck actual floating-point compositing; the exported ring values have a small margin above 3:1.

| Palette | Mode | Minimum muted text across eight fills | Minimum 50% ring across eight fills |
| --- | --- | ---: | ---: |
| Graphite | dark | 5.15 | 3.11 |
| Carbon | dark | 5.64 | 3.11 |
| Chalk | light | 5.39 | 3.11 |
| Linen | light | 5.13 | 3.10 |
| Obsidian | dark | 6.04 | 3.10 |
| Ink | dark | 6.32 | 3.12 |
| Midnight | dark | 5.92 | 3.13 |
| Onyx | dark | 6.51 | 3.12 |
| Porcelain | light | 5.45 | 3.13 |
| Pearl | light | 5.45 | 3.13 |
| Ice | light | 5.14 | 3.11 |
| Quartz | light | 5.41 | 3.12 |

Prior failures corrected: all 12 original action-colored rings failed at 50% opacity; four V2 dark destructive colors failed on 20% self-tint. Separate ring values and adjusted destructive foregrounds fix those measured cases without changing the chosen primary accents.

All 12 screens were checked for missing variable references and fixed-size bounds; no issues were found. Dark Obsidian and light Pearl were visually inspected after adding the examples.

### Limits of the evidence

This audit is a design-level calculation, not a runtime test suite or full accessibility review. The 1,596 count excludes full editor syntax coverage, color-vision simulation, all boundary cases, focus area/obstruction, glass backgrounds, browser content, and arbitrary application-supplied terminal colors. Default terminal foreground/cursor and filled destructive controls need runtime pair checks too. ANSI pairs passing against two backgrounds does not prove every terminal SGR foreground/background combination.

Each demo shows representative UI: shell/navigation, selection and hover, code, diff, approval, success/error/info, composer, focused secondary action, popover, focused input, disabled action, destructive action, tooltip, terminal selection/ANSI swatches, and labeled chart. It does not place every alias in a unique visible element.

## Implementation plan for the next agent

1. **Resolve shipping scope.** Confirm a dark/light pair or all-12 selection. Completion: named defaults and behavior for light, dark, and system mode are explicit.
2. **Reconcile the snapshot.** Read current instructions, code, and Pen frames. Compare any newer theme variables against this export. Completion: all 73 roles are either mapped, designated as pending extensions, or explicitly unused.
3. **Apply semantic values.** For a single pair, update the light and dark definitions in shadcn.css. For all 12, use a palette registry/selector while preserving mode semantics. Components continue consuming semantic names. Completion: no partial palette can inherit unrelated colors from another palette.
4. **Integrate startup and settings.** Follow the existing daemon-backed appearance flow. If adding palette identity, inspect contracts and settings ownership before changing them; generate contracts through pnpm contract:generate when required. Keep Electron startup background, boot state, native mode, and renderer aligned. Completion: cold start, reload, system change, and reopened windows show the intended colors without a flash.
5. **Wire terminal and code consumers.** Use the existing terminal adapter and setTheme pathway. ANSI requires interface/native support; consult pinned Ghostty API and official agent/docs resources before integration. Preserve terminal output outside React state. Completion: existing and new terminal panes repaint correctly, including selection/cursor, with supported scope documented.
6. **Verify the real controls.** Extend contrast tests to iterate every shipped palette and actual alpha states. Verify accessible input boundaries and selected states in context. Test overlays and controls on their true parent surfaces. Completion: all required contrast assertions pass from computed CSS.
7. **Inspect the running app.** Use the drive-ade-app skill. Check full-height panes, expanded/collapsed sidebars, horizontal/vertical splitting, menus/dialogs, focus, hover, selection, approval/diff/status, terminal/code, and theme switching. Completion: screenshots and interaction checks agree with the approved shell and chosen palette.
8. **Run the repository gates and report.** Run pnpm check:static. Use desktop E2E for changed desktop behavior, per its README. Report known limitations and changed files; leave the work uncommitted unless requested.

Keep typography, layout, motion, and stock kit styling unchanged during a color-only port. Any request to adopt a different shell or add a picker is separate scope.

## Palette inventory

Pen variable prefix is `theme-<key>-`. CSS suffixes in the appendix are the semantic names without that prefix. The selectors below are export labels, not an approved runtime selection API.

| Key | Name | Mode | Pen screen ID |
| --- | --- | --- | --- |
| graphite | Graphite | dark | `l1gJB` |
| carbon | Carbon | dark | `KBgk5` |
| chalk | Chalk | light | `x3T1y` |
| linen | Linen | light | `pkdTw` |
| v2-obsidian | Obsidian | dark | `WOeL2` |
| v2-ink | Ink | dark | `HEOvo` |
| v2-midnight | Midnight | dark | `a43hs` |
| v2-onyx | Onyx | dark | `j7FzS` |
| v2-porcelain | Porcelain | light | `fWoCu` |
| v2-pearl | Pearl | light | `NmkD6` |
| v2-ice | Ice | light | `JmxsL` |
| v2-quartz | Quartz | light | `W2my9` |

The retained V1 candidates are Graphite, Carbon, Chalk, and Linen. Slate, Evergreen, Mist, and Sage were deleted by the user. All eight V2 candidates remain. Earlier layout/glass frames are outside this inventory.

## Complete final values

These CSS blocks are generated directly from the final Pen semantic variables, without color conversion or manual transcription. Each block has exactly 73 declarations. Copy values into the selected implementation mechanism; do not infer runtime selector behavior from these export labels.

### Graphite — dark

Pen prefix: `theme-graphite-`.

```css
[data-ade-palette="graphite"] {
  --background: #1D1F23;
  --foreground: #ECEEF2;
  --card: #272A30;
  --card-foreground: #ECEEF2;
  --popover: #272A30;
  --popover-foreground: #ECEEF2;
  --primary: #8AB4F8;
  --primary-foreground: #101113;
  --secondary: #30343B;
  --secondary-foreground: #ECEEF2;
  --muted: #30343B;
  --muted-foreground: #A9B0BC;
  --accent: #283C55;
  --accent-foreground: #ECEEF2;
  --destructive: #ff9a9a;
  --destructive-foreground: #101113;
  --border: #43454b;
  --input: #818B9A;
  --ring: #bbd4fb;
  --sidebar: #101113;
  --sidebar-foreground: #ECEEF2;
  --sidebar-primary: #8AB4F8;
  --sidebar-primary-foreground: #101113;
  --sidebar-accent: #283C55;
  --sidebar-accent-foreground: #ECEEF2;
  --sidebar-border: #2f3032;
  --sidebar-ring: #bbd4fb;
  --base: #101113;
  --panel: #17181B;
  --attention: #E6C17A;
  --attention-muted: #35322d;
  --running: #9DBBFF;
  --success: #80D6A5;
  --success-muted: #293533;
  --destructive-muted: #3f3135;
  --diff-add: #80D6A5;
  --diff-add-muted: #293533;
  --diff-remove: #ff9a9a;
  --diff-remove-muted: #3f3135;
  --terminal: #101113;
  --terminal-foreground: #ECEEF2;
  --terminal-selection: #283C55;
  --terminal-cursor: #ECEEF2;
  --info: #9DBBFF;
  --info-muted: #2c323d;
  --link: #8AB4F8;
  --chart-1: #9DBBFF;
  --chart-2: #80D6A5;
  --chart-3: #E6C17A;
  --chart-4: #ff9a9a;
  --chart-5: #8AB4F8;
  --syntax-keyword: #8AB4F8;
  --syntax-string: #80D6A5;
  --syntax-number: #E6C17A;
  --syntax-comment: #A9B0BC;
  --syntax-default: #ECEEF2;
  --destructive-button-bg: #524045;
  --terminal-ansi-0: #a9b0bc;
  --terminal-ansi-1: #ff9a9a;
  --terminal-ansi-2: #80d6a5;
  --terminal-ansi-3: #e6c17a;
  --terminal-ansi-4: #9dbbff;
  --terminal-ansi-5: #c4a7c9;
  --terminal-ansi-6: #8fc9d2;
  --terminal-ansi-7: #eceef2;
  --terminal-ansi-8: #b6bcc7;
  --terminal-ansi-9: #fbabac;
  --terminal-ansi-10: #96dbb4;
  --terminal-ansi-11: #e7ca92;
  --terminal-ansi-12: #adc5fc;
  --terminal-ansi-13: #ccb5d1;
  --terminal-ansi-14: #a2d0d8;
  --terminal-ansi-15: #eceef2;
}
```

### Carbon — dark

Pen prefix: `theme-carbon-`.

```css
[data-ade-palette="carbon"] {
  --background: #25211D;
  --foreground: #F1EDE6;
  --card: #302B25;
  --card-foreground: #F1EDE6;
  --popover: #302B25;
  --popover-foreground: #F1EDE6;
  --primary: #E6B66D;
  --primary-foreground: #151311;
  --secondary: #3C352D;
  --secondary-foreground: #F1EDE6;
  --muted: #3C352D;
  --muted-foreground: #BDB1A1;
  --accent: #423524;
  --accent-foreground: #F1EDE6;
  --destructive: #ff9f9f;
  --destructive-foreground: #151311;
  --border: #4b4640;
  --input: #958573;
  --ring: #ecc890;
  --sidebar: #151311;
  --sidebar-foreground: #F1EDE6;
  --sidebar-primary: #E6B66D;
  --sidebar-primary-foreground: #151311;
  --sidebar-accent: #423524;
  --sidebar-accent-foreground: #F1EDE6;
  --sidebar-border: #34322f;
  --sidebar-ring: #ecc890;
  --base: #151311;
  --panel: #1D1A17;
  --attention: #E6C17A;
  --attention-muted: #3c3428;
  --running: #9DBBFF;
  --success: #80D6A5;
  --success-muted: #30372d;
  --destructive-muted: #463431;
  --diff-add: #80D6A5;
  --diff-add-muted: #30372d;
  --diff-remove: #ff9f9f;
  --diff-remove-muted: #463431;
  --terminal: #151311;
  --terminal-foreground: #F1EDE6;
  --terminal-selection: #423524;
  --terminal-cursor: #F1EDE6;
  --info: #9DBBFF;
  --info-muted: #333338;
  --link: #E6B66D;
  --chart-1: #9DBBFF;
  --chart-2: #80D6A5;
  --chart-3: #E6C17A;
  --chart-4: #ff9f9f;
  --chart-5: #E6B66D;
  --syntax-keyword: #E6B66D;
  --syntax-string: #80D6A5;
  --syntax-number: #E6C17A;
  --syntax-comment: #BDB1A1;
  --syntax-default: #F1EDE6;
  --destructive-button-bg: #59423d;
  --terminal-ansi-0: #bdb1a1;
  --terminal-ansi-1: #ff9f9f;
  --terminal-ansi-2: #80d6a5;
  --terminal-ansi-3: #e6c17a;
  --terminal-ansi-4: #9dbbff;
  --terminal-ansi-5: #f3ab86;
  --terminal-ansi-6: #8fc9d2;
  --terminal-ansi-7: #f1ede6;
  --terminal-ansi-8: #c7bdaf;
  --terminal-ansi-9: #fcafad;
  --terminal-ansi-10: #97dbb2;
  --terminal-ansi-11: #e8ca90;
  --terminal-ansi-12: #aec5fa;
  --terminal-ansi-13: #f3b899;
  --terminal-ansi-14: #a3d0d6;
  --terminal-ansi-15: #f1ede6;
}
```

### Chalk — light

Pen prefix: `theme-chalk-`.

```css
[data-ade-palette="chalk"] {
  --background: #FAFBFC;
  --foreground: #20242B;
  --card: #FFFFFF;
  --card-foreground: #20242B;
  --popover: #FFFFFF;
  --popover-foreground: #20242B;
  --primary: #245BA8;
  --primary-foreground: #FFFFFF;
  --secondary: #E5E9EF;
  --secondary-foreground: #20242B;
  --muted: #E5E9EF;
  --muted-foreground: #535D6B;
  --accent: #DCE8FA;
  --accent-foreground: #20242B;
  --destructive: #a6303a;
  --destructive-foreground: #FFFFFF;
  --border: #e0e0e1;
  --input: #707C8C;
  --ring: #0c1e37;
  --sidebar: #E8EBEF;
  --sidebar-foreground: #20242B;
  --sidebar-primary: #245BA8;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #DCE8FA;
  --sidebar-accent-foreground: #20242B;
  --sidebar-border: #cccfd4;
  --sidebar-ring: #0c1e37;
  --base: #E8EBEF;
  --panel: #F1F3F6;
  --attention: #805000;
  --attention-muted: #f0ede8;
  --running: #245BA8;
  --success: #24663D;
  --success-muted: #e9efed;
  --destructive-muted: #f3ebec;
  --diff-add: #24663D;
  --diff-add-muted: #e9efed;
  --diff-remove: #a6303a;
  --diff-remove-muted: #f3ebec;
  --terminal: #E8EBEF;
  --terminal-foreground: #20242B;
  --terminal-selection: #DCE8FA;
  --terminal-cursor: #20242B;
  --info: #245BA8;
  --info-muted: #e9eef5;
  --link: #245BA8;
  --chart-1: #245BA8;
  --chart-2: #24663D;
  --chart-3: #805000;
  --chart-4: #a6303a;
  --chart-5: #245BA8;
  --syntax-keyword: #245BA8;
  --syntax-string: #24663D;
  --syntax-number: #805000;
  --syntax-comment: #535D6B;
  --syntax-default: #20242B;
  --destructive-button-bg: #f6eaeb;
  --terminal-ansi-0: #535d6b;
  --terminal-ansi-1: #a6303a;
  --terminal-ansi-2: #24663d;
  --terminal-ansi-3: #805000;
  --terminal-ansi-4: #245ba8;
  --terminal-ansi-5: #654671;
  --terminal-ansi-6: #246173;
  --terminal-ansi-7: #20242b;
  --terminal-ansi-8: #49525e;
  --terminal-ansi-9: #8b2e37;
  --terminal-ansi-10: #235939;
  --terminal-ansi-11: #6d4709;
  --terminal-ansi-12: #23508f;
  --terminal-ansi-13: #573f63;
  --terminal-ansi-14: #235565;
  --terminal-ansi-15: #20242b;
}
```

### Linen — light

Pen prefix: `theme-linen-`.

```css
[data-ade-palette="linen"] {
  --background: #FCFAF5;
  --foreground: #2E2922;
  --card: #FFFFFF;
  --card-foreground: #2E2922;
  --popover: #FFFFFF;
  --popover-foreground: #2E2922;
  --primary: #885318;
  --primary-foreground: #FFFFFF;
  --secondary: #E8E1D5;
  --secondary-foreground: #2E2922;
  --muted: #E8E1D5;
  --muted-foreground: #665A4B;
  --accent: #F1DFC1;
  --accent-foreground: #2E2922;
  --destructive: #a6303a;
  --destructive-foreground: #FFFFFF;
  --border: #e2e1e0;
  --input: #8B7C68;
  --ring: #271807;
  --sidebar: #EAE5DC;
  --sidebar-foreground: #2E2922;
  --sidebar-primary: #885318;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #F1DFC1;
  --sidebar-accent-foreground: #2E2922;
  --sidebar-border: #d0cbc2;
  --sidebar-ring: #271807;
  --base: #EAE5DC;
  --panel: #F3EFE7;
  --attention: #805000;
  --attention-muted: #f2ece1;
  --running: #245BA8;
  --success: #24663D;
  --success-muted: #ebeee6;
  --destructive-muted: #f5eae6;
  --diff-add: #24663D;
  --diff-add-muted: #ebeee6;
  --diff-remove: #a6303a;
  --diff-remove-muted: #f5eae6;
  --terminal: #EAE5DC;
  --terminal-foreground: #2E2922;
  --terminal-selection: #F1DFC1;
  --terminal-cursor: #2E2922;
  --info: #245BA8;
  --info-muted: #ebedef;
  --link: #885318;
  --chart-1: #245BA8;
  --chart-2: #24663D;
  --chart-3: #805000;
  --chart-4: #a6303a;
  --chart-5: #885318;
  --syntax-keyword: #885318;
  --syntax-string: #24663D;
  --syntax-number: #805000;
  --syntax-comment: #665A4B;
  --syntax-default: #2E2922;
  --destructive-button-bg: #f6eaeb;
  --terminal-ansi-0: #665a4b;
  --terminal-ansi-1: #a6303a;
  --terminal-ansi-2: #24663d;
  --terminal-ansi-3: #805000;
  --terminal-ansi-4: #245ba8;
  --terminal-ansi-5: #974229;
  --terminal-ansi-6: #246173;
  --terminal-ansi-7: #2e2922;
  --terminal-ansi-8: #5b5043;
  --terminal-ansi-9: #8e2f35;
  --terminal-ansi-10: #265a38;
  --terminal-ansi-11: #704807;
  --terminal-ansi-12: #26518d;
  --terminal-ansi-13: #823d28;
  --terminal-ansi-14: #265663;
  --terminal-ansi-15: #2e2922;
}
```

### Obsidian — dark

Pen prefix: `theme-v2-obsidian-`.

```css
[data-ade-palette="v2-obsidian"] {
  --background: #1a1c1f;
  --foreground: #F2F4F8;
  --card: #25272b;
  --card-foreground: #F2F4F8;
  --popover: #25272b;
  --popover-foreground: #F2F4F8;
  --primary: #87b3f2;
  --primary-foreground: #08101C;
  --secondary: #2e3136;
  --secondary-foreground: #F2F4F8;
  --muted: #2e3136;
  --muted-foreground: #B1BAC8;
  --accent: #263854;
  --accent-foreground: #F2F4F8;
  --destructive: #f19aa7;
  --destructive-foreground: #0c0c0e;
  --border: #424448;
  --input: #8390A4;
  --ring: #b5d0f7;
  --sidebar: #0c0c0e;
  --sidebar-foreground: #F2F4F8;
  --sidebar-primary: #87b3f2;
  --sidebar-primary-foreground: #08101C;
  --sidebar-accent: #263854;
  --sidebar-accent-foreground: #F2F4F8;
  --sidebar-border: #2c2c2f;
  --sidebar-ring: #b5d0f7;
  --base: #0c0c0e;
  --panel: #131416;
  --attention: #efc061;
  --attention-muted: #2c2822;
  --running: #67b4f4;
  --success: #4bd091;
  --success-muted: #1e2b29;
  --destructive-muted: #2e2128;
  --diff-add: #4bd091;
  --diff-add-muted: #1e2b29;
  --diff-remove: #f19aa7;
  --diff-remove-muted: #2e2128;
  --terminal: #0c0c0e;
  --terminal-foreground: #F2F4F8;
  --terminal-selection: #263854;
  --terminal-cursor: #F2F4F8;
  --info: #67b4f4;
  --info-muted: #1e2935;
  --link: #87b3f2;
  --chart-1: #67b4f4;
  --chart-2: #4bd091;
  --chart-3: #efc061;
  --chart-4: #f19aa7;
  --chart-5: #87b3f2;
  --syntax-keyword: #87b3f2;
  --syntax-string: #4bd091;
  --syntax-number: #efc061;
  --syntax-comment: #B1BAC8;
  --syntax-default: #F2F4F8;
  --destructive-button-bg: #4e3e44;
  --terminal-ansi-0: #b1bac8;
  --terminal-ansi-1: #f19aa7;
  --terminal-ansi-2: #4bd091;
  --terminal-ansi-3: #efc061;
  --terminal-ansi-4: #67b4f4;
  --terminal-ansi-5: #bca6cd;
  --terminal-ansi-6: #59c2c3;
  --terminal-ansi-7: #f2f4f8;
  --terminal-ansi-8: #bec6d2;
  --terminal-ansi-9: #f1acb7;
  --terminal-ansi-10: #6cd7a6;
  --terminal-ansi-11: #f0ca7f;
  --terminal-ansi-12: #83c1f5;
  --terminal-ansi-13: #c7b6d6;
  --terminal-ansi-14: #78ccce;
  --terminal-ansi-15: #f2f4f8;
}
```

### Ink — dark

Pen prefix: `theme-v2-ink-`.

```css
[data-ade-palette="v2-ink"] {
  --background: #1d1c21;
  --foreground: #F4F2FA;
  --card: #28282e;
  --card-foreground: #F4F2FA;
  --popover: #28282e;
  --popover-foreground: #F4F2FA;
  --primary: #b5a1f3;
  --primary-foreground: #120B24;
  --secondary: #323239;
  --secondary-foreground: #F4F2FA;
  --muted: #323239;
  --muted-foreground: #BCB7CC;
  --accent: #36314e;
  --accent-foreground: #F4F2FA;
  --destructive: #f49caa;
  --destructive-foreground: #0e0d10;
  --border: #45444b;
  --input: #938AA7;
  --ring: #d0c4f7;
  --sidebar: #0e0d10;
  --sidebar-foreground: #F4F2FA;
  --sidebar-primary: #b5a1f3;
  --sidebar-primary-foreground: #120B24;
  --sidebar-accent: #36314e;
  --sidebar-accent-foreground: #F4F2FA;
  --sidebar-border: #2e2d31;
  --sidebar-ring: #d0c4f7;
  --base: #0e0d10;
  --panel: #161519;
  --attention: #f2c062;
  --attention-muted: #2e2924;
  --running: #6ab4f5;
  --success: #4ecf92;
  --success-muted: #202c2b;
  --destructive-muted: #30222a;
  --diff-add: #4ecf92;
  --diff-add-muted: #202c2b;
  --diff-remove: #f49caa;
  --diff-remove-muted: #30222a;
  --terminal: #0e0d10;
  --terminal-foreground: #F4F2FA;
  --terminal-selection: #36314e;
  --terminal-cursor: #F4F2FA;
  --info: #6ab4f5;
  --info-muted: #202a37;
  --link: #b5a1f3;
  --chart-1: #6ab4f5;
  --chart-2: #4ecf92;
  --chart-3: #f2c062;
  --chart-4: #f49caa;
  --chart-5: #b5a1f3;
  --syntax-keyword: #b5a1f3;
  --syntax-string: #4ecf92;
  --syntax-number: #f2c062;
  --syntax-comment: #BCB7CC;
  --syntax-default: #F4F2FA;
  --destructive-button-bg: #513f47;
  --terminal-ansi-0: #bcb7cc;
  --terminal-ansi-1: #f49caa;
  --terminal-ansi-2: #4ecf92;
  --terminal-ansi-3: #f2c062;
  --terminal-ansi-4: #6ab4f5;
  --terminal-ansi-5: #d59fcf;
  --terminal-ansi-6: #5cc2c3;
  --terminal-ansi-7: #f4f2fa;
  --terminal-ansi-8: #c7c3d5;
  --terminal-ansi-9: #f4adba;
  --terminal-ansi-10: #6fd6a7;
  --terminal-ansi-11: #f2ca80;
  --terminal-ansi-12: #86c0f6;
  --terminal-ansi-13: #dbb0d8;
  --terminal-ansi-14: #7accce;
  --terminal-ansi-15: #f4f2fa;
}
```

### Midnight — dark

Pen prefix: `theme-v2-midnight-`.

```css
[data-ade-palette="v2-midnight"] {
  --background: #1c2124;
  --foreground: #EEF6F8;
  --card: #282f33;
  --card-foreground: #EEF6F8;
  --popover: #282f33;
  --popover-foreground: #EEF6F8;
  --primary: #5cc6df;
  --primary-foreground: #06181D;
  --secondary: #323b40;
  --secondary-foreground: #EEF6F8;
  --muted: #323b40;
  --muted-foreground: #ADBDC5;
  --accent: #223d47;
  --accent-foreground: #EEF6F8;
  --destructive: #f3a9b3;
  --destructive-foreground: #0c0f11;
  --border: #444b4f;
  --input: #829BA8;
  --ring: #9adceb;
  --sidebar: #0c0f11;
  --sidebar-foreground: #EEF6F8;
  --sidebar-primary: #5cc6df;
  --sidebar-primary-foreground: #06181D;
  --sidebar-accent: #223d47;
  --sidebar-accent-foreground: #EEF6F8;
  --sidebar-border: #2c2f31;
  --sidebar-ring: #9adceb;
  --base: #0c0f11;
  --panel: #14181b;
  --attention: #efc160;
  --attention-muted: #2e2d27;
  --running: #67b5f3;
  --success: #4bd090;
  --success-muted: #20302e;
  --destructive-muted: #30272d;
  --diff-add: #4bd090;
  --diff-add-muted: #20302e;
  --diff-remove: #f3a9b3;
  --diff-remove-muted: #30272d;
  --terminal: #0c0f11;
  --terminal-foreground: #EEF6F8;
  --terminal-selection: #223d47;
  --terminal-cursor: #EEF6F8;
  --info: #67b5f3;
  --info-muted: #202f3a;
  --link: #5cc6df;
  --chart-1: #67b5f3;
  --chart-2: #4bd090;
  --chart-3: #efc160;
  --chart-4: #f3a9b3;
  --chart-5: #5cc6df;
  --syntax-keyword: #5cc6df;
  --syntax-string: #4bd090;
  --syntax-number: #efc160;
  --syntax-comment: #ADBDC5;
  --syntax-default: #EEF6F8;
  --destructive-button-bg: #51474d;
  --terminal-ansi-0: #adbdc5;
  --terminal-ansi-1: #f3a9b3;
  --terminal-ansi-2: #4bd090;
  --terminal-ansi-3: #efc160;
  --terminal-ansi-4: #67b5f3;
  --terminal-ansi-5: #a8b8c9;
  --terminal-ansi-6: #59c3c2;
  --terminal-ansi-7: #eef6f8;
  --terminal-ansi-8: #bac8cf;
  --terminal-ansi-9: #f2b8c1;
  --terminal-ansi-10: #6cd8a5;
  --terminal-ansi-11: #efcc7e;
  --terminal-ansi-12: #82c2f4;
  --terminal-ansi-13: #b6c4d2;
  --terminal-ansi-14: #77cdcd;
  --terminal-ansi-15: #eef6f8;
}
```

### Onyx — dark

Pen prefix: `theme-v2-onyx-`.

```css
[data-ade-palette="v2-onyx"] {
  --background: #1f1d1f;
  --foreground: #F7F1F6;
  --card: #292629;
  --card-foreground: #F7F1F6;
  --popover: #292629;
  --popover-foreground: #F7F1F6;
  --primary: #e795c6;
  --primary-foreground: #230B1B;
  --secondary: #353136;
  --secondary-foreground: #F7F1F6;
  --muted: #353136;
  --muted-foreground: #C3B5C1;
  --accent: #412b3c;
  --accent-foreground: #F7F1F6;
  --destructive: #f499a6;
  --destructive-foreground: #0f0d0f;
  --border: #464246;
  --input: #9D8999;
  --ring: #efb8d9;
  --sidebar: #0f0d0f;
  --sidebar-foreground: #F7F1F6;
  --sidebar-primary: #e795c6;
  --sidebar-primary-foreground: #230B1B;
  --sidebar-accent: #412b3c;
  --sidebar-accent-foreground: #F7F1F6;
  --sidebar-border: #2f2d2f;
  --sidebar-ring: #efb8d9;
  --base: #0f0d0f;
  --panel: #171517;
  --attention: #f3bf5f;
  --attention-muted: #2f2720;
  --running: #6bb3f3;
  --success: #4fcf8f;
  --success-muted: #202b28;
  --destructive-muted: #302127;
  --diff-add: #4fcf8f;
  --diff-add-muted: #202b28;
  --diff-remove: #f499a6;
  --diff-remove-muted: #302127;
  --terminal: #0f0d0f;
  --terminal-foreground: #F7F1F6;
  --terminal-selection: #412b3c;
  --terminal-cursor: #F7F1F6;
  --info: #6bb3f3;
  --info-muted: #212934;
  --link: #e795c6;
  --chart-1: #6bb3f3;
  --chart-2: #4fcf8f;
  --chart-3: #f3bf5f;
  --chart-4: #f499a6;
  --chart-5: #e795c6;
  --syntax-keyword: #e795c6;
  --syntax-string: #4fcf8f;
  --syntax-number: #f3bf5f;
  --syntax-comment: #C3B5C1;
  --syntax-default: #F7F1F6;
  --destructive-button-bg: #523d42;
  --terminal-ansi-0: #c3b5c1;
  --terminal-ansi-1: #f499a6;
  --terminal-ansi-2: #4fcf8f;
  --terminal-ansi-3: #f3bf5f;
  --terminal-ansi-4: #6bb3f3;
  --terminal-ansi-5: #ee97b6;
  --terminal-ansi-6: #5dc1c1;
  --terminal-ansi-7: #f7f1f6;
  --terminal-ansi-8: #cdc1cc;
  --terminal-ansi-9: #f5abb6;
  --terminal-ansi-10: #71d6a4;
  --terminal-ansi-11: #f4c97d;
  --terminal-ansi-12: #87bff4;
  --terminal-ansi-13: #f0a9c3;
  --terminal-ansi-14: #7ccbcc;
  --terminal-ansi-15: #f7f1f6;
}
```

### Porcelain — light

Pen prefix: `theme-v2-porcelain-`.

```css
[data-ade-palette="v2-porcelain"] {
  --background: #f9fafb;
  --foreground: #171C25;
  --card: #ffffff;
  --card-foreground: #171C25;
  --popover: #ffffff;
  --popover-foreground: #171C25;
  --primary: #245cbc;
  --primary-foreground: #FFFFFF;
  --secondary: #e8ebee;
  --secondary-foreground: #171C25;
  --muted: #e8ebee;
  --muted-foreground: #505D71;
  --accent: #dfe9f8;
  --accent-foreground: #171C25;
  --destructive: #a92643;
  --destructive-foreground: #FFFFFF;
  --border: #dfdfe0;
  --input: #718098;
  --ring: #0c1d3c;
  --sidebar: #e7e9eb;
  --sidebar-foreground: #171C25;
  --sidebar-primary: #245cbc;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #dfe9f8;
  --sidebar-accent-foreground: #171C25;
  --sidebar-border: #cacccf;
  --sidebar-ring: #0c1d3c;
  --base: #e7e9eb;
  --panel: #f1f2f4;
  --attention: #815217;
  --attention-muted: #fffaee;
  --running: #175bab;
  --success: #156c4d;
  --success-muted: #f3fef7;
  --destructive-muted: #fff6f7;
  --diff-add: #156c4d;
  --diff-add-muted: #f3fef7;
  --diff-remove: #a92643;
  --diff-remove-muted: #fff6f7;
  --terminal: #e7e9eb;
  --terminal-foreground: #171C25;
  --terminal-selection: #dfe9f8;
  --terminal-cursor: #171C25;
  --info: #175bab;
  --info-muted: #f3f9ff;
  --link: #245cbc;
  --chart-1: #175bab;
  --chart-2: #156c4d;
  --chart-3: #815217;
  --chart-4: #a92643;
  --chart-5: #245cbc;
  --syntax-keyword: #245cbc;
  --syntax-string: #156c4d;
  --syntax-number: #815217;
  --syntax-comment: #505D71;
  --syntax-default: #171C25;
  --destructive-button-bg: #f6e9ec;
  --terminal-ansi-0: #505d71;
  --terminal-ansi-1: #a92643;
  --terminal-ansi-2: #156c4d;
  --terminal-ansi-3: #815217;
  --terminal-ansi-4: #175bab;
  --terminal-ansi-5: #674180;
  --terminal-ansi-6: #16647c;
  --terminal-ansi-7: #171c25;
  --terminal-ansi-8: #455062;
  --terminal-ansi-9: #8c243d;
  --terminal-ansi-10: #155c45;
  --terminal-ansi-11: #6c471a;
  --terminal-ansi-12: #174e90;
  --terminal-ansi-13: #573a6e;
  --terminal-ansi-14: #16566b;
  --terminal-ansi-15: #171c25;
}
```

### Pearl — light

Pen prefix: `theme-v2-pearl-`.

```css
[data-ade-palette="v2-pearl"] {
  --background: #fbfafd;
  --foreground: #211A30;
  --card: #ffffff;
  --card-foreground: #211A30;
  --popover: #ffffff;
  --popover-foreground: #211A30;
  --primary: #6d45b2;
  --primary-foreground: #FFFFFF;
  --secondary: #e9e6ed;
  --secondary-foreground: #211A30;
  --muted: #e9e6ed;
  --muted-foreground: #61556F;
  --accent: #e8e1f8;
  --accent-foreground: #211A30;
  --destructive: #ac2443;
  --destructive-foreground: #FFFFFF;
  --border: #e0dfe2;
  --input: #887795;
  --ring: #221537;
  --sidebar: #e8e7ec;
  --sidebar-foreground: #211A30;
  --sidebar-primary: #6d45b2;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #e8e1f8;
  --sidebar-accent-foreground: #211A30;
  --sidebar-border: #cccad2;
  --sidebar-ring: #221537;
  --base: #e8e7ec;
  --panel: #f2f1f5;
  --attention: #845016;
  --attention-muted: #fffaee;
  --running: #1b59ab;
  --success: #186b4d;
  --success-muted: #f3fef7;
  --destructive-muted: #fff6f7;
  --diff-add: #186b4d;
  --diff-add-muted: #f3fef7;
  --diff-remove: #ac2443;
  --diff-remove-muted: #fff6f7;
  --terminal: #e8e7ec;
  --terminal-foreground: #211A30;
  --terminal-selection: #e8e1f8;
  --terminal-cursor: #211A30;
  --info: #1b59ab;
  --info-muted: #f3f9ff;
  --link: #6d45b2;
  --chart-1: #1b59ab;
  --chart-2: #186b4d;
  --chart-3: #845016;
  --chart-4: #ac2443;
  --chart-5: #6d45b2;
  --syntax-keyword: #6d45b2;
  --syntax-string: #186b4d;
  --syntax-number: #845016;
  --syntax-comment: #61556F;
  --syntax-default: #211A30;
  --destructive-button-bg: #f7e9ec;
  --terminal-ansi-0: #61556f;
  --terminal-ansi-1: #ac2443;
  --terminal-ansi-2: #186b4d;
  --terminal-ansi-3: #845016;
  --terminal-ansi-4: #1b59ab;
  --terminal-ansi-5: #8d357a;
  --terminal-ansi-6: #1a627c;
  --terminal-ansi-7: #211a30;
  --terminal-ansi-8: #544962;
  --terminal-ansi-9: #90223f;
  --terminal-ansi-10: #1a5b47;
  --terminal-ansi-11: #70451b;
  --terminal-ansi-12: #1c4c92;
  --terminal-ansi-13: #77306b;
  --terminal-ansi-14: #1b546d;
  --terminal-ansi-15: #211a30;
}
```

### Ice — light

Pen prefix: `theme-v2-ice-`.

```css
[data-ade-palette="v2-ice"] {
  --background: #fafcfd;
  --foreground: #172A33;
  --card: #ffffff;
  --card-foreground: #172A33;
  --popover: #ffffff;
  --popover-foreground: #172A33;
  --primary: #186a84;
  --primary-foreground: #FFFFFF;
  --secondary: #e5eaed;
  --secondary-foreground: #172A33;
  --muted: #e5eaed;
  --muted-foreground: #4B6470;
  --accent: #daecf2;
  --accent-foreground: #172A33;
  --destructive: #a82743;
  --destructive-foreground: #FFFFFF;
  --border: #dfe1e2;
  --input: #6D8792;
  --ring: #08222a;
  --sidebar: #e6eaec;
  --sidebar-foreground: #172A33;
  --sidebar-primary: #186a84;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #daecf2;
  --sidebar-accent-foreground: #172A33;
  --sidebar-border: #c9cfd2;
  --sidebar-ring: #08222a;
  --base: #e6eaec;
  --panel: #f0f3f5;
  --attention: #805316;
  --attention-muted: #fffaee;
  --running: #165cab;
  --success: #146e4d;
  --success-muted: #f3fef7;
  --destructive-muted: #fff6f7;
  --diff-add: #146e4d;
  --diff-add-muted: #f3fef7;
  --diff-remove: #a82743;
  --diff-remove-muted: #fff6f7;
  --terminal: #e6eaec;
  --terminal-foreground: #172A33;
  --terminal-selection: #daecf2;
  --terminal-cursor: #172A33;
  --info: #165cab;
  --info-muted: #f3f9ff;
  --link: #186a84;
  --chart-1: #165cab;
  --chart-2: #146e4d;
  --chart-3: #805316;
  --chart-4: #a82743;
  --chart-5: #186a84;
  --syntax-keyword: #186a84;
  --syntax-string: #146e4d;
  --syntax-number: #805316;
  --syntax-comment: #4B6470;
  --syntax-default: #172A33;
  --destructive-button-bg: #f6e9ec;
  --terminal-ansi-0: #4b6470;
  --terminal-ansi-1: #a82743;
  --terminal-ansi-2: #146e4d;
  --terminal-ansi-3: #805316;
  --terminal-ansi-4: #165cab;
  --terminal-ansi-5: #604964;
  --terminal-ansi-6: #15657c;
  --terminal-ansi-7: #172a33;
  --terminal-ansi-8: #415864;
  --terminal-ansi-9: #8b2840;
  --terminal-ansi-10: #156048;
  --terminal-ansi-11: #6b4b1c;
  --terminal-ansi-12: #165293;
  --terminal-ansi-13: #51435a;
  --terminal-ansi-14: #15596d;
  --terminal-ansi-15: #172a33;
}
```

### Quartz — light

Pen prefix: `theme-v2-quartz-`.

```css
[data-ade-palette="v2-quartz"] {
  --background: #fdfbfc;
  --foreground: #2C1B27;
  --card: #ffffff;
  --card-foreground: #2C1B27;
  --popover: #ffffff;
  --popover-foreground: #2C1B27;
  --primary: #a43077;
  --primary-foreground: #FFFFFF;
  --secondary: #eae4e8;
  --secondary-foreground: #2C1B27;
  --muted: #eae4e8;
  --muted-foreground: #6D5365;
  --accent: #f2e0eb;
  --accent-foreground: #2C1B27;
  --destructive: #af2441;
  --destructive-foreground: #FFFFFF;
  --border: #e1dfe1;
  --input: #917786;
  --ring: #381028;
  --sidebar: #ebe8ea;
  --sidebar-foreground: #2C1B27;
  --sidebar-primary: #a43077;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #f2e0eb;
  --sidebar-accent-foreground: #2C1B27;
  --sidebar-border: #d0cbcf;
  --sidebar-ring: #381028;
  --base: #ebe8ea;
  --panel: #f5f2f4;
  --attention: #875014;
  --attention-muted: #fffaee;
  --running: #1d59a9;
  --success: #1b6a4b;
  --success-muted: #f3fef7;
  --destructive-muted: #fff6f7;
  --diff-add: #1b6a4b;
  --diff-add-muted: #f3fef7;
  --diff-remove: #af2441;
  --diff-remove-muted: #fff6f7;
  --terminal: #ebe8ea;
  --terminal-foreground: #2C1B27;
  --terminal-selection: #f2e0eb;
  --terminal-cursor: #2C1B27;
  --info: #1d59a9;
  --info-muted: #f3f9ff;
  --link: #a43077;
  --chart-1: #1d59a9;
  --chart-2: #1b6a4b;
  --chart-3: #875014;
  --chart-4: #af2441;
  --chart-5: #a43077;
  --syntax-keyword: #a43077;
  --syntax-string: #1b6a4b;
  --syntax-number: #875014;
  --syntax-comment: #6D5365;
  --syntax-default: #2C1B27;
  --destructive-button-bg: #f7e9ec;
  --terminal-ansi-0: #6d5365;
  --terminal-ansi-1: #af2441;
  --terminal-ansi-2: #1b6a4b;
  --terminal-ansi-3: #875014;
  --terminal-ansi-4: #1d59a9;
  --terminal-ansi-5: #aa2a5c;
  --terminal-ansi-6: #1c627a;
  --terminal-ansi-7: #2c1b27;
  --terminal-ansi-8: #604859;
  --terminal-ansi-9: #95223c;
  --terminal-ansi-10: #1e5a44;
  --terminal-ansi-11: #754518;
  --terminal-ansi-12: #204d8f;
  --terminal-ansi-13: #912751;
  --terminal-ansi-14: #1f5469;
  --terminal-ansi-15: #2c1b27;
}
```
