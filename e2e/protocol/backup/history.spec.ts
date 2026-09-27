// D15: the history search index is a projection. A backup leaves it out and
// says so; the restored daemon rebuilds it from the restored messages under a
// new epoch, so a cursor issued by the source profile expires.
import { expect, send, startConversation, test, turnReply, waitForIdle, waitForMessage } from '../fixtures'
import { control } from '../fixtures/control'
import { createBackup, restoreIntoNewProfile, type Manifest } from './helpers'

test('rebuilds the history index after restore, finds restored messages and expires source cursors', async ({ ade, profile }) => {
  test.setTimeout(90_000)
  const { conversationId } = await startConversation(profile, 'codex')
  for (let turn = 0; turn < 3; turn++) {
    await send(profile, conversationId, 'hello')
    await waitForIdle(profile, conversationId)
  }
  await waitForMessage(profile, conversationId, turnReply.codex)
  await expect.poll(async () => (await profile.call('history.index.status', {})).index.caught_up).toBe(true)
  const sourceIndex = (await profile.call('history.index.status', {})).index
  const firstPage = await profile.call('history.search', { query: 'Hello', limit: 1 })
  expect(firstPage.results).toHaveLength(1)
  expect(firstPage.next_cursor).not.toBeNull()

  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)
  const inspected = await control(ade, ['backup', 'inspect', '--backup', bundle])
  const manifest = inspected.json!.manifest as Manifest
  expect(manifest.coverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ store: 'sessions.sqlite#history_index', disposition: 'rebuilt' })]))
  expect(manifest.excluded.join('\n')).toMatch(/history search index/)

  const restored = await restoreIntoNewProfile(ade, bundle)
  await expect.poll(async () => (await restored.call('history.index.status', {})).index)
    .toMatchObject({ caught_up: true, rebuilding: false, last_error: null })
  const restoredIndex = (await restored.call('history.index.status', {})).index
  expect(restoredIndex.epoch).toBeGreaterThan(sourceIndex.epoch)

  const all = await restored.call('history.search', { query: 'Hello', limit: 50 })
  const sourceAll = await profile.call('history.search', { query: 'Hello', limit: 50 })
  expect(all.results.map((match) => match.message_id).sort())
    .toEqual(sourceAll.results.map((match) => match.message_id).sort())
  expect(all.results.every((match) => match.provenance.conversation_id === conversationId)).toBe(true)

  await expect(restored.call('history.search', { query: 'Hello', limit: 1, cursor: firstPage.next_cursor }))
    .rejects.toThrow(/cursor/i)

  // A restart does not lose or rebuild the index again.
  await restored.restartDaemon('kill')
  const afterRestart = (await restored.call('history.index.status', {})).index
  expect(afterRestart.epoch).toBe(restoredIndex.epoch)
  expect((await restored.call('history.search', { query: 'Hello', limit: 50 })).results).toHaveLength(all.results.length)
})
