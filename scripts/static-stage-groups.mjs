// Each maintained stage belongs to exactly one CI job. The local gate selects all.
export const staticStageGroups = {
  rustfmt: 'native',
  'static analysis': 'javascript',
  'nx graph': 'javascript',
  'test_native_report.py': 'javascript',
  'test_live_profile.py': 'javascript',
  'test_runtime_test_support.py': 'javascript',
  'test_tools_installer.py': 'javascript',
  'test_ci_build_artifact.py': 'javascript',
  'test_bootstrap.py': 'javascript',
  'test_build_identity.py': 'javascript',
  'test_first_launch.py': 'javascript',
  'test_native_accessibility.py': 'native',
  'sdk build': 'javascript',
  typecheck: 'javascript',
  'cli build': 'javascript',
  'desktop build': 'javascript',
  'js pure tests': 'javascript',
  'provider tests': 'javascript',
  'renderer tests': 'javascript',
  clippy: 'native',
  'test discovery': 'native',
  'legacy rust tests': 'native',
  'rust doctests': 'native',
}

export function expectedStaticStages(group = 'all') {
  if (!['all', 'javascript', 'native'].includes(group)) throw new Error(`Unknown static group: ${group}`)
  return Object.keys(staticStageGroups).filter((name) => group === 'all' || staticStageGroups[name] === group)
}

export function selectStaticStages(stages, group = 'all') {
  const expected = expectedStaticStages(group)
  const names = stages.map(([name]) => name)
  if (new Set(names).size !== names.length) throw new Error('Duplicate static stage')
  for (const name of names) {
    if (!Object.hasOwn(staticStageGroups, name)) throw new Error(`Unassigned static stage: ${name}`)
  }
  for (const name of Object.keys(staticStageGroups)) {
    if (!names.includes(name)) throw new Error(`Missing static stage: ${name}`)
  }
  return stages.filter(([name]) => expected.includes(name))
}
