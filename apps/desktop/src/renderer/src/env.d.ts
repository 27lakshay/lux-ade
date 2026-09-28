// Vite replaces import.meta.env.DEV when it builds, so code behind it (dev/bench.tsx) drops out of
// production builds.
interface ImportMetaEnv {
  readonly DEV: boolean
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
