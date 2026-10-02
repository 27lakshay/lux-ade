#!/usr/bin/env bun
// Integration fixture: real lux-ade bridge/transport, deterministic provider process.
import { createInterface } from 'node:readline'
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// With ADE_MOCK_OMP_DIR set, record each launch in calls.jsonl: the arguments,
// and for every `--extension` package the sibling `.mcp.json` Oh My Pi would
// discover there (docs/extension-loading.md, docs/mcp-config.md), as written.
if (process.env.ADE_MOCK_OMP_DIR) {
  const argv = process.argv.slice(2)
  const extensions = argv
    .flatMap((arg, i) => (arg === '--extension' ? [argv[i + 1]] : []))
    .map((path) => {
      let mcp = null
      try {
        mcp = JSON.parse(readFileSync(join(path, '.mcp.json'), 'utf8'))
      } catch {}
      return { path, mcp }
    })
  appendFileSync(
    join(process.env.ADE_MOCK_OMP_DIR, 'calls.jsonl'),
    JSON.stringify({ pid: process.pid, method: 'launch', args: argv, cwd: process.cwd(), extensions }) + '\n',
  )
}

const file = process.argv[process.argv.indexOf('--session') + 1]
const records = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const header = records.find((record) => record.type === 'session')
const entries = records.filter((record) => record.parentId !== undefined)
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
// The catalogue `get_available_models` lists; `--model provider/id` selects the live model.
const fixtureModels = [
  { provider: 'fixture', id: 'omp-default', name: 'Fixture OMP Default', reasoning: true },
  { provider: 'fixture', id: 'omp-plain', name: 'Fixture OMP Plain', reasoning: false },
]
const requestedModel = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null
const liveModel =
  fixtureModels.find((model) => `${model.provider}/${model.id}` === requestedModel) ??
  (requestedModel
    ? { provider: requestedModel.split('/')[0], id: requestedModel.split('/').slice(1).join('/'), reasoning: false }
    : fixtureModels[0])
let active = false,
  pending = null,
  mismatchOnAbort = false,
  mismatchNextState = false
