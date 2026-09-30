import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNxGraph } from './check-nx.mjs'

let graph
let cargo
let directory
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'ade-nx-policy-'))
  const file = join(directory, 'graph.json')
  execFileSync('pnpm', ['exec', 'nx', 'graph', `--file=${file}`], { timeout: 60_000, stdio: 'pipe' })
  graph = JSON.parse(readFileSync(file, 'utf8')).graph
  cargo = JSON.parse(
    execFileSync('node', ['scripts/cargo.mjs', 'metadata', '--no-deps', '--format-version', '1'], {
      timeout: 30_000,
      encoding: 'utf8',
    }),
  )
})
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

test('the real Nx graph preserves Cargo and acceptance relationships', () => {
  checkNxGraph(graph, cargo)
})

test('cached acceptance cannot masquerade as fresh native evidence', () => {
  const changed = structuredClone(graph)
  changed.nodes['lux-ade-workspace'].data.targets.acceptance.cache = true
  assert.throws(() => checkNxGraph(changed, cargo), /Evidence-producing target is cacheable/)
})

test('a missing Rust dependency cannot silently narrow affected selection', () => {
  const changed = structuredClone(graph)
  changed.dependencies['ade-runtime'] = changed.dependencies['ade-runtime'].filter(
    (edge) => edge.target !== 'ade-platform',
  )
  assert.throws(() => checkNxGraph(changed, cargo), /Missing Nx edge: ade-runtime -> ade-platform/)
})

test('a cache hit requires declared restorable build outputs', () => {
  const changed = structuredClone(graph)
  changed.nodes['@ade/desktop'].data.targets.build.outputs = []
  assert.throws(() => checkNxGraph(changed, cargo), /Missing build output: @ade\/desktop/)
})

test('E2E cannot drop its native prerequisite or rebuild inside the test command', () => {
  const changed = structuredClone(graph)
  changed.nodes['ade-protocol-tests'].data.targets.test.dependsOn = ['^build']
  assert.throws(() => checkNxGraph(changed, cargo), /Missing E2E backend prerequisite/)
  const redundant = structuredClone(graph)
  redundant.nodes['ade-desktop-tests'].data.targets.test.options.command = 'pnpm test:e2e:desktop'
  assert.throws(() => checkNxGraph(redundant, cargo), /E2E command rebuilds prerequisites/)
})

test('independent static checks cannot reuse stale acceptance evidence', () => {
  const changed = structuredClone(graph)
  changed.nodes['lux-ade-workspace'].data.targets['lint-check'].cache = true
  assert.throws(() => checkNxGraph(changed, cargo), /Repository check must produce fresh evidence/)
})
