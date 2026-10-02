#!/usr/bin/env node
// `ade-provider-conformance`: run the provider conformance checks against a worker without ADE.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { formatReport, runConformance } from './testing.js'
import type { ConformanceFixture, ConformanceFixtureSetup, ConformanceTarget } from './testing.js'

const USAGE = `Usage: ade-provider-conformance [options] -- <worker command> [args...]
       ade-provider-conformance [options] --factory <module>[#export]

Starts the worker, speaks the provider worker protocol to it and reports each check as
PASS, FAIL or SKIP (not exercised). Results are fixture evidence, never native or live evidence.

Options:
  --fixture <module>   A module whose default export is a fixture, or an async setup function
                       returning one with optional env and cleanup (see docs/provider-authoring.md)
  --reply <text>       A prompt the fixture peer completes on its own (required without --fixture)
  --hold <text>        A prompt the peer keeps running until interrupted (enables cancel checks)
  --request <text>     A prompt that makes the peer ask a question or approval (enables answer checks)
  --env KEY=VALUE      Add to the worker's environment (repeatable)
  --cwd <dir>          The worker's working directory (default: the current directory)
  --timeout <ms>       Reply and turn timeout (default 15000)
  --json               Print the report as JSON
Exit status: 0 when no check fails, 1 when a check fails, 2 for a usage error.`

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fixture: { type: 'string' },
      factory: { type: 'string' },
      reply: { type: 'string' },
      hold: { type: 'string' },
      request: { type: 'string' },
      env: { type: 'string', multiple: true },
      cwd: { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const cwd = resolve(values.cwd ?? process.cwd())
  const env: Record<string, string> = {}
  for (const pair of values.env ?? []) {
    const equals = pair.indexOf('=')
    if (equals <= 0) throw new UsageError(`--env expects KEY=VALUE, got ${pair}`)
    env[pair.slice(0, equals)] = pair.slice(equals + 1)
  }
  let fixture: ConformanceFixture | undefined
  let cleanup: (() => Promise<void>) | undefined
  if (values.fixture) {
    const loaded = (await import(pathToFileURL(resolve(cwd, values.fixture)).href)) as { default?: unknown }
    const exported = loaded.default
    const staged =
      typeof exported === 'function'
        ? await (exported as ConformanceFixtureSetup)({ cwd })
        : (exported as ConformanceFixture | undefined)
    if (!staged?.prompts?.reply) throw new UsageError(`${values.fixture} supplies no prompts.reply`)
    const { env: fixtureEnv, cleanup: fixtureCleanup, ...rest } = staged as Awaited<ReturnType<ConformanceFixtureSetup>>
    // --env overrides what the fixture staged.
    const given = { ...env }
    Object.assign(env, fixtureEnv, given)
    cleanup = fixtureCleanup
    fixture = rest
  }
  const prompts = {
    reply: values.reply ?? fixture?.prompts.reply,
    hold: values.hold ?? fixture?.prompts.hold,
    request: values.request ?? fixture?.prompts.request,
  }
  if (!prompts.reply) throw new UsageError('Give --reply or a --fixture with prompts.reply')
  let target: ConformanceTarget
  if (values.factory) {
    if (positionals.length) throw new UsageError('Give a worker command or --factory, not both')
    const [factoryModule, exportName] = values.factory.split('#')
    target = { factoryModule: factoryModule!, exportName, env, cwd }
  } else {
    const [command, ...args] = positionals
    if (!command) throw new UsageError('Give the worker command after --')
    target = { command, args, env, cwd }
  }
  const timeoutMs = values.timeout === undefined ? fixture?.timeoutMs : Number(values.timeout)
  if (timeoutMs !== undefined && !(timeoutMs > 0)) throw new UsageError('--timeout expects a positive number')
  try {
    const report = await runConformance({
      target,
      fixture: { ...fixture, prompts: { ...prompts, reply: prompts.reply }, timeoutMs },
    })
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report))
    return report.passed ? 0 : 1
  } finally {
    await cleanup?.()
  }
}

class UsageError extends Error {}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    if (error instanceof UsageError) console.error(USAGE)
    process.exitCode = 2
  },
)
