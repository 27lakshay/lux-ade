import type { Workspace } from '@ade/client'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { createDaemonStore } from './daemon-store'
import { clientState, createFakeHost, nextFrame } from './fake-host'
import { DaemonStoreContext, useDaemon } from './hooks'

const workspace = (id: string, name: string): Workspace => ({ id, name }) as unknown as Workspace

test('a component re-renders only when the record it selects changes', async () => {
  const fake = createFakeHost()
  const { store } = createDaemonStore(fake.host)
  let renders = 0
  function WorkspaceName({ id }: { id: string }) {
    renders++
    const name = useDaemon((state) => state.workspaces[id]?.name)
    return <span>{name ?? 'none'}</span>
  }
  const screen = await render(
    <DaemonStoreContext value={store}>
      <WorkspaceName id="w1" />
    </DaemonStoreContext>,
  )
  fake.pushClientState(
    clientState({ catalog: { workspaces: [workspace('w1', 'ade'), workspace('w2', 'x')], conversations: [] } }),
  )
  await nextFrame()
  await expect.element(screen.getByText('ade')).toBeVisible()
  const afterLoad = renders
  fake.pushClientState(
    clientState({
      sequence: 2,
      catalog: { workspaces: [workspace('w1', 'ade'), workspace('w2', 'y')], conversations: [] },
    }),
  )
  await nextFrame()
  expect(renders).toBe(afterLoad)
})
