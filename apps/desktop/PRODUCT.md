# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron desktop app (React renderer). macOS Apple Silicon first; cross-platform desktop is
"design now, ship later" (F001), so layouts must not depend on macOS-only chrome. The
[current architecture](../../docs/architecture.md) records what is implemented.

## Users

Public open-source users: developers who install ADE themselves to run coding agents
(Claude Code, Codex, Oh My Pi) on their own machine. A typical session supervises
**3–6 agents at once** across one or more workspaces, switching between them to answer
approvals and questions, review diffs, and keep terminals and dev services running.
They arrive without the author's context, so first-run, provider setup, account
readiness and honest state explanations matter as much as daily speed.

## Product Purpose

A desktop workbench that keeps agent work, terminals, dev services and previews alive
independently of the UI, and lets one person supervise several agents without losing
track of which one needs them. Success: the user always knows what each agent is doing,
what is waiting on them, and that what they see is current and true.

## Positioning

The Rust runtime owns providers, terminals and managed services, so reloading the UI does not
stop that work. The daemon records effects and their outcomes for reconciliation. Electron owns
browser pages. Each agent keeps its native protocol. The UI reports uncertain outcomes honestly
("unknown", "incomplete recovery", "caught up") instead of pretending.

## Operating Context

- Terms come from [CONTEXT.md](../../CONTEXT.md). Use its resource names in UI copy.
- Daily loop: pick profile → workspace → agent + account → prompt → watch tools →
  approve/answer/cancel → review diff and send feedback → run dev service → preview in
  embedded browser. The CLI drives daemon-owned resources; browser tab records are still held by
  Electron while their move to the daemon is planned.
- Tabs and split panes are built. Terminal tabs render now; Conversation, Browser, File and Diff
  pane content and detached views are still planned.
- Terminal output stays outside React state. The window renders it with Ghostty WebAssembly.

## Capabilities and Constraints

- Scope: `.scratch/ade-v1/requirements.md` (107 v1 features). No built-in code editor,
  no PR management, no issue trackers, no dashboard (F045 excluded), no localization in v1.
- Must support: themes with import/export and plugin themes (F013, F056), typography,
  density and reduced-motion preferences (F014), configurable keybindings (F015),
  command palette (F016), responsive window sizes (F018), full keyboard and
  screen-reader operation (F019), a replaceable shell via plugins (F020).
- Current UI foundation: shadcn/ui on Base UI, Tailwind v4, Graphite/OKLCH tokens, Motion for
  structural layout, CSS transitions for small feedback, cmdk, Sonner, an in-house pane tree,
  TanStack Virtual, Streamdown, Pierre Diffs and Shiki. D06 and D07 in the
  [decision register](../../.scratch/ade-v1/decisions.md) record revisions to the original choices.

## Brand Commitments

- Anti-goal (user, 2026-09-26): must not feel like a dashboard — no card grids, metric
  tiles, bento layouts or Jira-style boards as the home experience.

## Evidence on Hand

No final logo, name treatment or public testimonials are approved. Internal
[performance evidence](../../.scratch/ade-v1/evidence/daemon-authority.md) exists, but the
synthetic and real-terminal memory runs are not comparable. Product name is "lux-ade" / "ADE";
final public name and licence are undecided.

## Product Principles

1. **Work outlives the window.** Every view is a lens on durable state; closing it never
   loses or repeats work.
2. **Attention is the scarce resource.** With 3–6 agents running, the UI's first job is
   showing who needs you, and staying quiet about everything else.
3. **Never pretend.** Unknown, stale, reconnecting and incomplete states are shown as such.
4. **Native agents, one app.** Respect each provider's real capabilities; show
   unavailable options as unavailable rather than faking parity.
5. **Keyboard first, legible to newcomers.** Every action reachable by keyboard and palette,
   with plain labels that a first-time open-source user understands.

## Accessibility & Inclusion

F019: complete the core flow by keyboard and screen reader; visible focus; reduced motion
honoured (OS setting plus in-app preference); contrast adjustable through the theme
contrast control.
