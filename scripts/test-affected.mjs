import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { changedFiles, affectedSelection } from './affected-selection.mjs'
import { acceptanceStages } from './test-acceptance.mjs'
import { createRun, runStages, writeJson } from './run-stages.mjs'

export function affectedOptions(args) {
  const options = { list: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') options.list = true
    else if (args[i] === '--base') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--base needs a Git reference')
      options.base = args[++i]
    } else if (args[i] === '--workers') {
      options.workers = Number(args[++i])
      if (!Number.isInteger(options.workers) || options.workers < 1)
        throw new Error('--workers must be a positive integer')
    } else throw new Error(`Unknown affected-run argument: ${args[i]}`)
  }
  return options
}

export function affectedStages(directory, selection, workers) {
  const suites = new Set(selection.suites.map((item) => item.suite))
  return acceptanceStages(directory, { workers, desktopWorkers: workers }).filter(([name]) =>
    name === 'backend build' ? suites.has('protocol') || suites.has('desktop') : suites.has(name),
  )
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const options = affectedOptions(process.argv.slice(2))
    const selection = affectedSelection(changedFiles(root, options.base))
    console.log(JSON.stringify(selection, null, 2))
    if (!options.list) {
      const directory = createRun(root, 'affected')
      writeJson(resolve(directory, 'selection.json'), selection)
      process.exitCode = await runStages(affectedStages(directory, selection, options.workers), {
        root,
        env: process.env,
        directory,
      })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
