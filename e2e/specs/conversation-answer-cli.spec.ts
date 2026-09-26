import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

test('CLI answers native approvals and questions once through the running daemon', async () => {
  const mockDirectory = await mkdtemp(join(tmpdir(), 'ade-cli-answer-mock-'))
  const daemon = await startDaemon({
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory,
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    const command = async (...args: string[]): Promise<Record<string, unknown>> => {
      const { stdout } = await execFileAsync(process.execPath, [cli, '--socket', daemon.socket,
        'conversation', 'answer', conversation.id, ...args])
      return JSON.parse(stdout) as Record<string, unknown>
    }
    let sendNumber = 0
    const requestFor = async (prompt: string): Promise<{ id: string; method: string; params: Record<string, unknown> }> => {
      await expect.poll(async () => {
        const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
        return ['idle', 'ready'].includes((snapshot.conversation as { status: string }).status)
      }).toBe(true)
      await rpc(daemon.socket, { op: 'agent.send', conversation_id: conversation.id,
        request_id: `send-${prompt}-${++sendNumber}`, text: prompt })
      let pending: { id: string; method: string; params: Record<string, unknown> } | undefined
      await expect.poll(async () => {
        const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
        pending = (snapshot.requests as Array<typeof pending>)[0]
        return pending?.method
      }).toBe(prompt === 'rich-questions' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval')
      if (!pending) throw new Error('The native request disappeared before it could be answered')
      return pending
    }
    const replies = async (): Promise<Array<{ method: string; request_method: string; result: Record<string, unknown> }>> =>
      (await readFile(join(mockDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; request_method: string; result: Record<string, unknown> })
        .filter((call) => call.method === 'approval/reply')

    const approval = await requestFor('approval')
    expect(approval.params.command).toBe('echo fixture')
    expect(await command(approval.id, 'decline')).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await replies()).length).toBe(1)
    expect((await replies())[0].result).toEqual({ decision: 'decline' })
    await expect(command(approval.id, 'accept')).rejects.toThrow(/conflicts with the recorded decision/)
    expect(await command(approval.id, 'decline')).toMatchObject({ type: 'ack' })
    expect(await replies()).toHaveLength(1)

    const questions = await requestFor('rich-questions')
    expect(questions.params.questions).toMatchObject([
      { id: 'choice', question: 'Choose a mode' },
      { id: 'multiple', question: 'Choose features', multiSelect: true },
      { id: 'secret', question: 'Fixture secret', isSecret: true },
    ])
    const answers = { choice: 'Thorough', multiple: ['Read, write'], secret: 'fixture answer' }
    expect(await command(questions.id, 'answer', JSON.stringify(answers))).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await replies()).length).toBe(2)
    expect((await replies())[1].result).toEqual({ answers: {
      choice: { answers: ['Thorough'] }, multiple: { answers: ['Read, write'] },
      secret: { answers: ['fixture answer'] },
    } })
    expect(await command(questions.id, 'answer', JSON.stringify(answers))).toMatchObject({ type: 'ack' })
    expect(await replies()).toHaveLength(2)

    const accepted = await requestFor('approval')
    expect(await command(accepted.id, 'accept')).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await replies()).length).toBe(3)
    expect((await replies())[2].result).toEqual({ decision: 'accept' })

    const cancelOnly = await requestFor('approval-cancel')
    expect(cancelOnly.params.availableDecisions).toEqual(['accept', 'cancel'])
    await expect(command(cancelOnly.id, 'decline')).rejects.toThrow(/Decision is not offered by Codex/)
    expect(await command(cancelOnly.id, 'cancel')).toMatchObject({ type: 'ack' })
    await expect.poll(async () => (await replies()).length).toBe(4)
    expect((await replies())[3].result).toEqual({ decision: 'cancel' })
    expect(await command(cancelOnly.id, 'cancel')).toMatchObject({ type: 'ack' })
    await expect(command(cancelOnly.id, 'accept')).rejects.toThrow(/conflicts with the recorded decision/)

    await expect(command(questions.id, 'answer', '{"choice":4}')).rejects.toThrow(/values must be text/)
    await expect(command(questions.id, 'accept', '{}')).rejects.toThrow(/required only for/)
    await expect(command(questions.id, 'maybe')).rejects.toThrow(/must be accept, decline, cancel, or answer/)
    expect(await replies()).toHaveLength(4)
  } finally {
    await daemon.stop()
    await rm(mockDirectory, { recursive: true, force: true })
  }
})
