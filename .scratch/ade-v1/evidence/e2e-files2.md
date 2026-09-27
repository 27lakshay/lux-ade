# e2e-files2

Status: returned
Type: slice evidence
Branch: claude/wf_58471be9-2ec-2
Worker: ADE parallel build, files worker (files2)
Requirements: F071, F073, F078 (06-files-git; decision D08)

## Outcome

Four headless specs in `e2e/protocol/files2/` close two gaps that
`e2e-files-git.md` left open. Browse, search and preview now pass on a remote
execution host, through that host's own daemon over the pinned SSH transport
and `ade remote request`. HTTPS remotes now pass clone, push, fetch and pull
with Git credential-helper authentication, and a rejected or missing credential
fails without a prompt. The specs found no product bug. They did find a
machine-safety hazard in the E2E harness, which is now fixed (see below).

No requirement is fully accepted. Each still has a part that no headless spec
can prove:

- F071: "without freezing the UI" needs the Electron UI.
- F073: renderer isolation of previews needs the Electron UI.
- F078: real TLS. On macOS, Git's TLS goes through the Security framework,
  which E2E must never call.

## Acceptance criteria

| Requirement | Criterion part | Spec | Result |
|---|---|---|---|
| F071 | Browse on the execution host when that host is remote: bounded pages of up to 60, single-use cursors, served by the host's daemon | `remote-host.spec.ts` › browse, search and preview run on the remote execution host… | pass |
| F071 | Search on the remote host: case-insensitive, any depth; CLI `ade remote request file.search` | same | pass |
| F071 | Remote symbolic links: a link to a file elsewhere on the host is listed, never followed or previewed; `..` and absolute paths refused | same | pass |
| F071 | Remote permission failure: unreadable folder refused on list, skipped by search with `incomplete: true` | same | pass |
| F071 | Remote changed path: folder renamed between pages invalidates the cursor | same | pass |
| F071 | Nothing reaches the local profile: its catalog has no remote workspace, and it refuses the host's cursor | same | pass |
| F071 | Fault, link loss: file requests refused `not_sent`; after reconnect, the unsent cursor continues the listing exactly once | `remote-host.spec.ts` › a link loss refuses file requests unsent, and a remote daemon restart… | pass |
| F071 | Fault, remote daemon crash: a page in flight is `unavailable`; after restart, old cursors are expired and a fresh search works | same | pass |
| F071 | Local browse and search, large trees, local symlinks, permissions and changed paths | `files-git/browse.spec.ts` (round 3) | pass (re-run) |
| F071 | Without freezing the UI | none | UI part: not provable headlessly |
| F073 | Remote previews: text, whole PNG with exact bytes, HTML returned `unsupported` with no content (SDK and CLI) | `remote-host.spec.ts` › browse, search and preview… | pass |
| F073 | Local text and image previews, limits, unsupported formats, active content | `files-git/preview.spec.ts` (round 3) | pass (re-run) |
| F073 | Renderer isolation: a preview never receives application bridges or plugin authority | none | UI part: not provable headlessly |
| F078 | HTTPS clone, push, fetch and pull against a forge that demands Basic authentication; the credential helper answers; ADE keeps the HTTPS URL | `credentials.spec.ts` › HTTPS clone, push, fetch and pull authenticate through the credential helper… | pass |
| F078 | The token is stored nowhere by ADE: not in the clone, the remote URL, the daemon's data directory, its logs or the reply | same | pass |
| F078 | Rotated token: fetch fails with Git's `Authentication failed`, the helper is told to erase it; the new token then succeeds | `credentials.spec.ts` › a rejected or missing credential fails… | pass |
| F078 | No credential helper: clone fails at once (`terminal prompts disabled`), creates no folder, never prompts | same | pass |
| F078 | Coverage declaration, SSH, scp-like, file and refused transports | `files-git/forges.spec.ts` (round 3) | pass (re-run) |
| F078 | HTTPS over real TLS | none | not covered: the forge serves plain HTTP on 127.0.0.1 behind the HTTPS URL through `url.insteadOf`, because Git's TLS on macOS calls the Security framework |

Requirement IDs whose full register acceptance now passes as E2E: none.

No spec is marked `test.fixme`.

## Machine-safety fix in the harness

The daemon's `neutral()` (`crates/ade-daemon/src/worktrees.rs`) removes every
`GIT_CONFIG_*` variable before it runs Git. That includes the harness's
`GIT_CONFIG_NOSYSTEM=1`. So under E2E, the daemon's Git still read the Xcode
Git's built-in config, which sets `credential.helper = osxkeychain`. Any spec
whose Git met an HTTP authentication challenge would have run
`git-credential-osxkeychain` and reached the login keychain.

The fix is in the harness only. `scratchGitConfig()` in
`e2e/protocol/fixtures/environment.ts` writes `[credential] helper =` into
every scratch global Git config: `profile.ts`, `managed-profiles.ts` and
`remote-hosts.ts`. An empty `helper` value resets the helper list.

`credentials.spec.ts` also checks this before any network step.
`effectiveHelpers` in `files2/git-http.ts` reads the helpers that the daemon's
Git would run, using the same environment with the `GIT_CONFIG_*` variables
removed. It runs `git config` only, and no helper. The spec fails unless the
list is exactly the scratch helper.

The product behaviour is unchanged. For a real user, the daemon's Git should
keep the user's own credential helpers.

## Fixtures

`e2e/protocol/files2/git-http.ts` is local to this area:

- `HttpForge`: a Node HTTP server on 127.0.0.1. It runs `git http-backend`
  over bare repositories, requires Basic authentication and records every
  request.
- `credentialHelper`: a scratch helper that logs each action without the
  password.
- `effectiveHelpers`: the gate described above.

## Operation tiers

No operation was added or changed.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/files-git e2e/protocol/files2 e2e/protocol/remote e2e/protocol/ops3/repository-auth.spec.ts`:
  51 passed. `remote2` also ran inside that path set. It was run because the
  shared fixtures changed.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/files2`:
  4 passed after the last edit.
- `pnpm check:static`: pass.
- In-process tests added: none.
- `pgrep` found no `ade-daemon`, `ade-runtime` or `security` process left
  running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 5 | 15 | 0 |

## References

- ADE `e2e/protocol/remote/transport.spec.ts` and `remote/steps.ts`, pattern:
  the remote host, the transport and the CLI remote request.
- ADE `e2e/protocol/files-git/forges.spec.ts` and `fixtures/git-remotes.ts`,
  pattern: forge stand-ins through `url.insteadOf`.
- Git documentation: `git-http-backend(1)` CGI variables, and
  `gitcredentials(7)`, where an empty helper resets the list.

## Open

- The coordinator should note the shared fixture edits in `environment.ts`,
  `profile.ts`, `managed-profiles.ts` and `remote-hosts.ts`. Other rounds'
  specs that overwrite a scratch `.gitconfig` should start from
  `scratchGitConfig()`.
- F071 and F073 need Electron UI E2E for "without freezing the UI" and for
  renderer isolation of previews.
- F078 needs real TLS. The only safe route found is a Git whose TLS does not
  use the Security framework; macOS Apple Git's does. This is a user decision:
  either accept the plain-HTTP stand-in plus a check by hand, or run this part
  on Linux CI.
- F073: the daemon previews text and images only. It has no audio or video kind, so such files come back
  as `unsupported`. Whether "text/media previews" must include audio and video
  is a scope question for the user.
