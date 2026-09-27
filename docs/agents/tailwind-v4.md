# Tailwind CSS v4 notes for agents

Tailwind publishes no `llms.txt` or official skill. Most training data describes v3; v4 differs in
the ways below. Checked 2026-09-28 against [the v4 docs](https://tailwindcss.com/docs) and
[the upgrade guide](https://tailwindcss.com/docs/upgrade-guide).

- **No `tailwind.config.js`.** Configuration lives in CSS. The entry stylesheet starts with
  `@import "tailwindcss";`.
- **Theme values are CSS variables** declared in `@theme { … }` (for example
  `--color-panel: …;` creates `bg-panel`, `text-panel`). `@theme inline` references other
  variables without copying their values; ADE uses it to map `tokens.ts` variables.
- **Custom variants and utilities:** `@custom-variant` and `@utility` replace plugins written in
  JavaScript.
- **Vite:** the `@tailwindcss/vite` plugin; no PostCSS config is needed.
- **Renamed defaults** from v3: `shadow-sm` is now `shadow-xs` and `shadow` is `shadow-sm`; the same
  shift applies to `rounded` and `blur`. `ring` is 1px by default (was 3px). Borders and rings use
  `currentColor` by default.
- **Opacity modifiers** (`bg-black/50`) replace `bg-opacity-*`.
- **Arbitrary values** still work (`w-[240px]`), but ADE prefers tokens; a design-system lint
  is planned to flag raw colours.
