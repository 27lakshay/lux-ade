// Installed evidence: the ACP worker against a real ACP executable. Opt-in, because it sends one
// real prompt through the agent's own sign-in:
//
//   ADE_ACP_LIVE_BIN=~/.opencode/bin/opencode ADE_ACP_LIVE_ARGS=acp node --test live.test.mjs
//
// It runs in a fresh scratch directory, never the repository, and changes no agent configuration.
// It records what the agent negotiated and observably did; it claims nothing for other agents.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startWorker } from './worker-peer.mjs'

const bin = process.env.ADE_ACP_LIVE_BIN
const args = (process.env.ADE_ACP_LIVE_ARGS ?? 'acp').split(' ').filter(Boolean)
const config = { permission_mode: 'default', model: null, setting_sources: [] }

test(
  'a real ACP agent negotiates, completes one prompt, and resumes its session',
  { skip: !bin && 'set ADE_ACP_LIVE_BIN to run', timeout: 180_000 },
  async () => {
    const cwd = await mkdtemp(join(process.env.ADE_ACP_LIVE_ROOT ?? tmpdir(), 'ade-acp-live-'))
    const report = { executable: bin, args, cwd }
    const first = startWorker({ command: bin, args, name: 'Live ACP', cwd })
    try {
      const descriptor = await first.initialize()
      report.native_peer = descriptor.native_peer
      report.operations = Object.fromEntries(descriptor.operations.map((op) => [op.method, op.availability]))
      report.capabilities = descriptor.capabilities.filter((c) => c.available).map((c) => c.name)
      assert.equal(descriptor.native_peer.protocol_version, 1)
      const opened = await first.request('open', { resume: null, config }, 60_000)
      report.session = opened.session
      report.send = await first.request('send', {
        session: opened.session,
        source_attempt_id: 'live',
        submission: 'live-1',
        message_id: null,
        text: 'Reply with the single word ok',
        attachments: [],
      })
      const finished = await first.waitFor((event) => event.type === 'finished', 150_000)
      const events = first.events()
      report.finished = finished
      report.event_types = events.map((event) => event.type)
      report.message_ids = [...new Set(events.filter((event) => event.type === 'delta').map((event) => event.id))]
      report.text = events
        .filter((event) => event.type === 'delta' && event.kind === 'text')
        .map((event) => event.text)
        .join('')
      report.requests = events.filter((event) => event.type === 'request').length
      assert.equal(finished.status, 'completed')
      assert.equal(finished.native_terminal.stop_reason, 'end_turn')
      assert.match(report.text, /\bok\b/i)
      assert.equal(report.event_types[0], 'started')
      assert.ok(report.event_types.includes('submitted'))
    } finally {
      report.first_exit = await first.stop()
    }
    // A new worker reopens the native session without sending another prompt.
    const second = startWorker({ command: bin, args, name: 'Live ACP', cwd })
    try {
      await second.initialize()
      const resumed = await second.request('open', { resume: report.session, config }, 60_000)
      report.resume = { session: resumed.session, history_items: resumed.history.length }
      assert.equal(resumed.session, report.session)
    } finally {
      report.second_exit = await second.stop()
      if (process.env.ADE_ACP_LIVE_REPORT)
        await writeFile(process.env.ADE_ACP_LIVE_REPORT, JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report, null, 2))
    }
  },
)
