# Desktop, profiles and application foundation

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

The prototype is slow to iterate on, and UI lifetime must not own running work. Users need independent profiles and a customizable accessible desktop.

## Solution

Deliver a React/Electron workbench with a framework-neutral client SDK and lazy independent Rust backend processes. Preserve workspace and resource identity across views.

## User Stories

1. As a user, I want support for Independent headless backend, so that I can run work on a host without an open desktop. **F005**
2. As a user, I want support for Independent profiles, so that I can separate projects, accounts, history and settings. **F007**
3. As a user, I want support for Multiple windows, so that I can view separate work at once. **F008**
4. As a user, I want support for Remote-only client use, so that I can control a remote host without local agent dependencies. **F009**
5. As a user, I want support for Background continuity, so that I can keep work running after closing a window. **F010**
6. As a user, I want support for Tabs and split panes, so that I can arrange conversations, terminals and previews. **F011**
7. As a user, I want support for Floating and detached views, so that I can move a view to another window. **F012**
8. As a user, I want support for Themes and theme import/export, so that I can adapt appearance and share my own configuration. **F013**
9. As a user, I want support for Typography, density and motion preferences, so that I can make the interface comfortable. **F014**
10. As a user, I want support for Configurable keybindings, so that I can operate ADE using my preferred shortcuts. **F015**
11. As a user, I want support for Command palette and navigation, so that I can find and invoke application actions quickly. **F016**
12. As a user, I want support for Responsive layouts, so that I can use different desktop window sizes. **F018**
13. As a user, I want support for Accessibility, so that I can operate ADE with keyboard and assistive technology. **F019**
14. As a user, I want support for Replaceable workspace UI, so that I can customize the application shell through plugins. **F020**
15. **01-S15.** As a developer, I want to use renderer HMR without restarting agents, so that I can iterate on ADE while using it.
16. **01-S16.** As a user, I want to see incompatible or unavailable backend states, so that I can recover without corrupting my profile.

## Implementation Decisions

1. Electron main owns windows, native integration and fresh-renderer recovery. React owns composition and interaction state. The client SDK owns one synchronized projection and cursor; the daemon owns durable application state.
2. Each active profile has its own daemon/runtime and SQLite state. Inactive profiles with no work do not need processes. Profile identity is not a sandbox against trusted same-user code.
3. Host, profile, workspace, conversation and execution attempt are stable identities. A workspace is a checkout or directory on an execution host, not a conversation or a display name.
4. React, Electron, TypeScript, pnpm/Cargo monorepo, xterm.js and Fallow are agreed. Vite/electron-vite and other shortlisted packages remain proposed defaults until their compatibility is checked.
5. Window layout and interaction state are separate from execution lifetime. Replacing React later preserves contracts and backend code but requires migration of React components and UI bindings.
6. Use local desktop notifications and host capabilities without requiring future mobile, relay or simultaneous-client products.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Desktop, profiles, client SDK, launcher and daemon.

Prior art: Prototype view cleanup, weak subscription ownership and bounded command queues; t3code projection/cursor interruption cases. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F005 | Start backend without Electron; connect from desktop and CLI; close clients without stopping admitted work. |
| F007 | Create two profiles; verify isolated records, plugins and browser data after restart while shared-resource conflicts remain visible. |
| F008 | Open two windows in one profile; close one during a turn; the other observes the same settled operation without duplicate dispatch. |
| F009 | Connect from a client with no installed provider; execute on the remote host and show its identity. |
| F010 | Close all views during terminal/provider activity; reopen and recover state without replaying the command. |
| F011 | Create and resize splits; restart the UI; restore layout and bind panes to the original resource IDs. |
| F012 | Detach and reattach a terminal or conversation; preserve underlying execution and restore focus predictably. |
| F013 | Import a supported theme, apply it across built-in surfaces, export it and restore equivalent tokens; reject malformed input visibly. |
| F014 | Change font, density and reduced-motion preferences; verify persistence and readable terminal/composer layout. |
| F015 | Rebind a command, resolve a conflict, and verify focused editor/terminal shortcuts do not trigger unrelated application actions. |
| F016 | Find a command by search; navigate to a resource; disabled actions expose why they are unavailable. |
| F018 | Resize to narrow and wide supported desktop sizes; preserve reachable controls, pane recovery and keyboard focus. |
| F019 | Complete the core flow using keyboard and accessible names; check focus restoration, reduced motion and screen-reader exposure in the running app. |
| F020 | Install a trusted shell replacement; access the same resources and commands; disable it and recover the built-in shell without losing work. |
| 01-S15 | Start work, edit renderer code, observe the changed UI and unchanged execution identity. |
| 01-S16 | Connect incompatible peers; show recovery guidance and no silent mutation or replacement. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Browser/mobile/cross-platform clients and shipping simultaneous-client UX are deferred; localization is excluded.

| Feature | Disposition |
|---|---|
| F001 — Cross-platform desktop | Design now, ship later |
| F002 — Browser client | Design now, ship later |
| F003 — Mobile applications | Design now, ship later |
| F004 — Simultaneous clients | Design now, ship later |
| F006 — Offline mobile composition | Design now, ship later |
| F017 — Localization | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
