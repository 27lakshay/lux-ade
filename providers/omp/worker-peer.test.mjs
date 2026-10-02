import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS, PROTOCOL_VERSION } from '../../packages/provider-sdk/dist/provider.js'

const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const peer = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url))
const descriptor = {
  compatible_protocol_versions: [PROTOCOL_VERSION],
  name: 'Oh My Pi',
  capabilities: [],
  permission_modes: ['default'],
  operations: [
    ['open', 'effect_command'],
    ['send', 'effect_command'],
    ['steer', 'effect_command'],
    ['cancel', 'idempotent_command'],
    ['answer', 'effect_command'],
    ['history', 'query'],
    ['configure_mcp', 'effect_command'],
    ['compact', 'effect_command'],
    ['rewind', 'effect_command'],
    ['child_transcript', 'query'],
  ].map(([method, tier]) => ({
    method,
    tier,
    availability: ['steer', 'rewind'].includes(method) ? 'unsupported' : 'available',
    reason: '',
  })),
  limits: DEFAULT_LIMITS,
  requirements: SDK_REQUIREMENTS,
}

function rpc(child) {
  const frames = []
  let buffered = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line) frames.push(JSON.parse(line))
    }
  })
  let id = 0
  const request = async (method, params = {}) => {
    const current = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n')
    for (let tries = 0; tries < 500; tries++) {
      const response = frames.find((frame) => frame.id === current)
      if (response) {
        frames.splice(frames.indexOf(response), 1)
        if (response.error) throw new Error(JSON.stringify(response.error))
        return response.result
      }
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for ${method}`)
  }
  const events = () => frames.filter((frame) => frame.method === 'event').map((frame) => frame.params)
  return { request, events }
}

test(
  'public worker opens native OMP peer, acknowledges input without inventing a native turn, and streams completion',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-omp-worker-'))
    const launcher = join(root, 'omp-peer')
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${peer}" "$@"\n`, { mode: 0o700 })
    await chmod(launcher, 0o700)
    const child = spawn(process.execPath, [worker], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ADE_DATA_DIR: root,
        ADE_OMP_BIN: launcher,
        ADE_OMP_WORKER_DESCRIPTOR: JSON.stringify(descriptor),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stderr = []
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
    const client = rpc(child)
    try {
      await client.request('initialize', { versions: [PROTOCOL_VERSION] })
      const connected = await client.request('open', {
        resume: null,
        config: { model: null, permission_mode: 'default', setting_sources: [] },
      })
      expect(connected.session).toBeString()
      // get_state names what is in effect; get_available_models lists the catalogue, and only
      // the live model lists its thinking levels (get_available_thinking_levels).
      expect(connected.native_settings).toEqual({
        model: 'fixture/omp-default',
        reasoning_effort: 'medium',
        permission_mode: null,
      })
      expect(connected.native_choices.source).toBe('get_available_models')
      expect(connected.native_choices.models.map((model) => [model.id, model.reasoning_efforts])).toEqual([
        ['fixture/omp-default', ['off', 'low', 'medium', 'high']],
        ['fixture/omp-plain', null],
      ])
      const result = await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-a',
        submission: 'submission-a',
        message_id: 'message-a',
        text: 'hello',
        attachments: [],
      })
      expect(result).toEqual({ admitted: true, dispatch: 'dispatched', native_outcome: 'accepted', turn: null })
      for (let i = 0; i < 200 && !client.events().some((event) => event.type === 'finished'); i++) await Bun.sleep(10)
      let observed = client.events()
      expect(
        observed.some(
          (event) => event.type === 'submitted' && event.submission === 'submission-a' && event.turn === null,
        ),
      ).toBe(true)
      expect(
        observed.some(
          (event) => event.type === 'item' && event.item?.text === 'Hello Oh My Pi' && event.item.turn === null,
        ),
      ).toBe(true)
      expect(
        observed.some(
          (event) =>
            event.type === 'finished' &&
            event.status === 'completed' &&
            event.submission === 'submission-a' &&
            event.turn === null,
        ),
      ).toBe(true)
      const context = {
        account_id: null,
        execution_id: 'execution-a',
        invalidation_epoch: 1,
        lineage: null,
        provider: 'Oh My Pi',
      }
      const firstPage = await client.request('history', {
        context,
        cursor: null,
        max_bytes: 4096,
        max_items: 1,
        session: connected.session,
        snapshot: null,
      })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.items[0].turn).toBeNull()
      expect(firstPage.complete).toBe(false)
      const secondPage = await client.request('history', {
        context,
        cursor: firstPage.next_cursor,
        max_bytes: 4096,
        max_items: 1,
        session: connected.session,
        snapshot: firstPage.snapshot,
      })
      expect(secondPage.items).toHaveLength(1)
      expect(secondPage.snapshot).toEqual(firstPage.snapshot)
      expect('item_cursors' in secondPage).toBe(false)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-b',
        submission: 'submission-b',
        message_id: 'message-b',
        text: 'approval',
        attachments: [],
      })
      for (
        let i = 0;
        i < 200 && !client.events().some((event) => event.type === 'request' && event.method === 'omp/toolApproval');
        i++
      )
        await Bun.sleep(10)
      observed = client.events()
      const approval = observed.find((event) => event.type === 'request' && event.method === 'omp/toolApproval')
      expect(approval).toMatchObject({ submission: null, turn: null, supported: true })
      await client.request('answer', {
        id: approval.id,
        operation_id: 'answer-b',
        answer: { kind: 'choice', value: true },
      })
      for (
        let i = 0;
        i < 200 && !client.events().some((event) => event.type === 'resolved' && event.id === approval.id);
        i++
      )
        await Bun.sleep(10)
      expect(
        client
          .events()
          .some((event) => event.type === 'resolved' && event.id === approval.id && event.resolution === 'resolved'),
      ).toBe(true)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-q',
        submission: 'submission-q',
        message_id: 'message-q',
        text: 'questions',
        attachments: [],
      })
      for (
        let i = 0;
        i < 200 && !client.events().some((event) => event.type === 'request' && event.method === 'omp/questions');
        i++
      )
        await Bun.sleep(10)
      const question = client.events().find((event) => event.type === 'request' && event.method === 'omp/questions')
      expect(question).toMatchObject({ submission: null, turn: null, supported: true })
      const questionId = question.metadata.schema.questions[0].id
      await expect(
        client.request('answer', {
          id: question.id,
          operation_id: 'bad-answer-q',
          answer: { kind: 'questions', answers: { [questionId]: [] } },
        }),
      ).rejects.toThrow()
      await client.request('answer', {
        id: question.id,
        operation_id: 'answer-q',
        answer: { kind: 'questions', answers: { [questionId]: ['provided'] } },
      })
      for (
        let i = 0;
        i < 200 && !client.events().some((event) => event.type === 'resolved' && event.id === question.id);
        i++
      )
        await Bun.sleep(10)
      expect(
        client
          .events()
          .some((event) => event.type === 'resolved' && event.id === question.id && event.resolution === 'resolved'),
      ).toBe(true)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-c',
        submission: 'submission-c',
        message_id: 'message-c',
        text: 'hold',
        attachments: [],
      })
      const cancelled = await client.request('cancel', {
        session: connected.session,
        source_attempt_id: 'attempt-c',
        submission_id: 'submission-c',
        turn: null,
      })
      expect(cancelled).toEqual({
        type: 'cancel_result',
        evidence: {
          scope: 'session',
          interruption_requested: true,
          termination: 'unknown',
          active_work_remaining: false,
          queued_work_count: 0,
          background_work_remaining: null,
          observed_at_ms: expect.any(Number),
        },
      })
      expect(Number.isSafeInteger(cancelled.evidence.observed_at_ms)).toBe(true)
      expect(client.events().some((event) => event.type === 'cancel_result')).toBe(false)
      expect(
        client.events().some(
          (event) =>
            // Prompts are serialized and OMP was sampled idle, so the abort settles its attempt.
            event.type === 'finished' &&
            event.submission === 'submission-c' &&
            event.status === 'interrupted' &&
            event.native_terminal?.stop_reason === 'aborted',
        ),
      ).toBe(true)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-u',
        submission: 'submission-u',
        message_id: 'message-u',
        text: 'hold-unscoped',
        attachments: [],
      })
      const unknownCancellation = await client.request('cancel', {
        session: connected.session,
        source_attempt_id: 'attempt-u',
        submission_id: 'submission-u',
        turn: null,
      })
      expect(unknownCancellation).toEqual({
        type: 'cancel_result',
        evidence: {
          scope: 'session',
          interruption_requested: true,
          termination: 'unknown',
          active_work_remaining: null,
          queued_work_count: null,
          background_work_remaining: null,
          observed_at_ms: null,
        },
      })
      expect(client.events().some((event) => event.type === 'cancel_result')).toBe(false)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-g',
        submission: 'submission-g',
        message_id: 'message-g',
        text: 'local-only',
        attachments: [],
      })
      const localCompletion = client
        .events()
        .find((event) => event.type === 'finished' && event.submission === 'submission-g')
      expect(localCompletion).toMatchObject({
        status: 'completed',
        native_terminal: { terminal_reason: 'local_prompt_complete', is_error: false },
        turn: null,
      })
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-d',
        submission: 'submission-d',
        message_id: 'message-d',
        text: 'late-failed',
        attachments: [],
      })
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-f',
        submission: 'submission-f',
        message_id: 'message-f',
        text: 'after-late-failure',
        attachments: [],
      })
      for (
        let i = 0;
        i < 200 &&
        !client.events().some((event) => event.type === 'operation_failed' && event.submission === 'submission-d');
        i++
      )
        await Bun.sleep(10)
      expect(
        client
          .events()
          .some(
            (event) =>
              event.type === 'operation_failed' &&
              event.submission === 'submission-d' &&
              event.error === 'late fixture failure',
          ),
      ).toBe(true)
      expect(
        client.events().some((event) => event.type === 'operation_failed' && event.submission === 'submission-f'),
      ).toBe(false)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-h',
        submission: 'submission-h',
        message_id: 'message-h',
        text: 'typed-tools',
        attachments: [],
      })
      for (
        let i = 0;
        i < 200 && !client.events().some((event) => event.type === 'item' && event.item?.kind === 'read');
        i++
      )
        await Bun.sleep(10)
      expect(
        client
          .events()
          .some(
            (event) =>
              event.type === 'item' &&
              event.item?.role === 'tool' &&
              event.item.kind === 'read' &&
              event.item.content?.input?.path === 'README.md',
          ),
      ).toBe(true)
      await client.request('send', {
        session: connected.session,
        source_attempt_id: 'attempt-e',
        submission: 'submission-e',
        message_id: 'message-e',
        text: 'typed-subagents',
        attachments: [],
      })
      for (
        let i = 0;
        i < 200 &&
        !client
          .events()
          .some((event) => event.type === 'item' && event.item?.content?.agents?.[0]?.id === 'fixture-child');
        i++
      )
        await Bun.sleep(10)
      expect(
        client
          .events()
          .some(
            (event) =>
              event.type === 'item' &&
              event.item?.content?.agents?.[0]?.id === 'fixture-child' &&
              event.item.turn === null,
          ),
      ).toBe(true)
      const childPage = await client.request('child_transcript', {
        child: 'fixture-child',
        cursor: null,
        offset: 0,
        session: connected.session,
      })
      expect(childPage.items.some((item) => item.text === 'Child Oh My Pi transcript')).toBe(true)
    } catch (error) {
      throw new Error(`${error.message}\n${stderr.join('')}`)
    } finally {
      child.stdin.end()
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        Bun.sleep(7000).then(() => {
          child.kill('SIGKILL')
        }),
      ])
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.env.ADE_OMP_LOOPBACK !== '1')(
  'installed OMP public worker consumes the published question answer before model dispatch',
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-omp-native-worker-'))
    const agent = join(root, 'agent')
    const project = join(root, 'project')
    const calls = []
    let child
    const stderr = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({
        type: 'message_start',
        message: {
          id: 'native-answer',
          type: 'message',
          role: 'assistant',
          model: 'ade-loopback',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Native budget accepted' } })
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
      await mkdir(join(agent, 'extensions'), { recursive: true })
      await mkdir(project)
      await writeFile(
        join(agent, 'models.yml'),
        `providers:\n  ade-loopback:\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    api: anthropic-messages\n    apiKey: ade-local-placeholder\n    models:\n      - id: ade-loopback\n        name: Native question regression\n        reasoning: false\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 1024\n`,
      )
      // Executed by installed OMP, not by the fake RPC peer. Native input resolution
      // must resume this hook and calculate the model budget before any HTTP call.
      await writeFile(
        join(agent, 'extensions', 'budget.ts'),
        `export default function(pi) {
      pi.on('before_agent_start', async (_event, ctx) => {
        const answer = await ctx.ui.input('Native budget', 'Enter the per-task budget');
        if (!answer || !/^[0-9]+$/.test(answer)) throw new Error('Invalid native budget answer');
        return { systemPrompt: ['Native computed budget=' + (Number(answer) * 2)] };
      });
    }`,
      )
      child = spawn(process.execPath, [worker], {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: tmpdir(),
          TERM: 'dumb',
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
          ADE_DATA_DIR: join(root, 'ade'),
          ADE_OMP_ACCOUNT_HOME: agent,
          ADE_OMP_WORKER_DESCRIPTOR: JSON.stringify(descriptor),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
      const client = rpc(child)
      await client.request('initialize', { versions: [PROTOCOL_VERSION] })
      const connected = await client.request('open', {
        resume: null,
        config: { model: 'ade-loopback/ade-loopback', permission_mode: 'default', setting_sources: [] },
      })
      const admitted = await client.request('send', {
        session: connected.session,
        source_attempt_id: 'native-attempt',
        submission: 'native-submission',
        message_id: 'native-message',
        text: 'Use the configured budget',
        attachments: [],
      })
      expect(admitted).toMatchObject({ admitted: true, turn: null })
      for (
        let i = 0;
        i < 1000 && !client.events().some((event) => event.type === 'request' && event.method === 'omp/questions');
        i++
      )
        await Bun.sleep(10)
      const question = client.events().find((event) => event.type === 'request' && event.method === 'omp/questions')
      expect(question).toMatchObject({
        supported: true,
        submission: null,
        turn: null,
        metadata: { schema: { kind: 'questions' } },
      })
      expect(calls).toEqual([])
      const key = question.metadata.schema.questions[0].id
      await expect(
        client.request('answer', {
          id: question.id,
          operation_id: 'bad-native-answer',
          answer: { kind: 'questions', answers: { [key]: [] } },
        }),
      ).rejects.toThrow()
      expect(client.events().some((event) => event.type === 'resolved' && event.id === question.id)).toBe(false)
      expect(calls).toEqual([])
      await client.request('answer', {
        id: question.id,
        operation_id: 'native-answer',
        answer: { kind: 'questions', answers: { [key]: ['21'] } },
      })
      for (let i = 0; i < 1000 && !client.events().some((event) => event.type === 'finished'); i++) await Bun.sleep(10)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0].system)).toContain('Native computed budget=42')
      expect(client.events().find((event) => event.type === 'finished')).toMatchObject({
        status: 'completed',
        submission: null,
        turn: null,
      })
      expect(
        client.events().some((event) => event.type === 'item' && event.item?.text === 'Native budget accepted'),
      ).toBe(true)
      await expect(
        client.request('answer', {
          id: question.id,
          operation_id: 'stale-native-answer',
          answer: { kind: 'questions', answers: { [key]: ['99'] } },
        }),
      ).rejects.toThrow()
    } catch (error) {
      throw new Error(`${error.message}\n${stderr.join('')}`)
    } finally {
      if (child) {
        child.stdin.end()
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          Bun.sleep(7000).then(() => child.kill('SIGKILL')),
        ])
      }
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  },
)
