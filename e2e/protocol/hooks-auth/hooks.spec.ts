// F067: setup and teardown hooks stream their status while they run.
// `worktree.operation` reports the running hook (name, phase, position, the
// hooks already finished) with its latest output bounded to 16 KiB. The
// status is memory only: it ends with the hook, and a daemon that restarts
// reports the interrupted operation without stale progress.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'

const LIVE_CAP = 16 * 1024
let sequence = 0
const operationId = (label: string) => `e2e-hooks-${label}-${process.pid}-${++sequence}`

/** A hook that runs a shell script; hooks are argument vectors, never shell lines. */
const sh = (name: string, script: string, timeout_seconds?: number) => ({
  name,
  command: ['/bin/sh', '-c', script],
  ...(timeout_seconds ? { timeout_seconds } : {}),
})

/** A script that says it started, then waits for `release` to exist. */
const gated = (started: string, release: string) => `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`

async function register(profile: ScratchProfile, repo: ScratchRepo): Promise<string> {
  return (await profile.call('worktree.repository', { path: repo.path })).repository.id
}

function lookup(profile: ScratchProfile, projectId: string, id: string) {
  return profile.call('worktree.operation', { project_id: projectId, operation_id: id })
}

/** Poll until the operation reports a running hook that satisfies `ready`, and return that reply. */
async function runningHook(
  profile: ScratchProfile,
  projectId: string,
  id: string,
  ready: (hook: NonNullable<Awaited<ReturnType<typeof lookup>>['running_hook']>) => boolean,
) {
  let reply: Awaited<ReturnType<typeof lookup>> | undefined
  await expect
    .poll(
      async () => {
        reply = await lookup(profile, projectId, id)
        return reply.running_hook != null && ready(reply.running_hook)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  return reply!
}

async function settled(profile: ScratchProfile, projectId: string, id: string) {
  let reply: Awaited<ReturnType<typeof lookup>> | undefined
  await expect
    .poll(
      async () => {
        reply = await lookup(profile, projectId, id)
        return reply.operation.status
      },
      { timeout: 30_000 },
    )
    .not.toBe('running')
  return reply!
}

test('a running setup hook streams its name, position, finished hooks and bounded latest output; the status ends with the hook', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const projectId = await register(profile, repo)
  const started = join(ade.root, 'stream-started')
  const release = join(ade.root, 'stream-release')
  const runs = join(ade.root, 'stream-runs')
  await profile.call('worktree.configure', {
    project_id: projectId,
    config: {
      setup: [
        sh('prepare', 'echo prepared'),
        sh(
          'install',
          [
            `echo run >> '${runs}'`,
            'echo step-one',
            // 40 KB of output: more than the live bound, so the start is dropped.
            `head -c 40000 /dev/zero | tr '\\0' x`,
            'echo',
            'echo step-two >&2',
            gated(started, release),
            'echo step-three',
          ].join('; '),
          60,
        ),
      ],
    },
  })

  const id = operationId('create')
  await profile.call('worktree.create', { project_id: projectId, operation_id: id, name: 'streamed' })
  const live = await runningHook(profile, projectId, id, (hook) => hook.output.includes('step-two'))
  const tree = live.operation.worktree_path!
  expect(live.operation.status).toBe('running')
  expect(live.running_hook).toMatchObject({
    name: 'install',
    phase: 'setup',
    path: tree,
    index: 1,
    total: 2,
    truncated: true,
  })
  // The finished hook is listed with its verdict and without its output.
  expect(live.running_hook!.completed).toEqual([
    expect.objectContaining({ name: 'prepare', phase: 'setup', verdict: 'succeeded', exit_code: 0 }),
  ])
  expect(live.running_hook!.completed[0].output).toBeUndefined()
  // Output is bounded: the earliest line is gone, the latest is present.
  expect(Buffer.byteLength(live.running_hook!.output)).toBeLessThanOrEqual(LIVE_CAP)
  expect(live.running_hook!.output).not.toContain('step-one')
  expect(live.running_hook!.output).toContain('xxxx')
  expect(live.running_hook!.output).toContain('step-two\n')
  expect(live.running_hook!.started_at).toBeGreaterThanOrEqual(live.operation.started_at)

  // The status keeps moving while the hook runs.
  const firstElapsed = live.running_hook!.elapsed_ms
  await runningHook(profile, projectId, id, (hook) => hook.elapsed_ms > firstElapsed)

  // The public CLI shows the same running hook.
  const viaCli = await profile.cli('worktree', 'operation', projectId, id)
  expect(viaCli.code, viaCli.stderr).toBe(0)
  expect(viaCli.json).toMatchObject({
    operation: { id, status: 'running' },
    running_hook: { name: 'install', phase: 'setup', index: 1, total: 2 },
  })

  // A duplicate create with the same operation ID replays; it does not start the hooks again.
  await profile.call('worktree.create', { project_id: projectId, operation_id: id, name: 'streamed' })
  // Another lifecycle operation is refused while the hook holds the repository.
  await expect(
    profile.call('worktree.create', {
      project_id: projectId,
      operation_id: operationId('racing'),
      name: 'racing',
    }),
  ).rejects.toThrow()

  await writeFile(release, '')
  const done = await settled(profile, projectId, id)
  expect(done.operation.status, JSON.stringify(done.operation)).toBe('succeeded')
  expect(done.running_hook).toBeUndefined()
  const hooks = (done.operation.result as { hooks: Array<{ name: string; verdict: string; output: string }> }).hooks
  expect(hooks.map((hook) => [hook.name, hook.verdict])).toEqual([
    ['prepare', 'succeeded'],
    ['install', 'succeeded'],
  ])
  // The recorded run keeps the larger 64 KiB tail, including the first line and the last.
  expect(hooks[1].output).toContain('step-one')
  expect(hooks[1].output).toContain('step-three')
  expect((await readFile(runs, 'utf8')).trim().split('\n')).toEqual(['run'])
})

test('a teardown hook streams while it runs, a failing one ends with no running status, and the failure stays visible', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const projectId = await register(profile, repo)
  const created = operationId('create')
  await profile.call('worktree.create', { project_id: projectId, operation_id: created, name: 'torn' })
  const tree = (await settled(profile, projectId, created)).operation.worktree_path!
  const started = join(ade.root, 'teardown-started')
  const release = join(ade.root, 'teardown-release')
  await profile.call('worktree.configure', {
    project_id: projectId,
    config: {
      teardown: [
        sh('stop-services', `echo stopping; ${gated(started, release)}; echo cannot stop >&2; exit 5`, 60),
        sh('never', 'echo never'),
      ],
    },
  })

  const id = operationId('remove')
  await profile.call('worktree.remove', { project_id: projectId, operation_id: id, path: tree })
  const live = await runningHook(profile, projectId, id, (hook) => hook.output.includes('stopping'))
  expect(live.running_hook).toMatchObject({
    name: 'stop-services',
    phase: 'teardown',
    path: tree,
    index: 0,
    total: 2,
    completed: [],
    truncated: false,
    output: 'stopping\n',
  })
  await expect.poll(() => existsSync(started)).toBe(true)

  await writeFile(release, '')
  const done = await settled(profile, projectId, id)
  expect(done.operation).toMatchObject({ status: 'failed', code: 'teardown_hook_failed' })
  expect(done.running_hook).toBeUndefined()
  const hooks = (
    done.operation.result as { hooks: Array<{ name: string; verdict: string; exit_code: number; output: string }> }
  ).hooks
  expect(hooks.map((hook) => [hook.name, hook.verdict, hook.exit_code])).toEqual([['stop-services', 'failed', 5]])
  expect(hooks[0].output).toContain('cannot stop')
  // Safe recovery before destructive cleanup: the tree is kept and cleanup refuses it.
  expect(existsSync(tree)).toBe(true)
  const plan = await profile.call('worktree.cleanup.plan', { project_id: projectId })
  expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers).toContain('teardown_incomplete')
})

