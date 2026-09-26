# <slice name>

Status: <merged | returned>
Type: slice evidence
Branch: claude/<slice>
Worker: <workflow run and agent label>
Requirements: <feature IDs and R-requirements this slice advances; "none" for foundation work>

## Outcome

<What changed, in two or three sentences. Name any requirement this fully accepts.>

## Operation tiers

<Each operation this slice added or changed, with its tier: query, idempotent command or effect command.>

## Checks

- `pnpm check:static`: <pass/fail>
- In-process tests added: <file paths, or none>

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| <minutes> | <minutes> | <minutes> | <minutes> |

## References

<One line per reference consulted: repo @ snapshot, path, studied | pattern | copied → ADE file. "None" if no reference was used.>

## Open

<What remains, or what the coordinator must change in shared files.>
