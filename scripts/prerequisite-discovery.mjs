import { spawnSync } from 'node:child_process'

export function discoveryArguments(argv) {
  if (argv[0] !== 'test') throw new Error('Prerequisite inventory requires the Playwright test CLI')
  if (argv.some((arg) => arg === '--last-failed' || arg.startsWith('--ui')))
    throw new Error('Stateful test selection cannot be reconstructed after prerequisite failure')
  const args = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--reporter') index++
    else if (!arg.startsWith('--reporter=') && arg !== '--list') args.push(arg)
  }
  return [...args, '--list', '--reporter=json']
}

export function discoverPrerequisiteInventory(argv, source = process.env) {
  const env = { ...source }
  for (const name of ['PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR', 'PLAYWRIGHT_JSON_OUTPUT_NAME'])
    delete env[name]
  const result = spawnSync(process.execPath, [argv[1], ...discoveryArguments(argv.slice(2))], {
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error('Native prerequisite inventory discovery failed; see the original setup error')
  const report = JSON.parse(result.stdout)
  if (!Array.isArray(report.suites) || report.errors?.length)
    throw new Error('Native prerequisite inventory is incomplete')
  return report
}
