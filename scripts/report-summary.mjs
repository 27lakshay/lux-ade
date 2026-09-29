// Adapt native Playwright JSON without treating absent execution evidence as a pass.
export function summarizePlaywright(report, run) {
  const errors = (report?.errors ?? []).map((error) => error.message ?? String(error))
  const tests = []
  if (!report || !Array.isArray(report.suites)) errors.push('Missing native report or suite records')
  function visit(suite, ancestors = []) {
    const titles = [...ancestors, suite.title ?? '']
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) {
        const id = `${entry.projectId ?? entry.projectName ?? ''}:${spec.file}:${spec.line}:${spec.column}:${spec.title}`
        const results = entry.results ?? []
        const last = results.at(-1)
        const annotations = entry.annotations ?? []
        const skipped = last?.status === 'skipped' || (entry.expectedStatus === 'skipped' && results.length === 0)
        const status = skipped
          ? 'skipped'
          : !last
            ? 'unexecuted'
            : last.status === entry.expectedStatus && results.length === 1
              ? 'passed'
              : 'failed'
        tests.push({
          id,
          status,
          requirementIds: [...new Set(`${titles.join(' ')} ${spec.title}`.match(/\b[FR]\d{3}\b/g) ?? [])],
          durationMs: last?.duration ?? null,
          attempts: results.length,
          skipCategory: skipped
            ? annotations.some((a) => a.type === 'fixme')
              ? 'known-gap'
              : 'capability-or-explicit-skip'
            : null,
          skipReason: skipped
            ? annotations
                .filter((a) => a.type === 'skip' || a.type === 'fixme')
                .map((a) => a.description ?? a.type)
                .join('; ') || 'Runner did not provide a reason'
            : null,
          attachments: last?.attachments ?? [],
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles)
  }
  for (const suite of report?.suites ?? []) visit(suite)
  const seen = new Set()
  for (const entry of tests) {
    if (seen.has(entry.id)) errors.push(`Duplicate test record: ${entry.id}`)
    seen.add(entry.id)
  }
  const counts = { passed: 0, failed: 0, skipped: 0, unexecuted: 0 }
  for (const entry of tests) counts[entry.status]++
  if (!tests.length) errors.push('No test execution records')
  else if (!counts.passed) errors.push('No test cases passed')
  const status =
    run.status === 'interrupted'
      ? 'interrupted'
      : run.prerequisites?.status === 'unavailable' ||
          run.status !== 'passed' ||
          errors.length ||
          counts.failed ||
          counts.unexecuted
        ? 'failed'
        : 'passed'
  return {
    version: 1,
    ...run,
    status,
    failureCategory:
      status === 'failed' && run.prerequisites?.status === 'unavailable' ? 'prerequisite-unavailable' : null,
    counts,
    wallMs: run.wallMs ?? null,
    summedTestMs: tests.some((t) => t.durationMs === null) ? null : tests.reduce((total, t) => total + t.durationMs, 0),
    errors,
    tests,
  }
}

export function mergeSummaries(reports, expectedShards) {
  const errors = []
  const shards = new Set()
  const tests = new Set()
  for (const report of reports) {
    if (!report) {
      errors.push('Missing summary')
      continue
    }
    if (shards.has(report.shard)) errors.push(`Duplicate shard: ${report.shard}`)
    shards.add(report.shard)
    if (!expectedShards.includes(report.shard)) errors.push(`Unexpected shard: ${report.shard}`)
    if (report.status !== 'passed') errors.push(`Shard ${report.shard}: ${report.status}`)
    for (const entry of report.tests ?? []) {
      if (tests.has(entry.id)) errors.push(`Duplicate test across shards: ${entry.id}`)
      tests.add(entry.id)
    }
  }
  for (const shard of expectedShards) if (!shards.has(shard)) errors.push(`Missing shard: ${shard}`)
  if (!expectedShards.length) errors.push('No expected shards supplied')
  return { status: errors.length ? 'failed' : 'passed', errors, testCount: tests.size }
}
