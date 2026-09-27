# ADE v1 requirements register

Status: ready-for-agent
Type: scope register

This is the complete 140-item catalogue reconstructed from the agreed conversation scope. Titles are normalized for readability; IDs retain their original meaning. Every V1 item has a user story and E2E acceptance entry in its owning specification. All implementation statuses begin **Unverified**: existing prototype code is not evidence that the successor meets these requirements.

## Scope corrections

- Original F001–F005 were deferred. F005 was subsequently included as headless infrastructure required for v1 SSH; polished standalone deployment F130 remains excluded.
- F006 and F116 follow deferred mobile/simultaneous-client products; F123 relay is later.
- F041 means unified readable/searchable history. Cross-provider continuation is later.
- F056 includes theme extensions; localization F017 remains excluded.
- F044 task organization UI is excluded; stable task identity and F069 workspace lifecycle are still required.
- F109 advanced orchestration recovery is excluded; ordinary crash/operation recovery remains a release requirement.
- F065 can resolve a supported PR source into a checkout; this does not add excluded F076/F077 PR management/review.
- F046 snoozing changes attention state, not scheduled agent execution.

## Feature register

| ID | Requirement | Disposition | Owning specification | Implementation |
|---|---|---|---|---|
| F001 | Cross-platform desktop | Design now, ship later | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F002 | Browser client | Design now, ship later | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F003 | Mobile applications | Design now, ship later | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F004 | Simultaneous clients | Design now, ship later | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F005 | Independent headless backend | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F006 | Offline mobile composition | Design now, ship later | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F007 | Independent profiles | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F008 | Multiple windows | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F009 | Remote-only client use | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F010 | Background continuity | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F011 | Tabs and split panes | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F012 | Floating and detached views | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F013 | Themes and theme import/export | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F014 | Typography, density and motion preferences | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F015 | Configurable keybindings | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F016 | Command palette and navigation | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F017 | Localization | Not now | [01-foundation](01-foundation/spec.md) | Not scheduled |
| F018 | Responsive layouts | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F019 | Accessibility | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F020 | Replaceable workspace UI | V1 | [01-foundation](01-foundation/spec.md) | Unverified |
| F021 | Claude Code, Codex and Oh My Pi | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F022 | Additional bundled providers | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F023 | Provider plugins | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F024 | Generic ACP and custom executable adapters | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F025 | Multiple accounts | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F026 | Explicit in-conversation account switching | V1 | [02-providers](02-providers/spec.md) | Unverified |
| F027 | Provider setup, authentication and readiness | V1 | [02-providers](02-providers/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-providers.md)) |
| F028 | Model, reasoning and permission capabilities | V1 | [02-providers](02-providers/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-providers.md)) |
| F029 | Agent presets | V1 | [02-providers](02-providers/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-providers.md)) |
| F030 | Quota and limit visibility | V1 | [02-providers](02-providers/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-providers.md)) |
| F031 | Structured conversations | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-conversations.md)) |
| F032 | Attachments and media | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F033 | Prompt context capture | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F034 | Message queues | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-conversations.md)) |
| F035 | Steering active runs | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-conversations.md)) |
| F036 | Draft recovery, recall and stash | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F037 | Slash commands and skills | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F038 | Approvals and questions | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-conversations.md)) |
| F039 | Conversation and file rewind | V1 | [03-conversations](03-conversations/spec.md) | Unverified |
| F040 | Context compaction | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F041 | Combined history | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-catalogs.md)) |
| F042 | External session import | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-catalogs.md)) |
| F043 | Work search | V1 | [03-conversations](03-conversations/spec.md) | Unverified |
| F044 | Task pins, labels, ordering and archive UI | Not now | [03-conversations](03-conversations/spec.md) | Not scheduled |
| F045 | Dashboard | Not now | [03-conversations](03-conversations/spec.md) | Not scheduled |
| F046 | Snoozing | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-context.md)) |
| F047 | Automatic settlement | Not now | [03-conversations](03-conversations/spec.md) | Not scheduled |
| F048 | Idle hibernation | Not now | [03-conversations](03-conversations/spec.md) | Not scheduled |
| F049 | Usage analytics | V1 | [03-conversations](03-conversations/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-catalogs.md)) |
| F050 | History export and backup | V1 | [03-conversations](03-conversations/spec.md) | Unverified |
| F051 | Plugin installation and lifecycle | V1 | [04-plugins](04-plugins/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-plugins.md)) |
| F052 | Plugin panels, navigation and settings | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F053 | Timeline renderers and transforms | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F054 | Composer extensions | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F055 | Plugin commands and keybindings | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F056 | Theme extension support | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F057 | Backend extensions | V1 | [04-plugins](04-plugins/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-plugins.md)) |
| F058 | Lifecycle hooks | V1 | [04-plugins](04-plugins/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-plugins.md)) |
| F059 | Plugin state, credentials and settings | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F060 | Plugin development and recovery | V1 | [04-plugins](04-plugins/spec.md) | Unverified |
| F061 | Projects and ordinary folders | V1 | [05-workspaces](05-workspaces/spec.md) | Verified |
| F062 | Repository clone and publish | V1 | [05-workspaces](05-workspaces/spec.md) | Unverified |
| F063 | Managed worktree creation | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F064 | Carry uncommitted changes | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F065 | Adopt branch, checkout, worktree or PR source | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F066 | Worktree naming and defaults | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F067 | Workspace setup and teardown hooks | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-hooks-auth.md)) |
| F068 | Ignored-resource handling | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F069 | Workspace archive and cleanup | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-worktrees.md)) |
| F070 | Checkpoints and restore | V1 | [05-workspaces](05-workspaces/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-resources.md)) |
| F071 | File explorer and search | V1 | [06-files-git](06-files-git/spec.md) | Unverified |
| F072 | Built-in code editor | Not now | [06-files-git](06-files-git/spec.md) | Not scheduled |
| F073 | File previews | V1 | [06-files-git](06-files-git/spec.md) | Unverified |
| F074 | Diff review and agent feedback | V1 | [06-files-git](06-files-git/spec.md) | Verified |
| F075 | Ordinary Git operations | V1 | [06-files-git](06-files-git/spec.md) | Unverified |
| F076 | PR creation and management | Not now | [06-files-git](06-files-git/spec.md) | Not scheduled |
| F077 | Advanced PR status and review | Not now | [06-files-git](06-files-git/spec.md) | Not scheduled |
| F078 | Multiple forge support | V1 | [06-files-git](06-files-git/spec.md) | Unverified |
| F079 | Issue tracker integrations | Not now | [06-files-git](06-files-git/spec.md) | Not scheduled |
| F080 | Change attribution | Not now | [06-files-git](06-files-git/spec.md) | Not scheduled |
| F081 | Persistent terminals | V1 | [07-terminals-services](07-terminals-services/spec.md) | Unverified |
| F082 | Terminal ergonomics | V1 | [07-terminals-services](07-terminals-services/spec.md) | Unverified |
| F083 | Programmatic terminal access | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-hooks-auth.md)) |
| F084 | Saved commands | Not now | [07-terminals-services](07-terminals-services/spec.md) | Not scheduled |
| F085 | Dev port discovery | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-services.md)) |
| F086 | Managed dev services | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-services.md)) |
| F087 | Port allocation | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-services.md)) |
| F088 | Stable dev URLs and proxying | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-services.md)) |
| F089 | Peer-service environment wiring | V1 | [07-terminals-services](07-terminals-services/spec.md) | Unverified |
| F090 | Workspace scripts | V1 | [07-terminals-services](07-terminals-services/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-services.md)) |
| F091 | Embedded browser | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F092 | Browser profiles | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F093 | Browser import | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F094 | Design context capture | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F095 | Agent browser automation | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F096 | Browser diagnostics | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F097 | Browser recording | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F098 | Computer and screen access | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F099 | iOS simulator integration | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F100 | Android device and emulator integration | V1 | [08-browser-devices](08-browser-devices/spec.md) | Unverified |
| F101 | Complete application command API | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-orchestration.md)) |
| F102 | CLI support | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-orchestration.md)) |
| F103 | Client SDK | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-orchestration.md)) |
| F104 | Delegation | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Unverified |
| F105 | Parallel runs and comparison | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-orchestration.md)) |
| F106 | Parent and child tracking | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Unverified |
| F107 | Agent messages, waits and questions | V1 | [09-api-orchestration](09-api-orchestration/spec.md) | Unverified |
| F108 | Task DAG orchestration | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F109 | Advanced orchestration recovery engine | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F110 | Specialist discovery | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F111 | Scheduled automation | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F112 | Heartbeat automation | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F113 | Conditional automation | Not now | [09-api-orchestration](09-api-orchestration/spec.md) | Not scheduled |
| F114 | Desktop notifications | V1 | [10-notifications](10-notifications/spec.md) | Unverified |
| F115 | Push notifications | Design now, ship later | [10-notifications](10-notifications/spec.md) | Not scheduled |
| F116 | Cross-client notification coordination | Design now, ship later | [10-notifications](10-notifications/spec.md) | Not scheduled |
| F117 | Activity feed | V1 | [10-notifications](10-notifications/spec.md) | Unverified |
| F118 | Ongoing widgets | Not now | [10-notifications](10-notifications/spec.md) | Not scheduled |
| F119 | Dictation | Design now, ship later | [10-notifications](10-notifications/spec.md) | Not scheduled |
| F120 | Conversational voice | Design now, ship later | [10-notifications](10-notifications/spec.md) | Not scheduled |
| F121 | Direct LAN/VPN connectivity | V1 | [11-remote](11-remote/spec.md) | Unverified |
| F122 | Pairing and revocation | V1 | [11-remote](11-remote/spec.md) | Unverified |
| F123 | Relay connectivity | Design now, ship later | [11-remote](11-remote/spec.md) | Not scheduled |
| F124 | SSH bootstrap and connection | V1 | [11-remote](11-remote/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-remote.md)) |
| F125 | Remote workspaces | V1 | [11-remote](11-remote/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-remote.md)) |
| F126 | Multiple execution hosts | V1 | [11-remote](11-remote/spec.md) | Unverified |
| F127 | Execution placement | V1 | [11-remote](11-remote/spec.md) | Accepted: headless E2E `3401554` ([evidence](evidence/e2e-remote.md)) |
| F128 | Disposable VM/container environments | Not now | [11-remote](11-remote/spec.md) | Not scheduled |
| F129 | Remote previews and device access | V1 | [11-remote](11-remote/spec.md) | Unverified |
| F130 | Polished self-host deployment product | Not now | [11-remote](11-remote/spec.md) | Not scheduled |
| F131 | Central MCP catalog | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F132 | Central skill catalog | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F133 | ADE MCP server | Not now | [12-integrations-operations](12-integrations-operations/spec.md) | Not scheduled |
| F134 | Skill sharing | Not now | [12-integrations-operations](12-integrations-operations/spec.md) | Not scheduled |
| F135 | Artifact publishing | Not now | [12-integrations-operations](12-integrations-operations/spec.md) | Not scheduled |
| F136 | Resource visibility | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F137 | Diagnostics | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F138 | Retention and cleanup | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F139 | HMR and plugin development | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |
| F140 | Conformance and fault coverage | V1 | [12-integrations-operations](12-integrations-operations/spec.md) | Unverified |