test('a daemon crash during a streaming hook leaves no stale running status: the new daemon reports the operation interrupted', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const projectId = await register(profile, repo)
  const started = join(ade.root, 'crash-started')
  const release = join(ade.root, 'crash-release')
  await profile.call('worktree.configure', {
    project_id: projectId,
    config: { setup: [sh('long', `echo before-crash; ${gated(started, release)}`, 60)] },
  })

  const id = operationId('create')
  await profile.call('worktree.create', { project_id: projectId, operation_id: id, name: 'crashing' })
  const live = await runningHook(profile, projectId, id, (hook) => hook.output.includes('before-crash'))
  const tree = live.operation.worktree_path!
  try {
    await profile.killDaemon()
  } finally {
    // The hook runs under the lifecycle supervisor, which outlives the daemon; let it finish.
    await writeFile(release, '')
  }
  await profile.restartDaemon()
  const after = await settled(profile, projectId, id)
  expect(after.operation, JSON.stringify(after.operation)).toMatchObject({ status: 'interrupted' })
  expect(after.running_hook).toBeUndefined()
  // The tree is kept, visibly interrupted, and cleanup refuses it.
  expect(existsSync(tree)).toBe(true)
  const plan = await profile.call('worktree.cleanup.plan', { project_id: projectId })
  expect(plan.trees.find((candidate) => candidate.path === tree)).toMatchObject({
    phase: 'setup_interrupted',
    eligible: false,
  })
})
