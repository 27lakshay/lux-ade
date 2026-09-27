// react-devtools-core ships no types; this is the one call ADE makes.
declare module 'react-devtools-core' {
  export function connectToDevTools(options?: { host?: string; port?: number }): void
}
