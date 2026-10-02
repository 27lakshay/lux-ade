import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const output = join(packageRoot, 'dist/diagnostic-plugin')
const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'ade-provider-sdk-'))
const deployed = join(scratch, 'portable')
const deployWorkspace = join(scratch, 'workspace')
async function prepareDeployWorkspace() {
  await mkdir(deployWorkspace, { recursive: true })
  await Promise.all([
    cp(join(workspaceRoot, 'package.json'), join(deployWorkspace, 'package.json')),
    cp(join(workspaceRoot, 'pnpm-lock.yaml'), join(deployWorkspace, 'pnpm-lock.yaml')),
    cp(join(workspaceRoot, 'pnpm-workspace.yaml'), join(deployWorkspace, 'pnpm-workspace.yaml')),
  ])
  const sdk = join(deployWorkspace, 'packages/provider-sdk')
  const contracts = join(deployWorkspace, 'packages/contracts')
  await Promise.all([mkdir(sdk, { recursive: true }), mkdir(contracts, { recursive: true })])
  await Promise.all([
    cp(join(packageRoot, 'package.json'), join(sdk, 'package.json')),
    cp(join(packageRoot, 'examples'), join(sdk, 'examples'), { recursive: true }),
    cp(join(join(workspaceRoot, 'packages/contracts'), 'package.json'), join(contracts, 'package.json')),
    cp(join(workspaceRoot, 'packages/contracts/dist'), join(contracts, 'dist'), { recursive: true }),
  ])
  const sdkDist = join(sdk, 'dist')
  await mkdir(sdkDist, { recursive: true })
  for (const entry of await readdir(join(packageRoot, 'dist'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      await cp(join(packageRoot, 'dist', entry.name), join(sdkDist, entry.name))
    }
  }
}

async function installTransitivePackages(output) {
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
try {
  await prepareDeployWorkspace()
  const deploy = spawnSync(
    'pnpm',
    [
      '--offline',
      '--frozen-lockfile',
      '--config.inject-workspace-packages=true',
      '--filter=@ade/provider-sdk',
      'deploy',
      '--prod',
      deployed,
    ],
    { cwd: deployWorkspace, stdio: 'inherit' },
  )
  if (deploy.error) throw deploy.error
  if (deploy.status !== 0) throw new Error('Could not assemble the isolated provider SDK runtime')
  await rm(output, { recursive: true, force: true })
  await cp(deployed, output, { recursive: true, dereference: true })
  await installTransitivePackages(output)
  await writeFile(join(output, 'ade-plugin.json'), await readFile(join(output, 'examples/ade-plugin.json')))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
