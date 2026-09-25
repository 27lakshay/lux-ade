import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:net'
import { rpc, startDaemon } from '../fixtures/daemon'

type Listener = { port: number; pid: number; ownership: string; workspace_id: string | null; service_name: string | null }
type Assignment = { port: number; variable: string; observation: string }
type Inventory = { type: string; scope: string; coverage: string; listeners: Listener[]; assignments: Assignment[] }

async function listen(port: number): Promise<Server> {
  const server = createServer((peer) => peer.end('unrelated'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('listener inventory distinguishes managed process evidence from assigned and unrelated ports', async () => {
  const daemon = await startDaemon()
  const unrelated = await listen(0)
  let blocker: Server | undefined
  try {
    const workspace = (await rpc(daemon.socket, { op: 'catalog.get' }).then((result) =>
      (result.catalog as { workspaces: Array<{ id: string }> }).workspaces[0]))
    const unrelatedPort = (unrelated.address() as { port: number }).port
    const configured = await rpc(daemon.socket, {
      op: 'service.configure', workspace_id: workspace.id, name: 'web', revision: 0,
      config: { program: process.execPath,
        args: ['-e', 'require("http").createServer((_,res)=>res.end("ready")).listen(Number(process.env.PORT),"127.0.0.1")'],
        cwd: '.', env: {}, ports: ['PORT'] },
    })
    const service = configured.service as { ports: { PORT: number } }
    const port = service.ports.PORT
    const inventory = await rpc(daemon.socket, { op: 'listener.list' }) as Inventory
    expect(inventory).toMatchObject({ type: 'listeners', scope: 'local_host', coverage: 'partial' })
    expect(inventory.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ port, variable: 'PORT', observation: 'unobserved' })]))
    expect(inventory.listeners).toEqual(expect.arrayContaining([expect.objectContaining({ port: unrelatedPort, ownership: 'unknown', workspace_id: null })]))

    blocker = await listen(port)
    const blockedInventory = await rpc(daemon.socket, { op: 'listener.list' }) as Inventory
    expect(blockedInventory.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ port, observation: 'observed_other' })]))
    expect(blockedInventory.listeners).toEqual(expect.arrayContaining([expect.objectContaining({ port, ownership: 'unknown', workspace_id: null })]))
    await expect(rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })).rejects.toThrow('in use')
    await close(blocker)
    blocker = undefined

    await rpc(daemon.socket, { op: 'service.start', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => {
      const current = await rpc(daemon.socket, { op: 'listener.list' }) as Inventory
      return current.assignments.find((item) => item.port === port)?.observation
    }).toBe('verified_managed')
    const running = await rpc(daemon.socket, { op: 'listener.list' }) as Inventory
    expect(running.listeners).toEqual(expect.arrayContaining([expect.objectContaining({
      port, ownership: 'managed_service', workspace_id: workspace.id, service_name: 'web',
    })]))
    expect(running.listeners.find((item) => item.port === unrelatedPort)?.ownership).toBe('unknown')

    await rpc(daemon.socket, { op: 'service.stop', workspace_id: workspace.id, name: 'web' })
    await expect.poll(async () => {
      const current = await rpc(daemon.socket, { op: 'listener.list' }) as Inventory
      return current.assignments.find((item) => item.port === port)?.observation
    }).toBe('unobserved')
  } finally {
    if (blocker) await close(blocker)
    await close(unrelated)
    await daemon.stop()
  }
})
