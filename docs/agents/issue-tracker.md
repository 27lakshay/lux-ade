# Issue tracker: Local Markdown

The user selected the repository-local Markdown tracker for ADE v1 specs.

- The v1 map is `.scratch/ade-v1/README.md`.
- The complete feature register is `.scratch/ade-v1/requirements.md`.
- One domain spec lives at `.scratch/ade-v1/<NN-domain>/spec.md`.
- Implementation tickets, when requested, are separate numbered Markdown files
  beneath the corresponding domain's `issues/` directory. A spec is not a build order.
- Every tracker document declares `Status:` and `Type:` near its top.
- Publishing a spec means writing it here and linking it from the map. No external
  tracker or remote publication is configured or implied.
- Keep the register and owning spec synchronized when scope changes. Preserve IDs.
- Use the configured triage vocabulary. Comments append under `## Comments`.

## Wayfinding operations

- A wayfinder map is `.scratch/<effort>/README.md` with `Type: wayfinder map`
  and `Label: wayfinder:map`. Its tickets are `.scratch/<effort>/issues/NN-slug.md`.
- A ticket declares `Label: wayfinder:<research|prototype|grilling|task>`,
  `Assignee:` (the claim; `none` when unclaimed) and `Blocked by:` (links to
  blocking tickets; `none` when unblocked). The tracker has no native blocking.
- The frontier is every ticket with `Status: open`, `Assignee: none` and all
  `Blocked by:` tickets closed.
- Resolving a ticket appends the answer under `## Comments`, sets
  `Status: closed`, and adds a one-line gist to the map's Decisions so far.
- Research findings live in `.scratch/<effort>/research/`, linked from the ticket.
