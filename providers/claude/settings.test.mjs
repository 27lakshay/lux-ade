import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initSettings, nativeChoices } from './settings.mjs'
import { startWorker } from './worker-test-support.mjs'

test('listed models keep per-model effort levels, and a model without effort lists none', () => {
  const choices = nativeChoices([
    { value: 'default', resolvedModel: 'claude-sonnet', displayName: 'Default', supportedEffortLevels: ['low'] },
    { value: 'haiku', displayName: 'Haiku', supportsEffort: false, supportedEffortLevels: ['low'] },
    { value: 'unknown', displayName: 'Unknown' },
  ])
  assert.equal(choices.source, 'supportedModels')
  assert.deepEqual(
    choices.models.map(({ id, is_default, aliases, reasoning_efforts }) => ({
      id,
      is_default,
      aliases,
      reasoning_efforts,
    })),
    [
      { id: 'default', is_default: true, aliases: ['claude-sonnet'], reasoning_efforts: ['low'] },
      { id: 'haiku', is_default: false, aliases: [], reasoning_efforts: [] },
      // Not reported: ADE's table applies, labelled static.
      { id: 'unknown', is_default: false, aliases: [], reasoning_efforts: null },
    ],
  )
  assert.equal(nativeChoices(undefined), null)
  assert.equal(nativeChoices([{ displayName: 'no value' }]), null)
})

test('an init frame reports only the values it names', () => {
  assert.deepEqual(initSettings({ model: 'claude-sonnet', permissionMode: 'plan' }), {
    model: 'claude-sonnet',
    reasoning_effort: null,
    permission_mode: 'plan',
  })
  assert.deepEqual(initSettings({ model: 'm', permissionMode: 'default', effort: 'high' }).reasoning_effort, 'high')
})

test('open lists the native models; the requested effort reaches the SDK and init reports what is in effect', async () => {
  const worker = startWorker()
  try {
    await worker.initialize()
    const opened = await worker.rpc('open', {
      resume: null,
      config: { model: 'fixture-opus', permission_mode: 'plan', setting_sources: [], reasoning_effort: 'max' },
    })
    assert.equal(opened.error, undefined)
    const { native_choices: choices, session } = opened.result
    assert.deepEqual(
      choices.models.map((model) => [model.id, model.reasoning_efforts]),
      [
        ['default', ['low', 'medium', 'high', 'xhigh']],
        ['fixture-opus', ['low', 'medium', 'high', 'xhigh', 'max']],
        ['fixture-haiku', []],
      ],
    )
    const reported = await worker.wait((events) => events.find((event) => event.type === 'settings'))
    assert.deepEqual(reported, {
      type: 'settings',
      session,
      // The SDK subprocess init frame does not name effort; it stays unknown.
      settings: { model: 'fixture-opus', reasoning_effort: null, permission_mode: 'plan' },
    })
  } finally {
    await worker.close()
  }
})
