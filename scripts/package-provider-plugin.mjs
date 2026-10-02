// Assembles a self-contained provider plugin artifact: the package's own files and
// its production dependency closure (the provider SDK, its contracts and the pinned
// Effect runtime), resolved offline from the root lockfile. `plugin.install` then
// takes the output directory like any other local plugin; nothing is resolved from
// the repository at run time.
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Workspace packages a provider plugin may depend on, with the built files each ships. */
const WORKSPACE_PACKAGES = {
  '@ade/contracts': { directory: 'packages/contracts', include: ['dist'] },
  '@ade/provider-sdk': { directory: 'packages/provider-sdk', include: ['dist', 'examples'] },
}

async function copyPackage(source, target, include) {
  await mkdir(target, { recursive: true })
  await cp(join(source, 'package.json'), join(target, 'package.json'))
  for (const entry of include) {
    await access(join(source, entry)).then(
      () => cp(join(source, entry), join(target, entry), { recursive: true }),
      () => undefined,
    )
  }
}

async function flattenStore(output) {
  const store = join(output, 'node_modules/.pnpm')
  const rootModules = join(output, 'node_modules')
  for (const snapshot of await readdir(store, { withFileTypes: true })) {
    if (!snapshot.isDirectory()) continue
    const snapshotModules = join(store, snapshot.name, 'node_modules')
    const packages = await readdir(snapshotModules, { withFileTypes: true }).catch(() => [])
    for (const entry of packages) {
      if (entry.name === '.bin') continue
      if (entry.name.startsWith('@')) {
        const scope = join(snapshotModules, entry.name)
        const targetScope = join(rootModules, entry.name)
        await mkdir(targetScope, { recursive: true })
        for (const scopedPackage of await readdir(scope, { withFileTypes: true }).catch(() => [])) {
          if (!scopedPackage.isDirectory()) continue
          const target = join(targetScope, scopedPackage.name)
          await access(target).then(
            () => undefined,
            () => cp(join(scope, scopedPackage.name), target, { recursive: true, dereference: true }),
          )
        }
        continue
      }
      const target = join(rootModules, entry.name)
      await access(target).then(
        () => undefined,
        () => cp(join(snapshotModules, entry.name), target, { recursive: true, dereference: true }),
      )
    }
  }
  await rm(store, { recursive: true, force: true })
}

/**
 * Keeps only what Node loads at run time from installed dependencies: source maps,
 * declarations and TypeScript sources that a package's entry points never name are
 * removed. A smaller artifact installs and hashes in a bounded time.
 */
async function pruneRuntime(modules) {
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const manifest = entries.some((entry) => entry.name === 'package.json' && entry.isFile())
      ? JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      : null
    const entryPoints = manifest ? JSON.stringify([manifest.main, manifest.module, manifest.exports]) : ''
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (manifest && entry.name === 'src' && !entryPoints.includes('src/')) await rm(path, { recursive: true })
        else await visit(path)
      } else if (/\.(?:map|d\.ts|d\.mts|d\.cts)$/.test(entry.name)) await rm(path)
    }
  }
  await visit(modules)
}

/**
 * Deploys `packageName` (at `packageDirectory`, with the built `include` entries) into
 * `output`. `manifest` names the `ade-plugin.json` to place at the artifact root when
 * the package does not ship one there itself.
 */
export async function packageProviderPlugin({ packageName, packageDirectory, include, output, manifest }) {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'ade-provider-plugin-'))
  const deployed = join(scratch, 'portable')
  const deployWorkspace = join(scratch, 'workspace')
  try {
    await mkdir(deployWorkspace, { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
      await cp(join(workspaceRoot, name), join(deployWorkspace, name))
    const packages = { ...WORKSPACE_PACKAGES, [packageName]: { directory: packageDirectory, include } }
    for (const { directory, include: files } of Object.values(packages))
      await copyPackage(join(workspaceRoot, directory), join(deployWorkspace, directory), files)
    const deploy = spawnSync(
      'pnpm',
      [
        '--offline',
        '--frozen-lockfile',
        '--config.inject-workspace-packages=true',
        `--filter=${packageName}`,
        'deploy',
        '--prod',
        deployed,
      ],
      { cwd: deployWorkspace, stdio: 'inherit' },
    )
    if (deploy.error) throw deploy.error
    if (deploy.status !== 0) throw new Error(`Could not assemble the isolated runtime for ${packageName}`)
    await rm(output, { recursive: true, force: true })
    await cp(deployed, output, { recursive: true, dereference: true })
    await flattenStore(output)
    await pruneRuntime(join(output, 'node_modules'))
    if (manifest) await writeFile(join(output, 'ade-plugin.json'), await readFile(join(output, manifest)))
    const sdk = packageName === '@ade/provider-sdk' ? 'dist/node.js' : 'node_modules/@ade/provider-sdk/dist/node.js'
    await Promise.all([
      access(join(output, 'ade-plugin.json')),
      access(join(output, 'node_modules/effect/package.json')),
      access(join(output, sdk)),
    ])
    return output
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
