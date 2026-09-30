# 13 — Import local VS Code theme collections

Status: ready-for-agent
Type: implementation ticket

**Parent:** [App, terminal and code theming](../../theming.md)

**What to build:** Reuse VS Code theme collections as independently selectable ADE app, terminal and syntax sections with visible conversion limits.

**Blocked by:** [09 — Manage custom themes and ADE import/export](09-ade-theme-library.md)

**Spec coverage:** TH19, TH20. User stories 49, 53, 55. Coverage is this ticket’s contribution; shared acceptance rows require the other contributors listed in the [ticket index](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Import maps workbench colors, terminal values and TextMate rules to their respective sections without pretending unsupported mappings are exact.
- [ ] Includes stay within a bounded import root with cycle/depth/size limits. Alpha is composited against the declared surface where an opaque destination is required.
- [ ] Preview exposes unmapped keys, semantic-token limitations, invalid data and provenance before any install.
- [ ] Collections retain distinct identities and variants. Unambiguous pairs may be suggested; ambiguous variants require explicit slot assignment.
- [ ] Imported sections can be selected independently and appear on real app, terminal and code/diff consumers. Invalid collections leave committed data untouched.
- [ ] Record observable acceptance evidence and run the required repository checks; identify any remaining prerequisite or failed check explicitly.

## Testing decisions

Use local theme/include fixtures through public import operations and desktop preview/apply. Verify representative rendered workbench, terminal and syntax mappings and containment failures.

Read the [shared delivery rules](README.md#delivery-rules) before implementation.
