import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { analysisCommands, analysisEvidence } from './check-analysis.mjs'

test('parallel analysis requires every expected command and rejects incomplete evidence', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-analysis-'))
  const write = (name, stage) => {
    const folder = resolve(directory, 'analysis', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(resolve(folder, 'summary.json'), JSON.stringify({ status: 'passed', stages: [stage] }))
  }
  try {
    assert.throws(() => analysisEvidence(directory))
    for (const [name, command] of Object.entries(analysisCommands)) write(name, { status: 'passed', command })
    assert.equal(analysisEvidence(directory).length, 6)
    write('lint-check', { status: 'pending', command: analysisCommands['lint-check'] })
    assert.throws(() => analysisEvidence(directory), /Incomplete/)
    write('lint-check', { status: 'passed', command: ['true'] })
    assert.throws(() => analysisEvidence(directory), /Unexpected/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
