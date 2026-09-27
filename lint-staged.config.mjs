// Runs on the files staged for a commit (.husky/pre-commit). Typecheck, boundaries, tests and E2E
// stay in `pnpm check:static`, which is too slow for every commit.
export default {
  '*.{ts,tsx,mts,cts,js,mjs,cjs}': ['oxlint --type-aware --fix', 'oxfmt --no-error-on-unmatched-pattern'],
  '*.{json,jsonc,css,html}': 'oxfmt --no-error-on-unmatched-pattern',
}
