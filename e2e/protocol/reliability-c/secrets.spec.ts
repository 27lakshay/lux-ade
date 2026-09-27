// R018: failures are understandable without exposing secrets. Real failing
// operations carry planted credentials and transcript text: a clone URL with
// a password, a provider that prints credentials to stderr and dies, a send
// to an unknown Conversation and an oversized request. Each failure gets a
// typed, readable reply, is correlated in the diagnostics export by its
// diagnostic ID, and no planted value reaches a reply, the export or the
// daemon's and runtime's own log files. The export's planted-log redaction
// and its bounds are covered by e2e/protocol/ops/diagnostics.spec.ts.
import { randomUUID } from 'node:crypto'
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { conversationStatus, expect, send, startConversation, test, type ScratchProfile } from '../fixtures'
import { rawReply } from '../fixtures/raw-reply'

const secrets = {
  anthropic: 'sk-ant-api03-R018anthropicKEY0123456789abcdefABCDEF',
  openai: 'sk-proj-R018openaiKEY0123456789abcdefABCDEF0123',
  github: 'ghp_R018githubTOKEN0123456789abcdefABCDE',
  password: 'R018passwordVALUE',
  bearer: 'R018bearerVALUE0123456789',
}
const transcript = 'okapi-transcript-marker'

const diagnosticId = () => `diag_${randomUUID()}`

/** Every file the profile's daemon and runtime log to: their process logs and the rotated JSON logs. */
async function logFiles(profile: ScratchProfile): Promise<Array<{ name: string; text: string }>> {
  const files = [join(profile.dataDirectory, 'daemon.log'), join(profile.dataDirectory, 'runtime.log')]
  const rotated = join(profile.dataDirectory, 'logs')
  for (const name of await readdir(rotated).catch(() => [] as string[])) files.push(join(rotated, name))
  for (let launch = 1; launch <= 2; launch++) files.push(join(profile.logsDirectory, `daemon-${launch}.stderr`))
  const read = await Promise.all(
    files.map(async (path) => ({ name: path, text: await readFile(path, 'utf8').catch(() => '') })),
  )
  return read.filter((file) => file.text.length > 0)
}

test('failures carrying credentials are readable and correlated, and no secret reaches a reply, a log or the export', async ({
  ade,
  repo,
}) => {
  // A provider that prints credentials to stderr and exits before it speaks.
  const leaky = join(ade.root, 'leaky-provider.sh')
  await writeFile(
    leaky,
    `#!/bin/sh\necho "fatal: login failed for ${secrets.openai} with Authorization: Bearer ${secrets.bearer}" >&2\n` +
      `echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY GITHUB_TOKEN=$GITHUB_TOKEN" >&2\nexit 3\n`,
  )
  await chmod(leaky, 0o755)
  const profile = await ade.profile({
    env: { ANTHROPIC_API_KEY: secrets.anthropic, GITHUB_TOKEN: secrets.github, ADE_CODEX_BIN: leaky },
  })
  const all = [...Object.values(secrets), transcript]
  const replies: Array<Record<string, unknown>> = []
  const ids: Record<string, string> = {}

  // 1. A clone URL with a password is refused without echoing the password.
  ids.clone = diagnosticId()
  const clone = await rawReply(profile, {
    op: 'repository.clone',
    diagnostic_id: ids.clone,
    operation_id: 'clone-secret',
    url: `https://e2e:${secrets.password}@127.0.0.1:9/private.git`,
    destination: join(ade.root, 'clone-target'),
  })
  expect(clone).toMatchObject({ type: 'error' })
  expect(String(clone.message)).toMatch(/password|credential/i)
  replies.push(clone)

  // 2. A send with transcript and credential text to an unknown Conversation.
  ids.send = diagnosticId()
  const unknown = await rawReply(profile, {
    op: 'agent.send',
    diagnostic_id: ids.send,
    conversation_id: 'conversation_missing',
    request_id: 'send-missing',
    text: `${transcript} use ${secrets.github}`,
  })
  expect(unknown).toMatchObject({ type: 'error' })
  expect(String(unknown.message).length).toBeGreaterThan(0)
  replies.push(unknown)

  // 3. An oversized request with credentials in it is refused with its reason.
  ids.large = diagnosticId()
  const large = await rawReply(profile, {
    op: 'workspace.open',
    diagnostic_id: ids.large,
    path: `${secrets.anthropic}/${'x'.repeat(200 * 1024)}`,
  })
  expect(large).toMatchObject({ type: 'error', message: 'Request exceeds 128 KiB' })
  replies.push(large)

  // 4. A provider that dies with credentials on stderr: the Conversation fails with a reason.
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  await send(profile, conversationId, `${transcript} deploy with ${secrets.anthropic}`).catch(() => undefined)
  await expect
    .poll(() => conversationStatus(profile, conversationId), { timeout: 20_000 })
    .not.toMatch(/^(starting|ready|running|waiting|idle)$/)
  const failed = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(failed.conversation.error ?? '').toMatch(/Provider connection was lost/)
  replies.push(failed.conversation)

  for (const reply of replies) {
    const text = JSON.stringify(reply)
    for (const secret of Object.values(secrets))
      expect(text, `a reply must not contain ${secret}`).not.toContain(secret)
  }

  // The export correlates each failed request by its diagnostic ID, and holds no planted value.
  const bundle = await profile.call('diagnostics.export', { max_events: 1000 })
  const exported = JSON.stringify(bundle)
  for (const secret of all) expect(exported, `the export must not contain ${secret}`).not.toContain(secret)
  for (const [name, id] of Object.entries(ids)) {
    const events = bundle.events
      .filter((event) => (event as { diagnostic_id?: string }).diagnostic_id === id)
      .map((event) => (event as { event: string }).event)
    expect(events, `the ${name} failure is correlated`).toContain('rpc_failed')
  }
  expect(bundle.excluded.join('\n')).toMatch(/transcripts/)
  // The provider's stderr is accounted for by size, never by content.
  expect(
    bundle.events.some(
      (event) =>
        (event as { event?: string; bytes?: number }).event === 'provider_stderr_drained' &&
        ((event as { bytes?: number }).bytes ?? 0) > 0,
    ),
  ).toBe(true)
  expect(bundle.events.some((event) => (event as { event?: string }).event === 'provider_connection_closed')).toBe(true)

  // The daemon's and runtime's own log files hold no planted value either.
  const logs = await logFiles(profile)
  expect(logs.length).toBeGreaterThan(0)
  for (const file of logs) {
    for (const secret of all) expect(file.text, `${file.name} must not contain ${secret}`).not.toContain(secret)
  }

  // After a daemon crash the same holds for the new daemon's logs and export.
  await profile.restartDaemon('kill')
  const again = JSON.stringify(await profile.call('diagnostics.export', {}))
  for (const secret of all) expect(again).not.toContain(secret)
  for (const file of await logFiles(profile)) {
    for (const secret of all) expect(file.text, `${file.name} must not contain ${secret}`).not.toContain(secret)
  }
})
