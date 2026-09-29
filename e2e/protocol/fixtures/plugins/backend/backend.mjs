// Protocol E2E fixture backend plugin. It records what it sees as JSON lines
// under the `out_dir` setting, so a spec can observe plugin effects without
// sleeping. Commands and hooks that must pause wait for a release file the
// spec creates.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// The dev-mode reload spec rewrites this line.
const VERSION = 'v1'

let context

function record(file, entry) {
  const directory = context?.settings.out_dir
  if (directory) {
    appendFileSync(
      join(directory, file),
      `${JSON.stringify({ pid: process.pid, generation: context.generation, version: VERSION, ...entry })}\n`,
    )
  }
}

function released(name) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(join(context.settings.out_dir, name))) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
  })
}

export function activate(ctx) {
  context = ctx
  // The `token` credential: its reference from settings, and a digest of the
  // value the daemon resolved for this activation, so no file holds the value.
  const token = ctx.credentials?.token
  record('lifecycle.jsonl', {
    event: 'activate',
    token_reference: ctx.settings.token ?? null,
    token_sha256: typeof token === 'string' ? createHash('sha256').update(token).digest('hex') : null,
  })
  ctx.commands.register('e2e.backend.echo', (args, meta) => {
    console.log(`fixture echo ${VERSION}`)
    return { args, version: VERSION, generation: meta.generation, pid: process.pid }
  })
  ctx.commands.register('e2e.backend.fail', () => {
    throw new Error('fixture command failed')
  })
  ctx.commands.register('e2e.backend.crash', () => {
    record('lifecycle.jsonl', { event: 'crash' })
    process.exit(9)
  })
  ctx.commands.register('e2e.backend.hold', async (args, meta) => {
    record('lifecycle.jsonl', { event: 'hold-started', invocation: meta.invocationId })
    await released(args.release)
    return { version: VERSION, generation: meta.generation, pid: process.pid }
  })
  ctx.hooks.on('workspace.created', async (payload, meta) => {
    if (
      meta.attempt > 1 &&
      context.settings.out_dir &&
      existsSync(join(context.settings.out_dir, 'hold-retry-before-effect'))
    ) {
      record('retry-held.jsonl', { effect_id: meta.effectId, attempt: meta.attempt })
      await released('release-retry')
    }
    record('hooks.jsonl', { effect_id: meta.effectId, event: meta.event, attempt: meta.attempt, root: payload.root })
    const root = String(payload.root)
    if (root.includes('crash-hook')) process.exit(9)
    if (root.includes('fail-hook')) throw new Error('fixture hook failed')
    if (root.includes('hold-hook')) await released('release-hook')
  })
  ctx.hooks.on('turn.settled', (payload, meta) => {
    record('hooks.jsonl', {
      effect_id: meta.effectId,
      event: meta.event,
      attempt: meta.attempt,
      conversation_id: payload.conversation_id,
      outcome: payload.outcome,
    })
  })
}

export function deactivate() {
  record('lifecycle.jsonl', { event: 'deactivate' })
}
