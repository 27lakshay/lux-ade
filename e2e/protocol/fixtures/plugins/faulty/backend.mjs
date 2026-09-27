// Protocol E2E fixture: a backend plugin that fails on request. Switch files
// in the `out_dir` setting's directory choose how its activation fails, so a
// spec can break and heal the plugin without reinstalling it:
//   fail-activate  activate throws
//   exit-activate  the host process exits during activate
//   hang-activate  activate never returns
// It records each activation and hook as JSON lines in `out_dir`.
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let context

function record(file, entry) {
  const directory = context?.settings.out_dir
  if (directory)
    appendFileSync(
      join(directory, file),
      `${JSON.stringify({ pid: process.pid, generation: context.generation, ...entry })}\n`,
    )
}

function switched(name) {
  const directory = context?.settings.out_dir
  return Boolean(directory) && existsSync(join(directory, name))
}

export async function activate(ctx) {
  context = ctx
  if (switched('fail-activate')) {
    record('lifecycle.jsonl', { event: 'activate-failed' })
    throw new Error('fixture activation failed')
  }
  if (switched('exit-activate')) {
    record('lifecycle.jsonl', { event: 'activate-exit' })
    console.error('fixture activation exits the host')
    process.exit(7)
  }
  if (switched('hang-activate')) {
    record('lifecycle.jsonl', { event: 'activate-hang' })
    await new Promise(() => {})
  }
  record('lifecycle.jsonl', { event: 'activate' })
  ctx.commands.register('e2e.faulty.echo', (args, meta) => ({ args, generation: meta.generation, pid: process.pid }))
  // Blocks the host's event loop: the host can no longer answer anything.
  ctx.commands.register('e2e.faulty.freeze', () => {
    record('lifecycle.jsonl', { event: 'freeze' })
    for (;;) {
      /* frozen */
    }
  })
  ctx.commands.register('e2e.faulty.noise', (args) => {
    const lines = Number(args?.lines ?? 0)
    for (let index = 1; index <= lines; index += 1)
      console.log(`noise line ${index} ${'x'.repeat(Number(args?.width ?? 0))}`)
    return { lines }
  })
  ctx.hooks.on('workspace.created', (payload, meta) => {
    record('hooks.jsonl', { effect_id: meta.effectId, attempt: meta.attempt, root: payload.root })
  })
}

export function deactivate() {
  record('lifecycle.jsonl', { event: 'deactivate' })
}
