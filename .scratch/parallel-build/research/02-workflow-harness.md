# Research: a Workflow harness for a coordinator plus 2 workers in worktrunk trees

Ticket: [02-workflow-harness](../issues/02-workflow-harness.md) · Researched 2026-09-27 · Research only, nothing was run or changed.

## Answer

Use the Workflow tool for the workers only, and keep the coordinator in the main
Claude session, started in the main checkout `/Users/lakshyakumar/work/lux-ade`
where `codex/architecture-proposal` is checked out.

- **One workflow run per round of 2 slices.** The script runs 2 `agent()` calls
  with `isolation: 'worktree'` and a result `schema`, and returns. It does no
  merging. The coordinator reads the results, merges, runs the full check,
  removes the trees and launches the next round. The main session stays in the
  loop between rounds, and the Workflow docs recommend one run per stage when a
  step needs sign-off.
- **Worker trees are worktrunk trees already.** `isolation: 'worktree'` fires the
  `WorktreeCreate` hook. The machine plugin's hook replaces `git worktree add`
  with `wt switch --create claude/<slug> --no-hooks`, then runs `wt-setup`. No
  plain `git worktree` runs, so the machine rule holds.
- **The tree starts from `main`, not the build branch.** The hook payload carries
  only `name`, the hook passes no `--base`, and `wt switch --create` defaults to
  the default branch. `worktree.baseRef` has no effect while a hook is
  configured. The fix that needs no config change: the worker's first step is
  `git merge --ff-only codex/architecture-proposal`, then
  `pnpm install --frozen-lockfile`. `main` (e42e5e7) is an ancestor of the build
  branch, so the fast-forward always succeeds. The durable fix changes the hook
  to pass `--base @`. That is a dotfiles decision for the user; see the options table.
- **Removal.** A worker tree without changes is removed automatically through
  `WorktreeRemove` → `worktree-remove.sh` → `wt remove --no-hooks`. A tree with
  commits stays on disk; Claude's periodic sweep never removes hook-made trees.
  After merging, the coordinator runs `wt remove claude/<slug> --foreground` from
  the main checkout. If worktrunk keeps the branch because it is not merged into
  `main`, the coordinator runs `git branch -d claude/<slug>`. That works because
  the branch is merged into the checked-out build branch. Never `--force`, never `-D`.
- **Long checks.** A Bash call is capped at 10 minutes, and E2E takes 6–22
  minutes. A worker must run `pnpm test:e2e` with `run_in_background` into a log
  and wait on it with Monitor, or the user raises `BASH_MAX_TIMEOUT_MS`. A
  subagent's background commands die when it gives its final answer, so the
  worker must not answer before the check ends.
- **Cost.** Plan on about 20–45 minutes and roughly 2–8 M input tokens (over 95 %
  cache reads) plus 15–60 k output tokens per slice worker. That is an estimate
  from this repo's Codex slice sessions, not a Claude measurement. A 2-worker
  round will trip the advisory `Large workflow` warning (1.5 M projected tokens).

### Options for making a worker start from the build branch

| Option | What it costs | What it buys |
|---|---|---|
| A. Worker fast-forwards itself (`git merge --ff-only codex/architecture-proposal`) as step 1 | One line in every worker prompt. `wt-setup` installs deps for `main` first, so the worker must reinstall. | No config change. Works today. |
| B. Hook passes `--base @` (the hook's `cwd` is the coordinator's checkout) | A dotfiles edit that changes every Claude-made tree on the machine to branch from the caller's HEAD, like `worktree.baseRef: "head"`. | Correct base and correct deps at setup. No prompt discipline needed. |
| C. Hook honours `worktree.baseRef` from settings and passes `--base @` only when it is `"head"` | Harder hook edit: it must read the settings files. | Machine default stays `main`. This repo opts in with one project setting. |
| D. Coordinator cuts trees with `wt switch --create … --base codex/architecture-proposal`; workers run without isolation | Blocked: a worker's cwd would be the main checkout, and `hazards.py` refuses Edit/Write into `~/work/worktrees/*` from there. | Nothing usable. |

