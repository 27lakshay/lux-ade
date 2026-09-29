# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron desktop app (React 19 renderer, Chromium 152). macOS Apple Silicon first; cross-platform
desktop is "design now, ship later" (F001), so layouts must not depend on macOS-only chrome.

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

Rust daemon and runtime own every process, so closing or reloading the UI never stops
work, and recovery never replays a command. Each agent keeps its native protocol
(no lowest-common-denominator chat). The UI reports uncertain outcomes honestly
("unknown", "incomplete recovery", "caught up") instead of pretending.

## Operating Context

- Terms (from `CONTEXT.md`): Host, Profile, Project, Workspace, Conversation, Operation,
  Provider, Account, Terminal, Browser session, Activity. Use these names in UI copy.
- Daily loop: pick profile → workspace → agent + account → prompt → watch tools →
  approve/answer/cancel → review diff and send feedback → run dev service → preview in
  embedded browser. CLI can drive the same resources.
- Tabs and split panes hold Conversation, Terminal, Browser, Diff views; views can detach.
- Terminal output stays outside React state (xterm.js).

## Capabilities and Constraints

- Scope: `.scratch/ade-v1/requirements.md` (107 v1 features). No built-in code editor,
  no PR management, no issue trackers, no dashboard (F045 excluded), no localization in v1.
- Must support: themes with import/export and plugin themes (F013, F056), typography,
  density and reduced-motion preferences (F014), configurable keybindings (F015),
  command palette (F016), responsive window sizes (F018), full keyboard and
  screen-reader operation (F019), a replaceable shell via plugins (F020).
- Stack (decided 2026-09-26, D07): shadcn/ui on Base UI, Tailwind v4, OKLCH tokens,
  Motion 13 for gestures/layout, CSS + React `<ViewTransition>` otherwise, cmdk, Sonner,
  dockview, TanStack Virtual, Streamdown, Pierre Diffs, Shiki.

## Brand Commitments

- Anti-goal (user, 2026-09-26): must not feel like a dashboard — no card grids, metric
  tiles, bento layouts or Jira-style boards as the home experience.

## Evidence on Hand

No logo, name treatment, screenshots, testimonials or benchmarks exist. Product name is
"lux-ade" / "ADE"; final public name and licence are undecided. Do not invent them.

## Product Principles

1. **Work outlives the window.** Every view is a lens on durable state; closing it never
   loses or repeats work.
2. **Attention is the scarce resource.** With 3–6 agents running, the UI's first job is
   showing who needs you, and staying quiet about everything else.
3. **Never pretend.** Unknown, stale, reconnecting and incomplete states are shown as such.
4. **Native agents, one workbench.** Respect each provider's real capabilities; show
   unavailable options as unavailable rather than faking parity.
5. **Keyboard first, legible to newcomers.** Every action reachable by keyboard and palette,
   with plain labels that a first-time open-source user understands.

## Accessibility & Inclusion

F019: complete the core flow by keyboard and screen reader; visible focus; reduced motion
honoured (OS setting plus in-app preference); contrast adjustable through the theme
contrast control.
