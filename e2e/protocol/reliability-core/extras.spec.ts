// R001 and R002 for effect commands the shared tables in this area do not fit:
//
// - device.input needs the device tool shims;
// - orchestration.child.answer is identified by the child's native request;
// - plugin.command.invoke can be held inside its plugin host while the
//   daemon dies, which is the window between dispatch and settlement.
import { expect, fixtureAnswers, prompts, test, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { deviceProfile, hostId, send } from '../devices/steps'
import { installAndEnable, pluginLines, releasePlugin, stagePlugin } from '../fixtures/plugins'

test('R002: device.input replays its recorded reply and refuses another payload after a daemon crash, sending once', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const tablet = 'android-avd:Tablet_API_35'
  const request = { operation_id: 'core-tap', host_id: id, device_id: tablet, caller: { kind: 'user' },
    action: { kind: 'tap', x: 10, y: 20 } }
  const first = await profile.call('device.input', request as never)
  expect(await profile.call('device.input', request as never)).toEqual(first)

  await profile.restartDaemon('kill')
  expect(await profile.call('device.input', request as never)).toEqual(first)
  const conflict = await send(profile, { op: 'device.input', ...request, action: { kind: 'tap', x: 11, y: 20 } })
  expect(conflict.message).toContain('already used for different parameters')
  expect(await host.calls('adb', 'input')).toHaveLength(1)
})

/** A delegated child waiting on a question, and the user's answer to it. */
async function childQuestion(profile: ScratchProfile) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const parent = (await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })).conversation.id
  const { child } = await profile.call('orchestration.delegate', { operation_id: 'core-delegate',
    parent_conversation_id: parent, caller: { kind: 'user' }, provider: 'codex', account: { mode: 'inherit' },
    workspace: { mode: 'same' }, task: prompts.questions })
  const childId = child.child_conversation_id
  type Pending = { request_id: string; method: string; params: Record<string, unknown> }
  let question: Pending | undefined
  await expect.poll(async () => {
    const { children } = await profile.call('orchestration.children', { parent_conversation_id: parent })
    question = (children.find((entry) => entry.child_conversation_id === childId)?.pending_requests as Pending[])?.[0]
    return question?.request_id ?? ''
  }, { timeout: 20_000 }).not.toBe('')
  const answer = (text: string) => ({ child_conversation_id: childId, request_id: question!.request_id,
    caller: { kind: 'user' as const }, decision: 'answer', answers: fixtureAnswers({ id: question!.request_id,
      method: question!.method, params: question!.params }, text) })
  return { childId, answer }
}

async function replies(profile: ScratchProfile) {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'approval/reply')
}

test('R002: a child answer retried after a daemon crash converges, another answer is refused, and the child gets one reply', async ({ profile }) => {
  const { answer } = await childQuestion(profile)
  const first = await profile.call('orchestration.child.answer', answer('yes'))
  expect(await profile.call('orchestration.child.answer', answer('yes'))).toEqual(first)
  await profile.restartDaemon('kill')
  expect(await profile.call('orchestration.child.answer', answer('yes'))).toEqual(first)
  await expect(profile.call('orchestration.child.answer', answer('no'))).rejects.toThrow()
  await expect.poll(async () => (await replies(profile)).length, { timeout: 20_000 }).toBe(1)
  expect(JSON.stringify(await replies(profile))).not.toContain('"no"')
})

test('R001: a child answer whose reply is lost to a daemon crash is delivered once and never replayed', async ({ profile }) => {
  const { answer } = await childQuestion(profile)
  await sendAndLoseReply(profile, { op: 'orchestration.child.answer', ...answer('yes') })
  await profile.killDaemon()
  await profile.restartDaemon()
  // The retry reads the recorded decision, or delivers it now; either way the child hears it once.
  await profile.call('orchestration.child.answer', answer('yes'))
  await expect(profile.call('orchestration.child.answer', answer('no'))).rejects.toThrow()
  await expect.poll(async () => (await replies(profile)).length, { timeout: 20_000 }).toBe(1)
  await profile.call('orchestration.child.answer', answer('yes'))
  expect(await replies(profile)).toHaveLength(1)
  expect(JSON.stringify(await replies(profile))).not.toContain('"no"')
})

test('R001: a plugin command held in its host when the daemon crashes is never run again', async ({ ade, profile }) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const request = { operation_id: 'core-held-command', plugin_id: pluginId, command_id: 'e2e.backend.hold',
    args: { release: 'core-release' } }
  const held = () => pluginLines(outDir, 'lifecycle.jsonl')
    .then((lines) => lines.filter((line) => line.event === 'hold-started').length)
  const lost = profile.call('plugin.command.invoke', request).catch((error: Error) => error)
  await expect.poll(held, { timeout: 20_000 }).toBe(1)
  await profile.killDaemon()
  expect(await lost).toBeInstanceOf(Error)
  await releasePlugin(outDir, 'core-release')
  await profile.restartDaemon()

  // The retry reports what the receipt knows; it never starts the command again.
  const retried = await profile.call('plugin.command.invoke', request).then((reply) => ({ reply }),
    (error: { code?: string; message: string }) => ({ error: { code: error.code, message: error.message } }))
  expect(retried).toMatchObject({ error: { code: 'outcome_unknown' } })
  const again = await profile.call('plugin.command.invoke', request).then((reply) => ({ reply }),
    (error: { code?: string; message: string }) => ({ error: { code: error.code, message: error.message } }))
  expect(again).toEqual(retried)
  await expect(profile.call('plugin.command.invoke', { ...request, args: { release: 'other' } }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(await held()).toBe(1)
})
