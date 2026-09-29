import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertFixtureDiagnostics, fixtureDiagnostics } from './oxlint-fixture-report.mjs'

const directory = resolve('fixture-batch')
const files = ['valid/fixture.ts', 'invalid/fixture.ts']
const diagnostic = {
  filename: files[1],
  code: 'ade(require-store-selector)',
  severity: 'error',
  message: 'useStore without a selector',
}
const result = (diagnostics, changes = {}) => ({
  status: diagnostics.length ? 1 : 0,
  signal: null,
  stdout: JSON.stringify({ diagnostics, number_of_files: files.length }),
  stderr: '',
  ...changes,
})

function verify(diagnostics) {
  const mapped = fixtureDiagnostics(result(diagnostics), directory, files)
  assertFixtureDiagnostics('require-store-selector', 'valid', mapped.get(resolve(directory, files[0])), null)
  assertFixtureDiagnostics(
    'require-store-selector',
    'invalid',
    mapped.get(resolve(directory, files[1])),
    /without a selector/,
  )
}

test('native batch diagnostics preserve positive and negative fixture expectations', () => {
  verify([diagnostic])
})

test('a missing or extra diagnostic fails the affected fixture', () => {
  assert.throws(() => verify([]), /invalid: unexpected diagnostics/)
  assert.throws(() => verify([diagnostic, diagnostic]), /invalid: unexpected diagnostics/)
})

test('a diagnostic attributed to a positive fixture fails instead of satisfying another case', () => {
  assert.throws(() => verify([{ ...diagnostic, filename: files[0] }]), /valid: unexpected diagnostics/)
  assert.throws(() => verify([diagnostic, { ...diagnostic, filename: files[0] }]), /valid: unexpected diagnostics/)
  assert.throws(() => verify([{ ...diagnostic, filename: 'other.ts' }]), /Unexpected diagnostic file/)
})

test('an expected count cannot hide the wrong message, rule or severity', () => {
  assert.throws(() => verify([{ ...diagnostic, message: 'unrelated error' }]), /invalid/)
  assert.throws(() => verify([{ ...diagnostic, code: 'parser' }]), /wrong rule/)
  assert.throws(() => verify([{ ...diagnostic, severity: 'warning' }]), /wrong severity/)
})

test('missing reports, missing files and process failures cannot pass a batch', () => {
  const parse = (changes) => fixtureDiagnostics(result([diagnostic], changes), directory, files)
  assert.throws(() => parse({ stdout: '' }), /native JSON/)
  assert.throws(() => parse({ stdout: '{}' }), /diagnostics are missing/)
  assert.throws(
    () => parse({ stdout: JSON.stringify({ diagnostics: [diagnostic], number_of_files: 1 }) }),
    /every fixture/,
  )
  assert.throws(() => parse({ status: 2 }), /exited 2/)
  assert.throws(() => parse({ signal: 'SIGTERM', status: null }), /interrupted/)
  assert.throws(() => parse({ error: new Error('spawn failed') }), /spawn failed/)
  assert.throws(() => parse({ status: 0 }), /exit status disagrees/)
})
