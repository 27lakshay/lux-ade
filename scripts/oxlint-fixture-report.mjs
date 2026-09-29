import assert from 'node:assert/strict'
import { resolve } from 'node:path'

/** Attribute native diagnostics to fixture files; malformed or incomplete runs fail the batch. */
export function fixtureDiagnostics(result, directory, files) {
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'Oxlint was interrupted')
  assert.ok(result.status === 0 || result.status === 1, `Oxlint exited ${result.status}: ${result.stderr}`)
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    assert.fail(`Oxlint did not return native JSON: ${result.stdout}\n${result.stderr}`)
  }
  assert.ok(Array.isArray(report.diagnostics), 'Oxlint diagnostics are missing')
  assert.equal(report.number_of_files, files.length, 'Oxlint did not inspect every fixture')
  const diagnostics = new Map(files.map((file) => [resolve(directory, file), []]))
  assert.equal(diagnostics.size, files.length, 'Duplicate fixture paths')
  for (const diagnostic of report.diagnostics) {
    assert.equal(typeof diagnostic.filename, 'string', 'Diagnostic has no fixture filename')
    const target = resolve(directory, diagnostic.filename)
    assert.ok(diagnostics.has(target), `Unexpected diagnostic file: ${diagnostic.filename}`)
    diagnostics.get(target).push(diagnostic)
  }
  assert.equal(result.status, report.diagnostics.length ? 1 : 0, 'Oxlint exit status disagrees with diagnostics')
  return diagnostics
}

/** Existing negative fixtures each expect exactly one error; positive fixtures expect none. */
export function assertFixtureDiagnostics(rule, name, diagnostics, message) {
  const label = `${rule}: ${name}`
  assert.ok(Array.isArray(diagnostics), `${label}: missing fixture result`)
  assert.equal(diagnostics.length, message ? 1 : 0, `${label}: unexpected diagnostics: ${JSON.stringify(diagnostics)}`)
  if (message) {
    assert.equal(diagnostics[0].code, `ade(${rule})`, `${label}: wrong rule`)
    assert.equal(diagnostics[0].severity, 'error', `${label}: wrong severity`)
    assert.match(diagnostics[0].message, message, label)
  }
}
