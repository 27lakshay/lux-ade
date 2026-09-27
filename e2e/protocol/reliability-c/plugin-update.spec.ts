// R013: active work continues while a plugin updates (architecture section
// 12, fault scenario 6). A plugin's code and data schema are updated while an
// old worker or host still runs work. The old work finishes on its own
// version, data stays compatible, the update waits for a drain where it must,
// and the old generation's late cleanup never removes what the new one
// registered.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, isRunning, send, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { installAndEnable, pluginLines, releasePlugin, stagePlugin } from '../fixtures/plugins'
import { exists } from './steps'

async function create(profile: ScratchProfile, provider: string) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  return (await profile.call('conversation.create', { workspace_id: workspace.id, provider })).conversation.id
}

async function assistantTexts(profile: ScratchProfile, conversationId: string) {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
}

async function generations(profile: ScratchProfile, pluginId: string) {
  return (await profile.call('plugin.generation.list', { plugin_id: pluginId })).generations
}

async function states(profile: ScratchProfile, pluginId: string) {
  return (await generations(profile, pluginId)).map((generation) => `${generation.version}:${generation.state}`).sort()
}

/**
 * A staged provider fixture that answers `reply`. A turn whose text is `hold`
 * writes `<control>/held` and finishes only once `<control>/release` exists.
 */
async function stageProvider(root: string, control: string, reply: string, manifest: Record<string, unknown> = {}) {
  const source = await stagePlugin(root, 'provider', manifest)
  const worker = join(source, 'worker.mjs')
  const original = await readFile(worker, 'utf8')
  const held = `      const finish = () => {
        event({ type: 'item', session, item: user })
        event({ type: 'item', session, item: reply })
        event({ type: 'finished', session, turn, status: 'completed', error: null })
      }
      if (params.text !== 'hold') return finish()
      writeFileSync(${JSON.stringify(join(control, 'held'))}, String(process.pid))
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(join(control, 'release'))})) { clearInterval(timer); finish() }
      }, 20)
`
  const edited = original
    .replace(
      "import { createInterface } from 'node:readline'",
      "import { createInterface } from 'node:readline'\nimport { existsSync, writeFileSync } from 'node:fs'",
    )
    .replace("text: 'Hello plugin'", `text: ${JSON.stringify(reply)}`)
    .replace(
      `      event({ type: 'item', session, item: user })
      event({ type: 'item', session, item: reply })
      event({ type: 'finished', session, turn, status: 'completed', error: null })
`,
      held,
    )
  expect(edited).toContain("params.text !== 'hold'")
  await writeFile(worker, edited)
  return source
}

test('a provider Conversation mid-turn finishes on the old version while the plugin updates', async ({
  ade,
  profile,
}) => {
  const control = join(ade.root, 'provider-control')
  await mkdir(control, { recursive: true })
  const { pluginId } = await installAndEnable(profile, await stageProvider(ade.root, control, 'Hello from v1'))
  const provider = `plugin:${pluginId}`
  const record = await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'first',
    value: { written_by: 'v1' },
  })
  expect(record.record).toMatchObject({ data_schema: 1, revision: 1 })

  // A turn is running on version 1 when the update starts.
  const old = await create(profile, provider)
  await send(profile, old, 'hold')
  await expect.poll(() => exists(join(control, 'held'))).toBe(true)
  const oldWorker = Number(await readFile(join(control, 'held'), 'utf8'))

  // An enabled plugin must be disabled (drained of new work) before its artifact is replaced.
  const v2 = await stageProvider(ade.root, control, 'Hello from v2', { version: '2.0.0' })
  await expect(
    profile.call('plugin.install', { operation_id: 'update-enabled', source: { kind: 'local', path: v2 } }),
  ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/disable it/) })
  await profile.call('plugin.disable', { plugin_id: pluginId })
  // The old worker still uses the plugin's records, so raising the data schema
  // waits until the leased sessions end. Nothing is replaced.
  await expect(
    profile.call('plugin.install', {
      operation_id: 'update-schema',
      source: {
        kind: 'local',
        path: await stageProvider(ade.root, control, 'Hello from v2', { version: '2.0.0', data_schema: 2 }),
      },
    }),
  ).rejects.toMatchObject({
    code: 'conflict',
    message: expect.stringMatching(/raises it to 2 while 1 provider session/),
  })
  expect((await profile.call('plugin.inspect', { plugin_id: pluginId })).plugin.version).toBe('1.0.0')
  // A compatible update (same data schema) is admitted beside the running worker.
  const updated = await profile.call('plugin.install', { operation_id: 'update', source: { kind: 'local', path: v2 } })
  expect(updated.plugin).toMatchObject({ version: '2.0.0' })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  await expect.poll(() => states(profile, pluginId)).toEqual(['1.0.0:leased', '2.0.0:current'])

  // The old worker kept running through disable, install and enable, and the held turn finishes there.
  expect(await isRunning(oldWorker)).toBe(true)
  await writeFile(join(control, 'release'), '')
  await expect.poll(() => assistantTexts(profile, old)).toEqual(['Hello from v1'])
  await waitForIdle(profile, old)
  await send(profile, old, 'again')
  await expect.poll(() => assistantTexts(profile, old)).toEqual(['Hello from v1', 'Hello from v1'])
  await waitForIdle(profile, old)
  // Data written by version 1 is still there for version 2.
  expect(
    (await profile.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'first' })).record,
  ).toMatchObject({ value: { written_by: 'v1' }, data_schema: 1 })

  // New work starts on version 2.
  const fresh = await create(profile, provider)
  await send(profile, fresh, 'hello')
  await expect.poll(() => assistantTexts(profile, fresh)).toEqual(['Hello from v2'])
  await waitForIdle(profile, fresh)

  // The old Conversation ends late and its worker exits. That cleanup keeps
  // version 1's artifact for the leased Conversation and leaves version 2's
  // provider registration and Conversations untouched.
  await profile.call('agent.disconnect', { conversation_id: old })
  await expect.poll(() => isRunning(oldWorker), { timeout: 20_000 }).toBe(false)
  expect(await states(profile, pluginId)).toEqual(['1.0.0:leased', '2.0.0:current'])
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(true)
  await send(profile, fresh, 'after cleanup')
  await expect.poll(() => assistantTexts(profile, fresh)).toEqual(['Hello from v2', 'Hello from v2'])
  await waitForIdle(profile, fresh)

  // After a daemon crash, new work still reaches version 2 and the old Conversation resumes on version 1.
  await profile.restartDaemon('kill')
  expect((await profile.call('catalog.get', {})).providers.some((descriptor) => descriptor.id === provider)).toBe(true)
  const afterCrash = await create(profile, provider)
  await send(profile, afterCrash, 'hello')
  await expect.poll(() => assistantTexts(profile, afterCrash)).toEqual(['Hello from v2'])
  await waitForIdle(profile, afterCrash)
  await profile.call('agent.resume', { conversation_id: old })
  await waitForIdle(profile, old)
  await send(profile, old, 'resumed')
  await expect.poll(() => assistantTexts(profile, old)).toEqual(['Hello from v1', 'Hello from v1', 'Hello from v1'])
  await waitForIdle(profile, old)
})

