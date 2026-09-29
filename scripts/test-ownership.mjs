// Compare discovered ownership with the independent repository file inventory.
// Callers use native runners to discover files; this module does not parse test bodies.
export function validateOwnership({ files, suites, exclusions = [], overlaps = [] }) {
  const inventory = new Set(files)
  const failures = []
  const owners = new Map(files.map((file) => [file, new Set()]))
  const names = new Set()
  for (const suite of suites) {
    if (names.has(suite.name)) failures.push(`Duplicate suite: ${suite.name}`)
    names.add(suite.name)
    if (suite.required !== false && suite.files.length === 0) failures.push(`Empty required suite: ${suite.name}`)
    for (const file of new Set(suite.files)) {
      if (!inventory.has(file)) failures.push(`${suite.name}: discovered missing test file ${file}`)
      else owners.get(file).add(suite.name)
    }
  }
  const ignored = new Set()
  for (const exclusion of exclusions) {
    if (!exclusion.reason?.trim()) failures.push(`Exclusion needs a reason: ${exclusion.file}`)
    if (!inventory.has(exclusion.file)) failures.push(`Stale exclusion: ${exclusion.file}`)
    if (ignored.has(exclusion.file)) failures.push(`Duplicate exclusion: ${exclusion.file}`)
    ignored.add(exclusion.file)
  }
  for (const overlap of overlaps) {
    if (!overlap.reason?.trim()) failures.push(`Overlap needs a reason: ${overlap.suites.join(', ')}`)
    if (overlap.suites.length !== 2 || overlap.suites[0] === overlap.suites[1])
      failures.push('Overlap must name two distinct suites')
    for (const name of overlap.suites) if (!names.has(name)) failures.push(`Overlap names missing suite: ${name}`)
    const matching = [...owners.values()].some((assigned) => overlap.suites.every((name) => assigned.has(name)))
    if (!matching) failures.push(`Stale overlap: ${overlap.suites.join(', ')}`)
  }
  for (const [file, assigned] of owners) {
    if (ignored.has(file)) {
      if (assigned.size) failures.push(`Excluded file is also owned: ${file}`)
      continue
    }
    if (!assigned.size) failures.push(`Unassigned test file: ${file}`)
    const list = [...assigned]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!overlaps.some((entry) => entry.suites.includes(list[i]) && entry.suites.includes(list[j]))) {
          failures.push(`Conflicting ownership: ${file} (${list[i]}, ${list[j]})`)
        }
      }
    }
  }
  return failures
}
