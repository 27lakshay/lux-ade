// placement.release (daemon authority ticket 08): a recorded placement on a
// paired remote host is forgotten on request, through the SDK and the CLI. A
// workspace is released only after the resources recorded inside it; a
// release of something not recorded changes nothing.
import { expect, test } from '../fixtures/remote-hosts'
import { startedHost } from './steps'

test('placement.release forgets a recorded placement, and a workspace only once nothing inside it is recorded', async ({
  remote,
}) => {
  const profile = await remote.profile()
  await startedHost(remote, profile, 'alpha')
  const host = { kind: 'remote' as const, host_id: 'alpha' }
  const workspace = { kind: 'workspace' as const, workspace_id: 'workspace-remote' }
  const conversation = {
    kind: 'conversation' as const,
    workspace_id: 'workspace-remote',
    conversation_id: 'conversation-remote',
  }
  await profile.call('placement.record', { host, resource: workspace })
  await profile.call('placement.record', { host, resource: conversation })
  expect((await profile.call('placement.list', {})).placements).toHaveLength(2)

  await expect(profile.call('placement.release', { resource: workspace })).rejects.toThrow(
    /Release the 1 recorded resources inside workspace workspace-remote first/,
  )
  expect(await profile.call('placement.release', { resource: conversation })).toMatchObject({
    resource: conversation,
    released: true,
  })
  // Released already: nothing changes.
  expect(await profile.call('placement.release', { resource: conversation })).toMatchObject({ released: false })

  const cli = await profile.cli('placement', 'release', 'workspace', 'workspace-remote')
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toMatchObject({ resource: workspace, released: true })
  expect((await profile.call('placement.list', {})).placements).toEqual([])
})
