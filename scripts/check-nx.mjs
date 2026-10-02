import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A cache hit must never stand in for a fresh acceptance or native test report. */
export function checkNxGraph(graph, cargo) {
  const nodes = graph.nodes
  const requires = (source, target) => {
    assert(nodes[source] && nodes[target], `Missing Nx project: ${source} or ${target}`)
    assert(
      graph.dependencies[source]?.some((edge) => edge.target === target),
      `Missing Nx edge: ${source} -> ${target}`,
    )
  }
  for (const pkg of cargo.packages) {
    assert(nodes[pkg.name], `Cargo crate is absent from Nx: ${pkg.name}`)
    for (const dependency of pkg.dependencies.filter((item) => item.path)) requires(pkg.name, dependency.name)
  }
  // Contract generation crosses the Rust/TypeScript boundary; package manifests cannot infer it.
  requires('@ade/contracts', 'ade-core')
  requires('@ade/client', '@ade/contracts')
  requires('@ade/cli', '@ade/client')
  for (const dependency of ['@ade/client', '@ade/contracts', '@ade/terminal']) requires('@ade/desktop', dependency)
  for (const project of ['ade-protocol-tests', 'ade-desktop-tests']) {
    for (const dependency of [
      'ade-daemon',
      'ade-runtime',
      '@ade/cli',
      'ade-claude-adapter',
      '@ade/opencode-provider',
      'ade-omp-bridge',
    ])
      requires(project, dependency)
  }
  requires('ade-desktop-tests', '@ade/desktop')
  for (const project of ['ade-protocol-tests', 'ade-desktop-tests']) {
    const target = nodes[project].data.targets.test
    assert(target.dependsOn?.includes('^build'), `Missing E2E build prerequisites: ${project}`)
    assert(
      target.dependsOn.some(
        (dependency) => dependency.target === 'backend-build' && dependency.projects?.includes('lux-ade-workspace'),
      ),
      `Missing E2E backend prerequisite: ${project}`,
    )
    assert.equal(
      target.options.command,
      project === 'ade-protocol-tests' ? 'pnpm test:e2e:protocol:only' : 'pnpm test:e2e:desktop:only',
      `E2E command rebuilds prerequisites: ${project}`,
    )
  }
  for (const target of [
    'format-check',
    'contract-check',
    'architecture-check',
    'api-parity',
    'lint-check',
    'deadcode-check',
    'e2e-typecheck',
    'discovery',
  ]) {
    assert.equal(
      nodes['lux-ade-workspace'].data.targets[target]?.cache,
      false,
      `Repository check must produce fresh evidence: ${target}`,
    )
  }
  const outputs = {
    '@ade/contracts': '{projectRoot}/dist',
    '@ade/client': '{projectRoot}/dist',
    '@ade/cli': '{projectRoot}/dist',
    '@ade/desktop': '{projectRoot}/out',
  }
  for (const [name, node] of Object.entries(nodes)) {
    for (const [target, config] of Object.entries(node.data.targets ?? {})) {
      if (config.cache === true) {
        assert(['build', 'typecheck'].includes(target), `Evidence-producing target is cacheable: ${name}:${target}`)
        assert(config.inputs?.length, `Cacheable target has no inputs: ${name}:${target}`)
      }
      if (target === 'build' && outputs[name]) {
        assert(config.outputs?.includes(outputs[name]), `Missing build output: ${name}`)
      }
      if (
        /^(test($|:)|static-checks$|acceptance$|affected$|providers$|candidate$|performance$|live$|system$|devices$|native-checks$)/.test(
          target,
        )
      )
        assert.equal(config.cache, false, `Evidence target must explicitly disable caching: ${name}:${target}`)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'ade-nx-graph-'))
  try {
    const output = join(directory, 'graph.json')
    execFileSync('pnpm', ['exec', 'nx', 'graph', `--file=${output}`], { cwd: root, timeout: 60_000, stdio: 'pipe' })
    const cargo = JSON.parse(
      execFileSync('node', ['scripts/cargo.mjs', 'metadata', '--no-deps', '--format-version', '1'], {
        cwd: root,
        timeout: 30_000,
        encoding: 'utf8',
      }),
    )
    const graph = JSON.parse(readFileSync(output, 'utf8')).graph
    checkNxGraph(graph, cargo)
    console.log(
      `Nx graph verified: ${Object.keys(graph.nodes).length} projects; Cargo and acceptance edges; uncached evidence.`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
