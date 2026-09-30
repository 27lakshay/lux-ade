# 11 — Import installed Ghostty configuration

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Explicitly import installed Ghostty appearance with named themes, light/dark pairs and config overrides resolved before committing it.

**Blocked by:** [10 — Import and export Ghostty theme files](10-ghostty-files.md)

**Spec coverage:** TH10, TH20. User stories 28–29, 33, 45, 49. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Explicit config import discovers the supported current/legacy filenames, XDG/macOS locations, user/resource themes and absolute references using scratch-home fixtures.
- [ ] Named and conditional light/dark references resolve into explicit theme variants; theme defaults precede explicit config overrides and repeated palette entries follow Ghostty precedence.
- [ ] Includes are available only within explicit config import, with source lists, cycle detection and depth/size bounds. Theme files do not recursively enable unrelated config behavior.
- [ ] Preview reports each contributing source, invalid or unsupported option and separate optional appearance-policy result.
- [ ] Cancel, invalid include graphs and unreadable sources leave installed themes unchanged. Arbitrary executable settings are never interpreted as actions.
- [ ] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Test discovery and precedence using scratch homes and actual public import operations; demonstrate desktop preview/apply for a paired config with includes. Never use the personal Ghostty config as a test fixture.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.
