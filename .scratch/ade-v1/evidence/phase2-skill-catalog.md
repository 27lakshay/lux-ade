# skill-catalog

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-6
Worker: Phase 2 round B, skill-catalog worker
Requirements: F132 (advanced, not accepted); D14 (external ownership rule enforced in the backend)

## Outcome

The profile daemon now has a skill catalog. It stores complete, pinned skill
bundles as blobs in `sessions.sqlite`, and records references to skills that
Claude, Codex, OpenCode and Oh My Pi read from their own paths. Six typed
operations and an `ade skill` CLI install, adopt, remove, list, inspect and
discover skills. Inspect reports a per-provider projection. The catalog never
writes, moves or deletes a file outside the database. F132 is not accepted: no
placement into provider paths, no invocation through adapters, and no E2E.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `skill.install` | effect command | Receipt in `sessions.sqlite`. Optional `expected_content_hash` pin. Replacing a same-name bundle needs `replace_content_hash`. |
| `skill.adopt` | effect command | Only a plain directory directly inside a provider root. The hash must match the one discovery reported. Records the path as catalog-owned. |
| `skill.remove` | effect command | Needs the installed hash. Releases adopted paths and leaves their files in place. |
| `skill.list` | query | Bundles and stored references. |
| `skill.inspect` | query | Manifest, provenance, blob integrity check and provider projection. |
| `skill.discover` | idempotent command | Scans roots and replaces the stored references for the scanned scopes. |

Storage: four tables, `skill_bundles`, `skill_blobs`, `skill_adoptions` and
`skill_references`. They are created with `CREATE TABLE IF NOT EXISTS` before
each use; no migration was added. Blobs and the bundle row commit in one
transaction with the receipt, and `inspect` fails closed when the blobs do not
match the manifest. Because the tables live in `sessions.sqlite`, the existing
online backup copies them. That is inferred from the backup code, not tested.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/skills/bundle.rs`: frontmatter parsing, name and path rules, manifest and content hash, rejection cases
  - `crates/ade-daemon/src/skills/placement.rs`: provider roots, placement and adoption decisions, install pinning, remove check
  - `crates/ade-core/src/contract/skills.rs`: contract round-trips and declared tiers
- Manual smoke run, not a gate: a debug daemon with a fixture `HOME`, driven
  through the built CLI. It covered install, same-ID replay, pin mismatch,
  operation-ID reuse with other parameters, discovery (valid, invalid and
  symlinked entries), refused adoption of a symlink, stale-hash adoption,
  adoption, drift after an edit, and removal. After removal the adopted
  directory was still on disk and no blobs or bundle rows remained.

Verified only statically or in process: workspace-scoped roots (no workspace was
registered in the smoke run), the drain guard, and concurrency between discovery
and adoption.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- orca @ ade-evaluation-2026-09-24 `src/main/skills/skill-provider-destinations.ts` — pattern (per-provider roots)
- orca @ ade-evaluation-2026-09-24 `src/main/skills/skill-install-provenance.ts`, `skill-removable-placement.ts` — pattern (receipt of what was placed; remove only what the catalog placed)
- opencode-v2 @ ade-evaluation-2026-09-24 `packages/core/src/config/plugin/skill.ts` — studied (`skill` and `skills` under config directories)
- oh-my-pi @ ade-evaluation-2026-09-24 `packages/coding-agent/src/discovery/builtin.ts`, `discovery/codex.ts`, `discovery/claude.ts` — studied (provider skill roots)
- agentskills.io/specification (read 2026-09-27) — name, description and compatibility rules

No code was copied.

## Open

- Placement is not built. Writing a bundle into a provider path (with
  `create` or `replace` decisions only) and revoking such placements remain.
- Adapter invocation and frontmatter differences per provider (F132 "invoke
  through adapter rules") are not built.
- The provider root table covers default locations only. Account-specific
  homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` under ADE-managed native homes) are
  not modelled. The Codex and OpenCode paths come from reference repositories,
  not from their current documentation.
- The frontmatter reader handles the scalar forms skills use for the fields it
  reads. Other YAML forms in those fields fail closed as invalid.
- Remote installation is out of scope for this slice.
- There is no `skill.*` feed frame. Clients must re-query after changes.
- Errors use the generic error envelope with no typed `conflict` code.
- E2E later: install, adopt and remove through the running app, and a backup
  and restore that keeps the catalog blobs.
- The CLI adds three lines to `apps/cli/src/index.ts`: an import, the usage
  fragment and the command area.