I would pick **A now and C later**. A needs no decision from the user. C keeps the
machine default and fixes the base at the source.

## Facts, with sources

### 1. Worker trees go through the hook and land in worktrunk trees

- `WorktreeCreate` fires for `claude --worktree`, for subagents with
  `isolation: "worktree"` and for background sessions, and it *replaces* the git
  step. Source: https://code.claude.com/docs/en/hooks.md#worktreecreate, and
  `~/dotfiles/docs/claude-code-docs.md` §2.
- The machine plugin registers it: `~/dotfiles/claude/plugin/hooks/hooks.json`
  (`WorktreeCreate` → `scripts/worktree-create.sh`, timeout 180 s;
  `WorktreeRemove` → `scripts/worktree-remove.sh`, timeout 300 s).
- `~/dotfiles/claude/plugin/scripts/worktree-create.sh` runs
  `wt switch [--create] claude/<name> --no-hooks --no-cd --format json` from the
  payload's `cwd`. It then runs `wt-setup`, which copies ignored files, trusts
  `.envrc` and starts `pnpm install` detached. The path follows
  `~/dotfiles/config/worktrunk/config.toml`:
  `~/work/worktrees/lux-ade/claude-<slug>`.
- **Unverified for Workflow agents specifically.** The Workflow docs
  (https://code.claude.com/docs/en/workflows.md) do not say that `agent({isolation:
  'worktree'})` uses the same path as a subagent. The workflow-authoring skill
  calls it "a fresh git worktree" and says it is auto-removed if unchanged, which
  matches subagent behaviour. Confirm it with a one-agent probe run before the
  first real round.

**The base ref.**

- The hook input is the common fields plus `name` only
  (https://code.claude.com/docs/en/hooks.md, "WorktreeCreate input"). No base,
  ref or branch arrives.
- `wt switch --help` (v0.74.0) says: `-b, --base <BASE>  Base branch. Defaults to
  default branch.` The default branch here is `main`.
- `worktree.baseRef` accepts only `"fresh"` or `"head"`, never a branch name. It
  governs Claude's own git step, which the hook replaces
  (https://code.claude.com/docs/en/worktrees.md#choose-the-base-branch).
- This session's own tree shows the result. `git reflog show
  claude/parallel-build` reads `branch: Created from main`, then `reset: moving to
  codex/architecture-proposal`. The same mismatch left
  `claude/workbench-prototype` at e42e5e7.
- Consequence: `wt-setup` starts `pnpm install` against `main`'s tree before the
  worker moves it. This tree has no `node_modules` and no `target/`. A worker
  must install deps again after the fast-forward.

### 2. Removal

- A subagent tree with no changes is removed when the subagent finishes. A tree
  with changes stays until the periodic sweep can remove it without losing work.
  The sweep keeps any tree that lacks Claude's git marker, which includes every
  hook-made tree (https://code.claude.com/docs/en/worktrees.md, "Clean up subagent
  and background-session worktrees"). **So every tree with worker commits stays
  until the coordinator removes it.**
- The `WorktreeRemove` hook runs `wt remove <path> --foreground --no-hooks` from
  the main checkout. It never uses `--force`, and it refuses the main checkout
  (`worktree-remove.sh`). A dirty tree is kept.
- `wt remove` deletes the branch only if it is merged. Otherwise it keeps the
  branch (`wt remove --help`). It is not documented whether "merged" means merged
  into `main` or into the current branch; see Uncertain.
- `wt-retire` is worktrunk's `post-remove` hook (`config.toml`). The hook path
  skips it (`--no-hooks`) for symmetry with the hook-made creation. A plain
  `wt remove` by the coordinator runs it, and it adds its report of commits on no
  remote. Every worker commit is on no remote because the build does not push, so
  expect that report every time and treat it as a record, not a warning
  (`~/dotfiles/agents/machine/worktrees.md`, "Removal").
- Guards: `wt remove --force` is denied by `~/dotfiles/claude/policy.json` and by
  `hazards.py`. `git worktree add|remove|prune` is refused by both.

### 3. Long builds and E2E inside a workflow agent

- The Bash timeout defaults to 120 s and has a 600 s ceiling. It is set with
  `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`, and it applies to subagents
  (https://code.claude.com/docs/en/tools-reference.md, Bash). `pnpm test:e2e` runs
  `build:backend`, `build` and `playwright test` (`package.json`) and takes 6–22
  minutes. It does not fit in one call.
- A command that times out moves to the background automatically. A subagent's
  background commands stop when that subagent gives its final response (same page).
- Two workable patterns:
  1. The worker runs `pnpm test:e2e > <tree>/.wt/e2e.log 2>&1` with
     `run_in_background`, then waits with Monitor until the process exits, then
     reads the log tail. Monitor is a deferred tool that workflow agents load
     through ToolSearch.
  2. The user sets `BASH_MAX_TIMEOUT_MS` to about 1 800 000 in the settings `env`.
     This is a config change and his call.
- Cold trees are slow. Each new tree has no `target/` (the main checkout's is
  6.7 GB) and no `node_modules`, because `config.toml` excludes both from
  `copy-ignored`. The first `build:backend` in each tree is a cold Rust build of
  unmeasured length. Ticket 03 or 12 should measure it. A per-worker-slot
  `CARGO_TARGET_DIR` outside the tree may help, but cargo locks the build directory
  per build, so two workers must not share one.
- Prompt cache: a workflow agent's cache lives 5 minutes by default. A worker idle
  through a 20-minute E2E re-writes its prefix on every wake-up.
  `subagentPromptCacheTtl: "1h"` avoids that at a higher write rate
  (https://code.claude.com/docs/en/workflows.md, "Prompt caching in a fan-out").
- Permission prompts pause the run. Add allow rules first for the commands workers
  need: pnpm, cargo, git add/commit/merge, and the playwright commands
  (workflows.md, "Approve the plan before it runs").

### 4. Failures and resume

- `agent()` returns `null` when the user skips or stops the agent, or when it dies
  on a terminal API error after retries. `parallel()` never rejects, so filter the
  results (workflow-authoring skill; workflows.md). A worker that hits a failing
  check still finishes normally. Its failure appears only in its returned text, so
  give every worker a `schema` such as
  `{status: 'done'|'blocked'|'failed', branch, head, checksRun, checksPassed, blocker}`.
- The script cannot pause for input. It pauses only for agent permission prompts
  and a usage-limit wait (v2.1.271+, interactive subscription sessions only).
- Resume: relaunch with `Workflow({scriptPath, resumeFromRunId})`, in the **same
  session**, or in one reopened with `claude --resume`. The replay follows start
  order. Completed agents return cached results. A failed agent reruns, and so
  does **every agent that started after it**. The first agent whose prompt changed
  reruns along with everything after it. If agents from a stopped run have not
  exited, the relaunch is refused. Failure causes and the per-agent record are in
  `<transcriptDir>/journal.jsonl` (workflows.md, "Resume after a pause";
  workflow-authoring skill).
- Worktree consequence: a rerun of a worker creates a **new** tree with a new slug
  from `main`. The old tree and its partial commits stay orphaned. Tell workers
  to commit early. On a rerun, the coordinator finds the old
  `claude/<slug>` branch and has the new worker merge it, or removes the old tree
  by hand. Keeping each run to one round of 2 workers keeps the rerun blast
  radius to one slice pair.

### 5. Merging back into `codex/architecture-proposal`

- `codex/architecture-proposal` is checked out in the main checkout
  `/Users/lakshyakumar/work/lux-ade` (`git worktree list`). Git will not update a
  branch that is checked out in another tree through a plain merge from a linked
  tree. Claude Code's isolation checks also block any Bash `cd`, `git -C` or
  Edit into the main checkout from an isolated session. This research session hit
  exactly that refusal (https://code.claude.com/docs/en/worktrees.md, "How Claude
  Code enforces isolation").
- So the coordinator must be a session started in the main checkout, not in a
  worktree. From there it runs
  `git merge --no-ff claude/<slug>` for each worker branch. Worker branches are
  visible there because all trees share one `.git`. It then runs `pnpm check`
  (again in the background with Monitor, for the same 10-minute cap). Last, it
  removes each tree as in §2.
- The main checkout must be clean, and nobody else may work in it. The Codex build
  agent currently works there and must stay paused while the coordinator runs.
  This is the map's standing choice.
- A non-isolated `agent()` inside the script would run with the session's cwd
  (the main checkout) and could merge too. Keeping the merge in the main loop is
  simpler, and a merge conflict is then handled with full context.

### 6. Cost and time per slice-sized worker

- There is no Claude slice measurement yet. No workflow run exists on this machine
  (no `journal.jsonl` under `~/.claude-rightfit/projects`).
- Proxy: this repo's Codex sessions on 2026-09-26/27
  (`~/.codex/sessions/2026/09/2{6,7}`, cwd `lux-ade`). Slice-sized sessions ran
  8–37 minutes, with 2.4–8 M total input tokens (96–98 % cached) and 10–30 k
  output tokens. The one long session ran 150 minutes with 25.6 M input and 62 k
  output.
- Claude estimate per worker: about 20–45 minutes wall time. That is 1–3 minutes
  of setup (fast-forward and `pnpm install`), plus a cold Rust build of unknown
  length, 4–12 minutes of implementation and 6–22 minutes of checks. Tokens:
  roughly 2–8 M input, mostly cache reads, and 15–60 k output.
- A round of 2 workers costs about twice that, plus the coordinator's merge and
  full check (6–22 minutes). The Workflow runtime shows each agent's tokens in
  `/workflows` for measuring the real number (ticket 12).

## Uncertain or skipped

- **Not run.** No probe workflow was launched; this was research only. Whether a
  Workflow `agent({isolation:'worktree'})` fires the machine's `WorktreeCreate`
  hook is inferred from the subagent docs. A one-agent probe settles it cheaply.
- **Doc disagreement.** A docs-summarising agent and a WebFetch summary both
  claimed the hook payload carries `base`, `ref` and `worktree_path`. The raw
  `hooks.md` shows only `name`, which matches the comment in
  `worktree-create.sh`. I relied on the raw page.
- **`wt remove`'s "merged" target** (default branch or current branch) is not
  documented in `--help`. The `git branch -d` fallback covers either answer.
- **Harness lock on hook-made trees.** The docs say Claude holds a
  `git worktree lock` on a running agent's tree. It is unclear whether that
  applies to a hook-made tree, and whether it blocks the coordinator's `wt remove`
  until the agent exits.
- **Tracker writes from worker trees.** The machine rule exempts `<main>/.scratch/`,
  but Claude Code's own isolation check refused this session's Write to
  `/Users/lakshyakumar/work/lux-ade/.scratch/...` ("Edit the worktree copy of this
  file instead"). Also, `.scratch/ade-v1/**` is tracked in git, so each worker has
  its own copy on its branch. Workers therefore record evidence in their tree's
  tracked `.scratch` copy, and those edits merge through git, with conflicts in
  shared files such as `progress.md`. This matters for ticket 13 and the map's
  "Not yet specified" item on `progress.md`.
- **Monitor inside workflow agents** is assumed available through ToolSearch; not
  tested.
- **Cold-build time** per fresh tree was not measured.
