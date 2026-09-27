// Reports each glass surface's contrast floor and fails if a surface cannot go translucent at all.
// Also lists where the solid baseline itself misses WCAG; those are reported, not failed, because
// glass is only held to the baseline there.
// Run: pnpm check:contrast
import { floors, MATERIAL, type Theme } from '../src/renderer/src/tokens.ts'

let failed = false
for (const theme of ['dark', 'light'] as Theme[]) {
  const m = MATERIAL[theme]
  console.log(`\n${theme}: material ${m.darkest.join(',')} .. ${m.lightest.join(',')}`)
  for (const f of floors(theme)) {
    const note = f.floor >= 1 ? '  FAIL: cannot be translucent' : ''
    console.log(
      `  ${f.surface.padEnd(7)} floor ${String(Math.round(f.floor * 100)).padStart(3)}%  set by ${f.binding}${note}`,
    )
    for (const b of f.baseline) console.log(`          baseline misses WCAG: ${b.check} ${b.ratio.toFixed(2)}:1`)
    if (f.floor >= 1) failed = true
  }
}
process.exit(failed ? 1 : 0)
