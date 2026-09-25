# Delivery decisions and constraints

Status: ready-for-agent
Type: decision register

These are unresolved implementation or coverage details, not permission to drop
selected features. Implementers can investigate technical choices autonomously;
material scope, exposure or destructive-behavior decisions must be made explicit
before the affected capability ships. Nothing here blocks unrelated work.

| ID | Applies to | Decision needed | Current direction / acceptance boundary |
|---|---|---|---|
| D01 | Foundation / F139 | Exact toolchain and package versions | React, Electron, xterm and Fallow selected; Vite/electron-vite proposed. Verify current official docs, licenses and compatibility before pinning. |
| D02 | Public contracts | Schema generator and local/remote transport | One authoritative wire schema, generated bindings and runtime validation; test nullability, tagged unions, large integers and bytes. SDK stays framework-neutral. |
| D03 | F022 | Additional bundled-provider roster | Primary Claude Code/Codex/Oh My Pi mandatory. Name any additional providers and capability matrix before declaring F022 complete. |
| D04 | F024/F026/F028/F039/F040/F042 | Native adapter capability coverage | Record actual provider-supported steering, account switching, rewind, compaction, import/resume and generic protocol support; unavailable is explicit, not fabricated. |
| D05 | F051–F060 | Plugin host runtime and grouping | Headless-compatible host; Node LTS proposed. Preserve actual Oh My Pi runtime needs. Pin leased artifacts; no premature mandatory Effect dependency. |
| D06 | F081/F082/R008 | xterm recovery format and bounded history | Preserve the current Ghostty snapshot for GPUI. Proposed `xterm-replay-v1` atomically replays bounded raw PTY output from process start, initial geometry and every resize before live frames. The current 256 KiB tail is insufficient. On quota exhaustion, report incomplete recovery; never claim an exact restore. First prove that xterm-generated terminal replies do not duplicate Rust Ghostty replies before forwarding input. |
| D07 | F013/F020/F031/F054/F074 | Primitive/composer/list/docking/Markdown packages | Base UI, Tiptap, Pierre Diffs, Shiki and other candidates are recommendations, not user selections. Choose with real E2E behavior and lifecycle requirements. |
| D08 | F078 | Forge/auth support matrix | Ordinary Git/repository support only; declare named coverage. Do not introduce excluded PR management or issue integrations. |
| D09 | F088 | Public aliases and exposure policy | Local/private stable HTTP/WebSocket routes first. Any public alias must define authentication, address ownership, lifecycle and explicit exposure; do not silently publish a dev service. |
| D10 | F093 | Browser import sources and data classes | Specify supported source versions/cookies/bookmarks/etc. No assumed import of encrypted credentials or arbitrary live session state. |
| D11 | F097 | Recording capture kinds and output formats | Define local artifact formats and supported video/action/diagnostic capture scope. External publishing remains excluded. |
| D12 | F098–F100/F129 | Computer/device and remote transport coverage | Define supported OS/device/tool versions and view/control functions. Missing permission, hardware or remote support produces explicit unavailability. |
| D13 | F121–F124 | Trust, transport and revocation mechanics | Explicit authenticated host pairing/direct/SSH paths; retain remote-owned credentials. Relay not required. |
| D14 | F131/F132 | MCP versions and skill installation paths | Preserve provider semantics on both gateway legs and support explicit direct setup where needed. Skills retain complete resources/provenance; external ownership is respected. |
| D15 | F050/F138/R014 | Backup, export and retention coverage | Declare formats, supported restore versions, excluded native/private/secret data, spool limits and artifact retention. No silent incomplete-backup guarantee. |
| D16 | F136/F140/R019 | Resource budgets and minimum supported hardware | Measure stated reference workload; establish supported machine and bounded queues/retention before publishing performance claims. |
| D17 | R020 | Signing, update distribution and supported macOS range | Local usable artifact first. Public signing/update identities and minimum successor macOS version are not inferred from prototype or Electron defaults. |

## Locked constraints

- UI is a function of authoritative state plus local interaction state.
- Independent profiles/workspaces and explicit execution host identity.
- Agents have the same application authority as the user.
- Installed plugins are trusted code; no hostile-code sandbox claim.
- Rust daemon/runtime ownership, Electron desktop, React, xterm.js, pnpm and Fallow.
- New behavioral tests are E2E only; no new unit/component/isolated integration tests.
- Local daily usability is an intermediate milestone; all 107 selected features
  and shared reliability requirements define full v1.
- No commits or implementation work are authorized merely by these specifications.
