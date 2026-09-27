# split-cli

Status: returned
Type: slice evidence
Branch: claude/wf_a0f63275-5ea-3
Worker: parallel build Phase 0 hot-file splits, split-cli worker
Requirements: none (foundation work; step 3 of the hot-file seams research)

## Outcome

`apps/cli/src/index.ts` is split into `apps/cli/src/commands/{workspaces,conversations,accounts,terminals,services,git,browser}.ts`.
Each module exports its handler and its usage fragment. `index.ts` keeps parsing, profiles,
error reporting and dispatch, and assembles the help text from the fragments in a fixed order.
The error type and the arguments helpers every area uses (`CliError`, `ErrorCode`, `required`,
`namedOptions`, `jsonObject`, `object`, `catalog`) live in `apps/cli/src/shared.ts`, so no
command module imports the entry file. Help output is byte-identical to the pre-split build.

## Operation tiers

No operation added or changed. Daemon op strings, CLI commands and all user-visible text are unchanged.

## Checks

- Help diff: `node apps/cli/dist/index.js --help` and no-argument output compared with `cmp` against the pre-split build: identical (9,525 bytes).
- `pnpm --filter @ade/cli typecheck`: pass
- `pnpm deadcode`: pass
- `pnpm build`: pass
- `pnpm check:static`: pass
- In-process tests added: none

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 15 | 0 | 10 | 0 |

## References

None

## Open

- Domain-specific argument validators moved with their area: `generation` to accounts,
  `integer` to terminals, `revision`/`tailBytes`/`port`/`sha256` to services,
  `reviewSearchLimit`/`reviewSearchCursor` to git.
- `listener list` sits in `commands/services.ts` with its own `listenerUsage` fragment, because its
  help line follows the git section.