let invocations = 0

function invoke(profile: ScratchProfile, pluginId: string, commandId: string, args: unknown = null) {
  return profile.call(
    'plugin.command.invoke',
    { operation_id: `update-${process.pid}-${++invocations}`, plugin_id: pluginId, command_id: commandId, args },
    { timeoutMs: 60_000 },
  )
}

async function setVersion(source: string, version: string): Promise<void> {
  const path = join(source, 'backend.mjs')
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace(/^const VERSION = '.*'$/m, `const VERSION = '${version}'`),
  )
}

test('a backend command running on the old host finishes there while the plugin updates, and late cleanup keeps the new commands', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const first = (await invoke(profile, pluginId, 'e2e.backend.echo')).outcome as {
    value: { version: string; pid: number }
  }
  expect(first.value.version).toBe('v1')
  await profile.call('plugin.record.put', {
    plugin_id: pluginId,
    namespace: 'notes',
    key: 'before',
    value: { by: 'v1' },
  })

  // A call holds the version 1 host while the plugin is disabled, replaced and enabled again.
  const held = invoke(profile, pluginId, 'e2e.backend.hold', { release: 'release-update' })
  await expect
    .poll(async () => (await pluginLines(outDir, 'lifecycle.jsonl')).some((line) => line.event === 'hold-started'))
    .toBe(true)
  await profile.call('plugin.disable', { plugin_id: pluginId })
  const v2 = await stagePlugin(ade.root, 'backend', { version: '2.0.0', data_schema: 2 })
  await setVersion(v2, 'v2')
  await profile.call('plugin.install', { operation_id: 'backend-update', source: { kind: 'local', path: v2 } })
  await profile.call('plugin.enable', { plugin_id: pluginId })
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'out_dir', value: outDir })

  // New work reaches version 2 in a new host; the old host still runs the held call.
  const fresh = (await invoke(profile, pluginId, 'e2e.backend.echo')).outcome as {
    value: { version: string; pid: number }
  }
  expect(fresh.value.version).toBe('v2')
  expect(fresh.value.pid).not.toBe(first.value.pid)
  expect(await isRunning(first.value.pid)).toBe(true)

  await releasePlugin(outDir, 'release-update')
  expect((await held).outcome).toMatchObject({ status: 'completed', value: { version: 'v1', pid: first.value.pid } })

  // The old host deactivates late. Its cleanup leaves the new host and its commands registered.
  await expect.poll(() => isRunning(first.value.pid), { timeout: 20_000 }).toBe(false)
  const events = (await pluginLines(outDir, 'lifecycle.jsonl')).map((line) => `${line.event}:${line.version}`)
  expect(events.indexOf('deactivate:v1')).toBeGreaterThan(events.indexOf('hold-started:v1'))
  const status = await profile.call('plugin.host.status', { plugin_id: pluginId })
  expect(JSON.stringify(status)).toContain('e2e.backend.echo')
  const after = (await invoke(profile, pluginId, 'e2e.backend.echo')).outcome as {
    value: { version: string; pid: number }
  }
  expect(after.value).toMatchObject({ version: 'v2', pid: fresh.value.pid })
  expect(await isRunning(fresh.value.pid)).toBe(true)

  // No provider session leased the plugin, so its data schema rose to 2. Old
  // records stay readable, and rolling the code back never rolls data back.
  expect(
    (await profile.call('plugin.record.get', { plugin_id: pluginId, namespace: 'notes', key: 'before' })).record,
  ).toMatchObject({ value: { by: 'v1' }, data_schema: 1 })
  expect(
    (
      await profile.call('plugin.record.put', {
        plugin_id: pluginId,
        namespace: 'notes',
        key: 'after',
        value: { by: 'v2' },
      })
    ).record,
  ).toMatchObject({ data_schema: 2 })
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await expect(
    profile.call('plugin.install', {
      operation_id: 'backend-rollback',
      source: { kind: 'local', path: await stagePlugin(ade.root, 'backend') },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/does not roll back data/) })
})
