// Runs on the files staged for a commit (.husky/pre-commit). Typecheck, boundaries, tests and E2E
// stay in `pnpm check:static`, which is too slow for every commit. A commit whose only staged
// scripts are ignored by the linter (generated contracts) has nothing to lint, which is not an error.
export default {
  '*.{ts,tsx,mts,cts,js,mjs,cjs}': [
    'oxlint --type-aware --fix --no-error-on-unmatched-pattern',
    'oxfmt --no-error-on-unmatched-pattern',
  ],
  '*.{json,jsonc,css,html}': 'oxfmt --no-error-on-unmatched-pattern',
}
