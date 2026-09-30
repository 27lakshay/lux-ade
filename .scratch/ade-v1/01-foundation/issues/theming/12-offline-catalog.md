# 12 — Browse an offline terminal catalog with favorites and commands

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Find and apply terminal themes offline, keep favorites and recent choices, and retain custom work through catalog updates.

**Blocked by:** [10 — Import and export Ghostty theme files](10-ghostty-files.md)

**Spec coverage:** TH04, TH30, TH32. User stories 9–12, 47, 51, 64, 78. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Bundle a pinned normalized iTerm2-Color-Schemes Ghostty catalog with source revision, attribution and license data; search and selection work without network or installed Ghostty.
- [ ] The library supports search, mode/source filters, provenance, ANSI swatches and existing preview samples with responsive large-list navigation.
- [ ] Favorites and recent committed selections belong to the profile and survive restarts. Preview alone never enters committed recents.
- [ ] Keyboard commands select themes, change mode and restore defaults through the same operations as settings.
- [ ] Catalog updates preserve stable identities and custom definitions/overrides. Removed IDs expose fallback rather than silently matching another name.
- [ ] Duplicate names and renames preserve favorites and provenance. Record search/preview latency with the shipped catalog; final multi-terminal load evidence belongs to ticket 24.
- [ ] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Run public catalog/update fixtures and built-desktop offline search, keyboard navigation, favorites and restart scenarios. Confirm no network dependency for bundled use.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.
