import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRun, runStages } from './run-stages.mjs'

export const analysisCommands = {
  'format-check': ['pnpm', 'format:check'],
  'contract-check': ['pnpm', 'contract:check'],
  'architecture-check': ['python3', 'scripts/check_architecture.py'],
  'api-parity': ['node', 'scripts/api-parity.mjs'],
  'lint-check': ['pnpm', 'lint'],
  'deadcode-check': ['pnpm', 'deadcode'],
}

/** Nx success alone cannot substitute for all of the repository's required checks. */
export function analysisEvidence(directory) {
  return Object.keys(analysisCommands).map((name) => {
    const file = resolve(directory, 'analysis', name, 'summary.json')
    const report = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(report.status, 'passed', `Analysis did not pass: ${name}`)
    assert.equal(report.stages?.length, 1, `Missing analysis stage: ${name}`)
    assert.equal(report.stages[0].status, 'passed', `Incomplete analysis stage: ${name}`)
    assert.deepEqual(report.stages[0].command, analysisCommands[name], `Unexpected analysis command: ${name}`)
    return { name, summary: file }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  assert(process.argv.length === 3 && Object.hasOwn(analysisCommands, name), 'Expected one analysis target')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = process.env.ADE_STATIC_REPORT_DIR
    ? resolve(process.env.ADE_STATIC_REPORT_DIR, 'analysis', name)
    : createRun(root, name)
  process.exitCode = await runStages([[name, analysisCommands[name]]], { root, env: process.env, directory })
}
