// Development only: puts the helper scripts (React Scan, react-grab, React DevTools) ahead of the
// app's entry in index.html, so they load before React. Used by electron.vite.config.ts.

/**
 * The entry script tag, however the dev server has written it: `./src/bootstrap.ts` as in the
 * file, `/src/bootstrap.ts` once Vite has resolved it, either with `?t=…` after the entry changes.
 */
const ENTRY = /<script type="module" src="\.?\/src\/bootstrap\.ts[^"]*">/

export function injectBeforeEntry(html: string, paths: string[]): string {
  if (paths.length === 0) return html
  // Fail loudly: a silent miss drops the helpers and looks like they were never on.
  if (!ENTRY.test(html)) throw new Error('Development helpers: the entry script tag was not found in index.html')
  const scripts = paths.map((path) => `<script type="module" src="${path}"></script>`).join('\n    ')
  return html.replace(ENTRY, `${scripts}\n    $&`)
}
