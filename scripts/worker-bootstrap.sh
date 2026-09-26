#!/bin/bash
# Prepare a worker worktree for the parallel build.
# It brings the tree up to the build branch, clones the gitignored native
# inputs the backend build needs from the main checkout, and installs
# JavaScript dependencies. Run it from inside the worker worktree.
set -euo pipefail

build_branch="codex/architecture-proposal"
cd "$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
if [ "$PWD" = "$main" ]; then
  printf 'Run this in a worker worktree, not the main checkout.\n' >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$build_branch" HEAD; then
  git merge --ff-only "$build_branch"
fi

mkdir -p .ade
for dir in native vendor tools; do
  if [ ! -e ".ade/$dir" ]; then
    cp -cR "$main/.ade/$dir" ".ade/$dir"
  fi
done

pnpm install --frozen-lockfile
printf 'Worker ready at %s on %s\n' "$(git rev-parse --short HEAD)" "$(git branch --show-current)"
