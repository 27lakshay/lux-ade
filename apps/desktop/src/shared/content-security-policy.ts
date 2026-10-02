// The app window's content security policy: sent as a header by the ade:// scheme and written into
// index.html by the build (electron.vite.config.ts). Scripts come only from the app and the
// enabled plugins' UI entry points;
// `wasm-unsafe-eval` lets them compile WebAssembly (the terminal's Ghostty), not evaluate strings.
// Styles allow inline style attributes, which React and Motion set. Nothing is framed, embedded or
// fetched from the network. `frame-ancestors` only works as a header, so the meta copy drops it.
const DIRECTIVES = {
  'default-src': ["'self'"],
  // `ade-plugin:` serves enabled plugins' UI entry points (src/main/plugin-ui.ts).
  'script-src': ["'self'", "'wasm-unsafe-eval'", 'ade-plugin:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
} satisfies Record<string, string[]>

type Directive = keyof typeof DIRECTIVES

/** The policy, with optional extra sources per directive (development tools only). */
export function contentSecurityPolicy(extra: Partial<Record<Directive, string[]>> = {}, meta = false): string {
  return Object.entries(DIRECTIVES)
    .filter(([name]) => !(meta && name === 'frame-ancestors'))
    .map(([name, sources]) => [name, ...sources, ...(extra[name as Directive] ?? [])].join(' '))
    .join('; ')
}