## Completion rule

Record a feature as complete only with its supported provider/platform matrix, linked E2E evidence and resolved delivery decisions. Record partial coverage explicitly. A ready-for-agent specification can be decomposed and implemented; it is not proof that dependencies are complete or unresolved coverage choices have answers. Deferred and excluded items cannot be silently added to v1, and generic adapters cannot silently remove selected requirements.

## Shared release requirements

These apply in addition to the 107 selected features.

| ID | Requirement | Specification | Implementation |
|---|---|---|---|
| R001 | Keep accepted operations after a daemon failure | [Shared reliability](13-reliability/spec.md) | Unverified |
| R002 | Receive consistent retry results | [Shared reliability](13-reliability/spec.md) | Unverified |
| R003 | Cancel one run without affecting its successor | [Shared reliability](13-reliability/spec.md) | Unverified |
| R004 | Stop existing execution during overload | [Shared reliability](13-reliability/spec.md) | Unverified |
| R005 | Retain independent work across frontend and daemon restarts | [Shared reliability](13-reliability/spec.md) | Unverified |
| R006 | See actual process uncertainty | [Shared reliability](13-reliability/spec.md) | Unverified |
| R007 | Coordinate physical resources across profiles | [Shared reliability](13-reliability/spec.md) | Unverified |
| R008 | Know when output recovery reaches its limit | [Shared reliability](13-reliability/spec.md) | Unverified |
| R009 | Keep one slow client from degrading other work | [Shared reliability](13-reliability/spec.md) | Unverified |
| R010 | Restore a consistent application view | [Shared reliability](13-reliability/spec.md) | Unverified |
| R011 | Avoid stale results after changing context | [Shared reliability](13-reliability/spec.md) | Unverified |
| R012 | Retain account identity through credential changes | [Shared reliability](13-reliability/spec.md) | Unverified |
| R013 | Continue active work while plugins update | [Shared reliability](13-reliability/spec.md) | Unverified |
| R014 | Restore a complete managed backup | [Shared reliability](13-reliability/spec.md) | Accepted: headless E2E `df9c032` ([evidence](evidence/e2e-backup.md)) |
| R015 | Control retention without losing referenced work | [Shared reliability](13-reliability/spec.md) | Unverified |
| R016 | Keep preview content separate from application authority | [Shared reliability](13-reliability/spec.md) | Unverified |
| R017 | Keep remote targets stable during connection failure | [Shared reliability](13-reliability/spec.md) | Unverified |
| R018 | Understand failures without exposing secrets | [Shared reliability](13-reliability/spec.md) | Unverified |
| R019 | Use many active resources responsively | [Shared reliability](13-reliability/spec.md) | Unverified |
| R020 | Run the packaged application independently of development tooling | [Shared reliability](13-reliability/spec.md) | Unverified |
