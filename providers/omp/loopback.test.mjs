import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Bridge } from './bridge.mjs'
import { OmpTransport } from './transport.mjs'

// The published OMP CLI and lux-ade bridge run unchanged. Only the model endpoint
// is deterministic. No user environment, credentials, extensions or tools load.
test.skipIf(process.env.ADE_OMP_LOOPBACK !== '1')(
  'published OMP streams two structured turns and resumes their exact history',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-omp-loopback-'))
    const calls = [],
      events = []
    let bridge
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      if (new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/messages') {
        res.writeHead(404)
        res.end()
        return
      }
      const payload = JSON.parse(body)
      calls.push(payload)
      const text = `Loopback answer ${calls.length}`
      const message = {
        id: `msg_loopback_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: 'ade-loopback',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'message_start', message })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 9) } })
      await new Promise((resolve) => setTimeout(resolve, 40))
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(9) } })
      send({ type: 'content_block_stop', index: 0 })
      send({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      })
      send({ type: 'message_stop' })
      res.end()
    })
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const agent = join(root, 'agent'),
        cwd = join(root, 'project')
      await mkdir(agent)
      await mkdir(cwd)
      // Official custom-provider schema: docs/models.md, providers.md.
      await writeFile(
        join(agent, 'models.yml'),
        `providers:\n  ade-loopback:\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    api: anthropic-messages\n    apiKey: ade-local-placeholder\n    models:\n      - id: ade-loopback\n        name: lux-ade loopback\n        reasoning: false\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 1024\n`,
      )
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: tmpdir(),
        TERM: 'dumb',
        PI_CODING_AGENT_DIR: agent,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      }
      const options = {
        cwd,
        directory: join(root, 'ade'),
        connect: (options) =>
          OmpTransport.start({
            ...options,
            env,
            args: [...options.args, '--no-extensions', '--no-skills', '--no-rules', '--no-tools'],
          }),
      }
      bridge = new Bridge((frame) => events.push(frame.params), options)
      const opened = await bridge.open({ config: { model: 'ade-loopback/ade-loopback' } })
      expect(opened.history).toEqual([])
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 15000
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(events)}`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      for (let i = 1; i <= 2; i++) {
        await bridge.send({
          session: opened.session,
          submission: `submission-${i}`,
          message_id: `turn-${i}`,
          text: `Local prompt ${i}`,
        })
        await waitFor(() => events.some((e) => e.type === 'finished' && e.turn === `turn-${i}`))
        expect(events.find((e) => e.type === 'finished' && e.turn === `turn-${i}`)).toMatchObject({
          status: 'completed',
          error: null,
        })
      }
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls[1].messages)).toContain('Local prompt 1')
      expect(JSON.stringify(calls[1].messages)).toContain('Loopback answer 1')
      expect(events.some((e) => e.type === 'delta' || e.item?.status === 'streaming')).toBe(true)
      await bridge.close()
      bridge = new Bridge((frame) => events.push(frame.params), options)
      const resumed = await bridge.open({ resume: opened.session, config: { model: 'ade-loopback/ade-loopback' } })
      expect(resumed.session).toBe(opened.session)
      const answers = resumed.history.filter((item) => item.role === 'assistant' && item.kind === 'text')
      expect(answers.map((item) => item.text)).toEqual(['Loopback answer 1', 'Loopback answer 2'])
      expect(new Set(answers.map((item) => item.id)).size).toBe(2)
      expect(resumed.history.filter((item) => item.role === 'user').map((item) => item.text)).toEqual([
        'Local prompt 1',
        'Local prompt 2',
      ])
      expect(calls).toHaveLength(2) // Reopening never resubmits either prompt.
    } finally {
      await bridge?.close()
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  },
  45000,
)
