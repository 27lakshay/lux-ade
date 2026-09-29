import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { runCommand } from './test-process.mjs'

export function writeJson(file, value) {
  mkdirSync(resolve(file, '..'), { recursive: true })
  const temporary = `${file}.next`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n')
  renameSync(temporary, file)
}

export function createRun(root, suite) {
  const directory = resolve(root, 'test-results/runs', `${suite}-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

export async function runStages(steps, { root, env, directory, signals = process }) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const dirty = git(['status', '--porcelain'])
  const version = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 5000 })
    return result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : null
  }
  const packageVersion = (file) => {
    try {
      return JSON.parse(readFileSync(resolve(root, file), 'utf8')).version
    } catch {
      return null
    }
  }
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    revision: git(['rev-parse', 'HEAD']),
    dirty: dirty === null ? null : dirty !== '',
    machine: { os: platform(), arch: arch(), release: release() },
    tools: {
      node: process.version,
      pnpm: version('pnpm', ['--version']),
      vitest: packageVersion('apps/desktop/node_modules/vitest/package.json'),
      python: version('python3', ['--version']),
      bun: version('bun', ['--version']),
      rust: version('rustc', ['--version']),
      nextest: version('cargo-nextest', ['--version']),
    },
    cacheCondition: env.ADE_TEST_CACHE_CONDITION ?? 'unspecified',
    command: process.argv.slice(1),
    stages: steps.map(([name, command, options]) => ({
      name,
      command,
      status: 'pending',
      durationMs: null,
      workers: options?.workers ?? null,
      reports: options?.reports ?? [],
    })),
  }
  const destination = resolve(directory, 'summary.json')
  const started = performance.now()
  const persist = () => writeJson(destination, { ...report, wallMs: performance.now() - started })
  persist()
  console.log(`Test report: ${directory}`)
  for (const [index, [name, [command, ...args], options]] of steps.entries()) {
    const stage = report.stages[index]
    stage.status = 'running'
    persist()
    const began = performance.now()
    let code
    try {
      stage.log = `${index + 1}.log`
      code = await runCommand(
        { command, args, cwd: options?.cwd ?? root, logFile: resolve(directory, stage.log) },
        { ...env, ...options?.env },
        signals,
      )
      stage.evidence = await options?.after?.()
      stage.native = []
      for (const file of stage.reports) {
        const result = spawnSync('python3', ['scripts/native_report.py', file], { cwd: root, encoding: 'utf8' })
        const native = JSON.parse(result.stdout)
        stage.native.push(native)
        if (result.status !== 0) code ||= 1
      }
    } catch (error) {
      stage.error = String(error)
      code ||= 1
    }
    stage.durationMs = performance.now() - began
    stage.exitCode = code
    stage.status = code === 0 ? 'passed' : code === 130 || code === 143 ? 'interrupted' : 'failed'
    persist()
    console.log(`${name} ${stage.status} in ${(stage.durationMs / 1000).toFixed(1)}s`)
    if (code !== 0) {
      report.status = stage.status
      persist()
      return code
    }
  }
  report.status = 'passed'
  persist()
  // Verify persisted state rather than claiming success solely from in-memory intent.
  if (JSON.parse(readFileSync(destination, 'utf8')).stages.some((stage) => stage.status !== 'passed')) return 1
  return 0
}
