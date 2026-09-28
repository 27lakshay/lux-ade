// Vite replaces import.meta.env values when it builds, so code behind them (dev/bench.tsx) drops out
// of production builds.
interface ImportMetaEnv {
  readonly DEV: boolean
  /** `VITE_ADE_BENCH=1 pnpm build` keeps the benchmark mode in a production build, to measure it. */
  readonly VITE_ADE_BENCH?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
