// The fault conformance suite (F140): every protocol E2E test that injects a
// fault, across all areas. `pnpm test:e2e:protocol:faults` runs the tests
// whose file path or title names one of these faults, or carries the
// `@fault` tag. Name the fault in a new test's title, or add `@fault`, and
// the suite picks it up; no list of files to keep in step.
export const faultVocabulary = [
  // Process faults: crashes, kills, restarts, hangs.
  'crash', 'kill', 'restart', 'dies', 'died', 'dead', 'frozen', 'hang', 'exits during',
  // Lost and uncertain outcomes.
  'lost', 'unknown', 'interrupt', 'reconcil', 'quarantin', 'orphan', 'recover', 'survive',
  // Duplicate and conflicting requests.
  'duplicate', 'conflict', 'replay', 'retry', 'retried', 'twice', 'same operation ID', 'same request ID', 'in flight',
  // Races, theft and revocation of a resource.
  'race', 'racing', 'foreign', 'taken', 'revok', 'withdr', 'evict', 'stale',
  // Broken inputs and targets.
  'corrupt', 'disconnect', 'offline', 'fault', 'fail',
]

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches a test's full title (file path, describes and title) when it belongs to the fault suite. */
export const faultSuite = new RegExp(['@fault', ...faultVocabulary.map(escape)].join('|'), 'i')
