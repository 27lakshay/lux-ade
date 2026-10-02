import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startWorker } from './worker-test-support.mjs'

// Explicit opt-in: real installed SDK and CLI, loopback API, no live credentials.
test(
  'installed SDK projects native stream, permission, abort terminal and resume identity',
  { skip: !process.env.ADE_CLAUDE_LOOPBACK_BIN, timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-claude-worker-loopback-'))
    let mode = 'text',
      requestCount = 0
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (!request.url.startsWith('/v1/messages')) {
        response.writeHead(404)
        response.end()
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (request.url.includes('count_tokens')) {
        response.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      const id = 'msg_native_' + ++requestCount
      if (!body.stream) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'Hello world' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const emit = (data) => response.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
      emit({
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })
      if (mode === 'permission') {
        mode = 'text'
        emit({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_native_permission', name: 'Bash', input: {} },
        })
        emit({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              command: 'printf loopback-approved > approval.txt; cat approval.txt',
              description: 'Write and read an isolated loopback marker',
            }),
          },
        })
        emit({ type: 'content_block_stop', index: 0 })
        emit({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 10 },
        })
      } else {
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })
        if (mode === 'interrupt') return // Native CLI aborts this open API stream.
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        })
      }
      emit({ type: 'message_stop' })
      response.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const env = {
      PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      SHELL: '/bin/zsh',
      ADE_CLAUDE_BIN: process.env.ADE_CLAUDE_LOOPBACK_BIN,
      ADE_DATA_DIR: join(root, 'ade-data'),
      ANTHROPIC_API_KEY: 'loopback-not-a-live-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    }
    const workers = []
    const makeWorker = () => {
      const worker = startWorker({ fixture: false, cwd: root, env })
      workers.push(worker)
      return worker
    }
    const finish = (worker, submission) =>
      worker.wait((events) => events.find((event) => event.type === 'finished' && event.submission === submission))
    try {
      const worker = makeWorker()
      await worker.initialize()
      const opened = await worker.open()
      assert.equal(opened.error, undefined, JSON.stringify(opened))
      const session = opened.result.session
      await worker.send(session, 'loopback text', 'text', 'durable-text')
      assert.equal((await finish(worker, 'text')).status, 'completed')
      const deltas = worker.events().filter((event) => event.type === 'delta' && event.submission === 'text')
      assert.deepEqual(
        deltas.map((event) => event.text),
        ['Hello ', 'world'],
      )
      assert.equal(new Set(deltas.map((event) => event.id)).size, 1)
      const final = worker.events().find((event) => event.type === 'item' && event.item.id === deltas[0].id)
      assert.equal(final.item.text, 'Hello world')
      assert.equal(final.item.client_id, null)
      mode = 'permission'
      await worker.send(session, 'loopback permission', 'permission')
      const pending = await worker.wait((events) =>
        events.find(
          (event) => event.type === 'request' && event.metadata.native_callback_id === 'toolu_native_permission',
        ),
      )
      const requestIndex = worker.events().findIndex((event) => event === pending)
      const observedTool = worker
        .events()
        .slice(0, requestIndex)
        .find((event) => event.type === 'item' && event.item.id === 'toolu_native_permission')
      assert.equal(pending.submission, observedTool?.submission ?? null)
      assert.equal(pending.metadata.native_callback_id, 'toolu_native_permission')
      assert.equal(pending.metadata.native_item_id, 'toolu_native_permission')
      assert.notEqual(pending.id, pending.metadata.native_callback_id)
      assert.equal(
        (
          await worker.rpc('answer', {
            id: pending.id,
            operation_id: 'native-answer',
            answer: { kind: 'choice', value: { kind: 'claude_permission', decision: 'allow_once' } },
          })
        ).error,
        undefined,
      )
      assert.equal((await finish(worker, 'permission')).status, 'completed')
      assert.equal(
        worker
          .events()
          .find((event) => event.type === 'item' && event.item.id === 'toolu_native_permission:result')
          .item.text.trim(),
        'loopback-approved',
      )
      assert.deepEqual(
        worker.events().filter((event) => event.type === 'resolved'),
        [],
        'native tool completion and callback answer are not a request-closed signal',
      )
      mode = 'interrupt'
      await worker.send(session, 'loopback interrupt', 'interrupt')
      await worker.wait((events) => events.find((event) => event.type === 'delta' && event.submission === 'interrupt'))
      const interruption = await worker.rpc('cancel', {
        session,
        turn: null,
        source_attempt_id: 'attempt',
        submission_id: 'interrupt',
      })
      assert.equal(interruption.error, undefined)
      assert.equal(interruption.result.evidence.scope, 'turn')
      assert.equal(interruption.result.evidence.interruption_requested, true)
      assert.equal(interruption.result.evidence.termination, 'requested')
      assert.equal(interruption.result.evidence.active_work_remaining, null)
      assert.equal(interruption.result.evidence.queued_work_count, null)
      assert.equal(interruption.result.evidence.background_work_remaining, null)
      const terminal = await finish(worker, 'interrupt')
      assert.equal(terminal.status, 'cancelled')
      assert.equal(terminal.native_terminal.terminal_reason, 'aborted_streaming')
      assert.equal(terminal.interrupt_requested, true)
      assert.ok(
        worker
          .events()
          .some((event) => event.type === 'item' && event.submission === 'interrupt' && event.item.text === 'Hello '),
      )
      assert.equal((await worker.close()).code, 0)
      mode = 'text'
      const resumed = makeWorker()
      await resumed.initialize()
      assert.equal((await resumed.open(session)).result?.session, session)
      await resumed.send(session, 'loopback resume', 'resume', 'durable-resume')
      assert.equal((await finish(resumed, 'resume')).status, 'completed')
      const context = {
        provider: 'claude',
        execution_id: 'loopback',
        account_id: null,
        invalidation_epoch: 0,
        lineage: null,
      }
      const history = new Map()
      let cursor = null,
        snapshot = null
      do {
        const response = await resumed.rpc('history', {
          session,
          context,
          snapshot,
          cursor,
          max_items: 2,
          max_bytes: 200000,
        })
        assert.equal(response.error, undefined, JSON.stringify(response))
        assert.equal(response.result.error, null)
        assert.equal(response.result.snapshot.consistency, 'best_effort')
        assert.ok(response.result.snapshot.size_bytes > 0)
        for (const item of response.result.items) {
          assert.equal(item.native_message.provider, 'claude')
          assert.equal(item.native_message.session, session)
          assert.equal(item.turn, null)
          assert.equal(item.client_id, null)
          history.set(item.id, item)
        }
        snapshot = response.result.snapshot
        cursor = response.result.next_cursor
      } while (cursor)
      assert.equal(history.get('durable-text').text, 'loopback text')
      assert.equal(history.get(final.item.id).text, 'Hello world')
      assert.equal(history.get('toolu_native_permission:result').text.trim(), 'loopback-approved')
      const wrongSnapshot = { ...snapshot, invalidation_epoch: 1 }
      assert.equal(
        (
          await resumed.rpc('history', {
            session,
            context,
            snapshot: wrongSnapshot,
            cursor: null,
            max_items: 2,
            max_bytes: 200000,
          })
        ).error?.data.code,
        'invalid_request',
      )
      // Seed an isolated SDK-format child log; the installed SDK, not the test loader, discovers and reads it.
      const projects = join(env.CLAUDE_CONFIG_DIR, 'projects')
      let project
      for (const directory of await readdir(projects))
        if ((await readdir(join(projects, directory))).includes(session + '.jsonl')) project = join(projects, directory)
      assert.ok(project, 'native SDK wrote its parent transcript')
      const parentEntries = (await readFile(join(project, session + '.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const assistantEntry = parentEntries.find((entry) => entry.type === 'assistant')
      const child = 'fixture-child'
      const childDirectory = join(project, session, 'subagents')
      await mkdir(childDirectory, { recursive: true })
      const childBlocks = [
        { type: 'thinking', thinking: 'private child reasoning' },
        ...Array.from({ length: 70 }, (_, index) => ({ type: 'text', text: 'child block ' + index })),
      ]
      await writeFile(
        join(childDirectory, 'agent-' + child + '.jsonl'),
        JSON.stringify({
          ...assistantEntry,
          parentUuid: null,
          isSidechain: true,
          agentId: child,
          uuid: randomUUID(),
          message: { ...assistantEntry.message, id: 'native-child-api', content: childBlocks },
        }) + '\n',
      )
      const childMessages = []
      let childOffset = 0,
        childCursor = null
      do {
        const page = await resumed.rpc('child_transcript', { session, child, offset: childOffset, cursor: childCursor })
        assert.equal(page.error, undefined, JSON.stringify(page))
        assert.ok(page.result.items.length <= 32)
        childMessages.push(...page.result.items)
        childOffset = page.result.next_offset
        childCursor = page.result.next_cursor
      } while (childCursor)
      assert.equal(childOffset, null)
      assert.deepEqual(
        childMessages.map((message) => message.text),
        Array.from({ length: 70 }, (_, index) => 'child block ' + index),
      )
      assert.equal(
        (await resumed.rpc('child_transcript', { session, child: 'not-owned', offset: 0, cursor: null })).error?.data
          .code,
        'invalid_request',
      )
      const rewind = (native_message) =>
        resumed.rpc('rewind', { session, turn: null, native_message, operation: randomUUID() })
      const firstFork = await rewind(history.get('durable-text').native_message)
      assert.equal(firstFork.error?.data.code, 'unsupported', JSON.stringify(firstFork))
      assert.equal(
        (await rewind({ ...history.get('durable-resume').native_message, session: 'wrong-session' })).error?.data.code,
        'invalid_request',
      )
      assert.equal((await rewind(history.get(final.item.id).native_message)).error?.data.code, 'invalid_request')
      const fork = await rewind(history.get('durable-resume').native_message)
      assert.equal(fork.error, undefined, JSON.stringify(fork))
      assert.notEqual(fork.result.session, session)
      assert.equal(fork.result.previous_session, session)
      assert.equal(fork.result.scope, 'conversation')
      const forkSession = fork.result.session
      const forkRows = new Map()
      let forkSnapshot = null,
        forkCursor = null
      do {
        const page = await resumed.rpc('history', {
          session: forkSession,
          context,
          snapshot: forkSnapshot,
          cursor: forkCursor,
          max_items: 2,
          max_bytes: 200000,
        })
        assert.equal(page.error, undefined, JSON.stringify(page))
        assert.equal(page.result.error, null, JSON.stringify(page.result))
        forkSnapshot = page.result.snapshot
        for (const row of page.result.items) forkRows.set(row.id, row)
        forkCursor = page.result.next_cursor
      } while (forkCursor)
      assert.equal(forkRows.get('durable-text').text, 'loopback text')
      assert.equal(forkRows.get(final.item.id).text, 'Hello world')
      assert.equal(forkRows.get('toolu_native_permission:result').text.trim(), 'loopback-approved')
      assert.equal(forkRows.has('durable-resume'), false)
      assert.equal(forkRows.get('durable-text').native_message.session, forkSession)
      assert.equal(
        (await readFile(join(root, 'approval.txt'), 'utf8')).trim(),
        'loopback-approved',
        'conversation rewind does not undo tool filesystem effects',
      )
      await resumed.send(forkSession, 'loopback fork continuation', 'fork-continuation')
      assert.equal((await finish(resumed, 'fork-continuation')).status, 'completed')
      assert.equal(
        JSON.parse(await readFile(join(env.ADE_DATA_DIR, 'claude-forks', forkSession + '.json'), 'utf8')).forked_from,
        session,
      )
      assert.equal((await resumed.close()).code, 0)
      const forkResumed = makeWorker()
      await forkResumed.initialize()
      assert.equal((await forkResumed.open(forkSession)).result?.session, forkSession)
      await forkResumed.send(forkSession, 'loopback fork resume', 'fork-resume')
      assert.equal((await finish(forkResumed, 'fork-resume')).status, 'completed')
      assert.equal((await forkResumed.close()).code, 0)
      const missing = makeWorker()
      await missing.initialize()
      assert.equal((await missing.open(randomUUID())).error?.data.code, 'provider_failure')
    } finally {
      for (const worker of workers) await worker.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  },
)
