// Builds the window's terminal engine: libghostty-vt as WebAssembly, from the same vendored and
// pinned Ghostty source the daemon's runtime uses (native/dependencies.json), so the window can
// restore the daemon's Ghostty snapshots exactly. The native core alone answers terminal queries.
//
// Needs the vendored source (`python3 scripts/bootstrap.py --sources-only`). Uses bootstrap's Zig at
// .ade/toolchains/zig/zig (or ADE_ZIG_BIN), downloading and verifying the pinned Zig if missing.
// Output: packages/terminal/src/ghostty/vendor/. Run: node scripts/build-ghostty-wasm.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'native/dependencies.json'), 'utf8'))
const source = join(root, '.ade/vendor/libghostty-vt')
const output = join(root, 'packages/terminal/src/ghostty/vendor')
const zig = process.env.ADE_ZIG_BIN ?? join(root, '.ade/toolchains/zig/zig')

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function ensureZig() {
  if (existsSync(zig)) return
  const { url, sha256, subdirectory } = manifest.zig
  const work = mkdtempSync(join(tmpdir(), 'ade-zig-'))
  try {
    const archive = join(work, 'zig.tar.xz')
    run('curl', ['-fsSL', '-o', archive, url])
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (digest !== sha256) throw new Error(`Zig archive checksum ${digest} does not match the manifest`)
    run('tar', ['-xJf', archive, '-C', work])
    mkdirSync(join(root, '.ade/toolchains'), { recursive: true })
    run('mv', [join(work, subdirectory), resolve(zig, '..')])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (!existsSync(join(source, 'build.zig'))) {
  throw new Error('Missing the vendored Ghostty source; run: python3 scripts/bootstrap.py --sources-only')
}
ensureZig()
const version = spawnSync(zig, ['version'], { encoding: 'utf8' }).stdout.trim()
if (version !== '0.16.0') throw new Error(`Expected Zig 0.16.0, got ${version}`)

const pin = /tar\.gz\/([0-9a-f]{40})/.exec(manifest.sources['libghostty-vt'].url)?.[1] ?? 'unknown'
const build = mkdtempSync(join(tmpdir(), 'ade-ghostty-wasm-'))
try {
  run(
    zig,
    ['build', '-Demit-lib-vt', '-Dtarget=wasm32-freestanding', '-Doptimize=ReleaseSmall', '-Dstrip=true', '-p', build],
    source,
  )
  mkdirSync(output, { recursive: true })
  copyFileSync(join(build, 'bin/ghostty-vt.wasm'), join(output, 'ghostty-vt.wasm'))
  // The same pin as the daemon's snapshot format (ghostty-snapshot-v1-herdr-<pin>).
  writeFileSync(join(output, 'VERSION'), `herdr ${pin}\nzig ${version}\n`)
} finally {
  rmSync(build, { recursive: true, force: true })
}
console.log(`Built libghostty-vt WebAssembly from herdr ${pin} into ${output}`)