const append = (message) => {
  const entry = {
    type: 'message',
    id: randomUUID(),
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message,
  }
  appendFileSync(file, JSON.stringify(entry) + '\n')
  entries.push(entry)
  send({ type: 'message_end', message })
}
let silentAbort = false
function finish(aborted = false) {
  if (!active) return
  const message = {
    role: 'assistant',
    responseId: randomUUID(),
    content: [{ type: 'text', text: aborted ? 'Cancelled' : 'Hello Oh My Pi' }],
    stopReason: aborted ? 'aborted' : 'stop',
  }
  send({ type: 'message_start', message: { ...message, content: [{ type: 'text', text: '' }] } })
  send({ type: 'message_update', message })
  append(message)
  active = false
  pending = null
  send({ type: 'agent_end', messages: [], messagesOmitted: 1 })
}
send({ type: 'ready', supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.type === 'extension_ui_response') {
    if (request.id === pending) finish()
    continue
  }
  let data = {}
  switch (request.type) {
    case 'negotiate_protocol':
      data = { protocolVersion: 2 }
      break
    case 'get_state':
      const mismatchedSession = mismatchNextState
      mismatchNextState = false
      data = {
        sessionId: mismatchedSession ? 'replacement-session' : header.id,
        sessionFile: file,
        isStreaming: active,
        isCompacting: false,
        queuedMessageCount: 0,
        model: liveModel,
        thinkingLevel: 'medium',
      }
      break
    case 'get_available_models':
      data = { models: fixtureModels }
      break
    case 'get_available_thinking_levels':
      // Native OMP lists the live model's levels, with `off` first.
      data = { levels: ['off', ...(liveModel.reasoning ? ['low', 'medium', 'high'] : [])] }
      break
    case 'get_entries':
      data = {
        entries: entries.slice(request.since ? entries.findIndex((entry) => entry.id === request.since) + 1 : 0),
        leafId: entries.at(-1)?.id ?? null,
      }
      break
    case 'compact': {
      // Native compaction appends a compaction entry that summarizes the branch so far.
      const entry = {
        type: 'compaction',
        id: randomUUID(),
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary: 'Fixture compaction summary',
      }
      appendFileSync(file, JSON.stringify(entry) + '\n')
      entries.push(entry)
      if (process.env.ADE_MOCK_OMP_DIR)
        appendFileSync(
          join(process.env.ADE_MOCK_OMP_DIR, 'calls.jsonl'),
          JSON.stringify({ pid: process.pid, method: 'compact' }) + '\n',
        )
      data = { summary: entry.summary, firstKeptEntryId: entry.parentId, tokensBefore: 0 }
      break
    }
    case 'abort':
      if (mismatchOnAbort) {
        mismatchNextState = true
        mismatchOnAbort = false
      }
      // Installed OMP 18.4 was observed to acknowledge an abort and go idle without agent_end.
      if (silentAbort) {
        silentAbort = false
        active = false
      } else finish(true)
      break
    case 'prompt':
      active = true
      // Native OMP announces each agent run before its messages.
      send({ type: 'agent_start' })
      if (request.message === 'hold-unscoped') mismatchOnAbort = true
      if (request.message === 'hold-silent-abort') silentAbort = true
      append({ role: 'user', content: request.message })
      if (request.message === 'typed-tools') {
        const toolCallId = randomUUID()
        append({
          role: 'assistant',
          responseId: randomUUID(),
          content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: { path: 'README.md' } }],
          stopReason: 'stop',
        })
        append({
          role: 'toolResult',
          toolCallId,
          toolName: 'read',
          content: [{ type: 'text', text: 'Fixture tool output' }],
          isError: false,
        })
      }
      if (request.message === 'typed-subagents') {
        const sessionFile = file + '.child.jsonl'
        writeFileSync(
          sessionFile,
          [
            {
              type: 'session',
              id: 'fixture-native-child',
              version: 3,
              cwd: header.cwd,
              timestamp: new Date().toISOString(),
            },
            {
              type: 'message',
              id: 'child-answer',
              parentId: null,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Child Oh My Pi transcript' }],
                stopReason: 'stop',
              },
            },
          ]
            .map((x) => JSON.stringify(x))
            .join('\n') + '\n',
        )
        const payload = {
          id: 'fixture-child',
          parentToolCallId: 'fixture-task',
          agent: 'research',
          index: 0,
          agentSource: 'project',
          sessionFile,
        }
        send({ type: 'subagent_lifecycle', payload: { ...payload, status: 'started' } })
        setTimeout(() => send({ type: 'subagent_lifecycle', payload: { ...payload, status: 'completed' } }), 50)
      }
      if (request.message === 'typed-plan') {
        for (const status of ['in_progress', 'blocked'])
          append({
            role: 'toolResult',
            toolName: 'todo',
            toolCallId: randomUUID(),
            content: [{ type: 'text', text: 'updated' }],
            details: {
              op: 'block',
              phases: [
                {
                  name: 'Build',
                  tasks: [{ content: 'Inspect', status, blocker: status === 'blocked' ? 'Fixture SDK' : undefined }],
                },
              ],
            },
          })
      }
      if (request.message === 'local-only') {
        active = false
        send({ type: 'prompt_result', id: request.id, agentInvoked: false })
      }
      if (request.message === 'approval' || request.message === 'questions') {
        pending = randomUUID()
        send({
          type: 'extension_ui_request',
          id: pending,
          method: request.message === 'approval' ? 'confirm' : 'input',
          title: 'Fixture request',
          message: 'Allow fixture?',
        })
      } else if (!request.message.startsWith('hold') && request.message !== 'local-only') finish()
      break
  }
  send({ type: 'response', id: request.id, command: request.type, success: true, data })
  if (request.type === 'prompt' && request.message === 'late-failed')
    setTimeout(
      () =>
        send({ type: 'response', id: request.id, command: 'prompt', success: false, error: 'late fixture failure' }),
      25,
    )
}
