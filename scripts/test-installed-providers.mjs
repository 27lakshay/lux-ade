import { accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executable } from './test-prerequisites.mjs'
import { createRun, runStages, writeJson } from './run-stages.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const providers = ['codex', 'claude', 'opencode', 'omp']

export function installedSelection(args) {
  let selected = providers
  let list = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--list') list = true
    else if (args[index] === '--provider' && providers.includes(args[index + 1])) selected = [args[++index]]
    else throw new Error('Use --list or --provider codex|claude|opencode|omp')
  }
  return { selected, list }
}

export function installedPrerequisites(selected, env, directory = root) {
  const missing = []
  const binaries = {}
  const requireBinary = (name, command) => {
    const found = executable(command, env)
    if (found) binaries[name] = found
    else missing.push(name)
  }
  if (selected.includes('codex')) {
    requireBinary('python3', 'python3')
    requireBinary('codex', env.ADE_CODEX_BIN ?? 'codex')
    requireBinary('ade-daemon', resolve(directory, 'target/debug/ade-daemon'))
    requireBinary('ade-runtime', resolve(directory, 'target/debug/ade-runtime'))
  }
  if (selected.includes('claude')) {
    requireBinary('node', 'node')
    requireBinary('claude', env.ADE_CLAUDE_BIN ?? 'claude')
  }
  if (selected.includes('opencode')) {
    requireBinary('opencode', env.ADE_OPENCODE_LOOPBACK_BIN ?? 'opencode')
    requireBinary('ade-daemon', resolve(directory, 'target/debug/ade-daemon'))
    requireBinary('ade-runtime', resolve(directory, 'target/debug/ade-runtime'))
    try {
      accessSync(resolve(directory, 'plugins/opencode/artifact/ade-plugin.json'), constants.R_OK)
    } catch {
      missing.push('packaged OpenCode plugin (pnpm build:sdk)')
    }
  }
  if (selected.includes('omp')) {
    requireBinary('bun', env.ADE_BUN_BIN ?? 'bun')
    requireBinary('omp', env.ADE_OMP_BIN ?? resolve(directory, 'providers/omp/node_modules/.bin/omp'))
  }
  for (const name of selected.filter((name) => name === 'claude' || name === 'omp')) {
    const dependency = name === 'claude' ? '@anthropic-ai/claude-agent-sdk' : '@oh-my-pi/pi-coding-agent'
    try {
      accessSync(resolve(directory, 'providers', name, 'node_modules', dependency, 'package.json'), constants.R_OK)
    } catch {
      missing.push(`${name} workspace dependencies (pnpm install)`)
    }
  }
  return { missing, binaries }
}

function stages(selected, binaries, directory) {
  const result = selected.map((name) => {
    if (name === 'codex') return [name, [binaries.python3, 'scripts/test_codex_loopback.py', '--run']]
    // The packaged plugin runs installed OpenCode through the real daemon and runtime.
    if (name === 'opencode')
      return [
        name,
        ['pnpm', 'test:e2e:protocol:only', 'e2e/protocol/adapters/opencode-native.spec.ts', '--grep', 'installed'],
      ]
    const report = resolve(directory, `${name}.xml`)
    const command =
      name === 'omp'
        ? [binaries.bun, 'test', './worker-peer.test.mjs', '--reporter=junit', '--reporter-outfile', report]
        : [
            process.execPath,
            '--test',
            '--test-reporter=spec',
            '--test-reporter=junit',
            '--test-reporter-destination=stdout',
            `--test-reporter-destination=${report}`,
            './loopback.test.mjs',
          ]
    return [name, command, { cwd: resolve(root, 'providers', name), reports: [report] }]
  })
  if (selected.includes('codex') && selected.includes('claude'))
    result.push(['handoff', [binaries.python3, 'scripts/test_agent_handoff_loopback.py', '--run']])
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { selected, list } = installedSelection(process.argv.slice(2))
    if (list) {
      const descriptions = selected.map((name) => `${name}: installed CLI session checks and isolated loopback HTTP`)
      if (selected.includes('codex') && selected.includes('claude'))
        descriptions.push('handoff: active Codex and Claude turns across daemon restart with isolated loopback HTTP')
      console.log(descriptions.join('\n'))
    } else {
      const directory = createRun(root, 'providers-installed')
      const prerequisites = installedPrerequisites(selected, process.env)
      writeJson(resolve(directory, 'prerequisites.json'), {
        selected,
        ...prerequisites,
        status: prerequisites.missing.length ? 'unavailable' : 'ready',
      })
      if (prerequisites.missing.length) {
        writeJson(resolve(directory, 'summary.json'), {
          status: 'failed',
          failureCategory: 'prerequisite-unavailable',
          unexecutedProviders: selected,
          missing: prerequisites.missing,
        })
        console.error(
          `Installed-provider prerequisites unavailable: ${prerequisites.missing.join(', ')}\nTest report: ${directory}`,
        )
        process.exitCode = 1
      } else {
        const { binaries } = prerequisites
        process.exitCode = await runStages(stages(selected, binaries, directory), {
          root,
          directory,
          env: {
            ...process.env,
            ADE_CODEX_BIN: binaries.codex,
            ADE_CLAUDE_BIN: binaries.claude,
            ADE_CLAUDE_LOOPBACK_BIN: binaries.claude,
            ADE_OPENCODE_LOOPBACK_BIN: binaries.opencode,
            ADE_OMP_BIN: binaries.omp,
            ADE_OMP_LOOPBACK: '1',
          },
        })
      }
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
