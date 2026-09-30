# 14 — Discover and import themes from Open VSX

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Search Open VSX and import theme contributions as data through the existing collection preview and selection workflow.

**Blocked by:** [13 — Import local VS Code theme collections](13-vscode-import.md)

**Spec coverage:** TH19, TH20. User stories 49, 54–55. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Search results and contribution previews expose theme variants, publisher/source and available license metadata before download/install.
- [ ] Only declarative theme data is imported; extension code and arbitrary CSS do not execute or install.
- [ ] Enforce bounds on responses, archive entries, expanded size, compression ratio, includes and theme count; validate extraction paths and permitted sources.
- [ ] Cancellation, network failure, malformed archives, path escapes and include cycles leave installed themes and selections unchanged.
- [ ] Imported collections retain provenance and pairing rules and render through existing app/terminal/syntax consumers. Search and import errors are available through the public surface as well as desktop UI.
- [ ] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use a deterministic HTTP/archive fixture exercising the real importer and desktop search/download flow. Keep any live Open VSX smoke result separate from required repeatable acceptance.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.
