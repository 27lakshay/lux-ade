// Deterministic provider fixtures. Every scratch profile launches Codex through
// scripts/fixtures/codex_mock.py and Claude through scripts/fixtures/claude_mock.mjs
// (which serves providers/claude/fake-sdk.mjs). Neither calls a model, reads a
// real account or starts a real provider CLI. The prompt text selects the
// scripted behaviour; each mock appends what it saw to calls.jsonl.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repositoryRoot } from './environment'

export type MockProvider = 'codex' | 'claude'

/** Prompts both mocks script identically. */
export const prompts = {
  /** A plain turn. Codex answers "Hello world"; Claude answers "Hello Claude". */
  turn: 'hello',
  /** One command approval for `echo fixture`, answered with accept or decline. */
  approval: 'approval',
  /** Two free-text questions: "First?" and "Second?". */
  questions: 'questions',
  /** A turn that stays active until it is cancelled. */
  hold: 'hold',
} as const

/** Prompts only the Codex mock scripts. See scripts/fixtures/codex_mock.py for the full list. */
export const codexPrompts = {
  ...prompts,
  /** Approval offering accept, decline and cancel. */
  approvalAll: 'approval-both',
  /** Approval that expires once `release('codex', 'expire-approval')` is called. */
  approvalExpire: 'approval-expire',
  /** Choice, multi-select and secret questions. */
  richQuestions: 'rich-questions',
  /** A tool that runs until `release('codex', 'release-tool')`. */
  heldTool: 'handoff-tool',
  /** A plan update, tool items and subagents as typed items. */
  typedPlan: 'typed-plan',
  typedTool: 'typed-tool',
  typedSubagents: 'typed-subagents',
} as const

/** The text each mock streams for `prompts.turn`. */
export const turnReply: Record<MockProvider, string> = { codex: 'Hello world', claude: 'Hello Claude' }

/** Where each mock keeps its call log and release files for one profile. */
export function mockDirectory(profileRoot: string, provider: MockProvider): string {
  return join(profileRoot, 'providers', provider)
}

/** Daemon environment that routes both providers to their mocks. */
export function providerEnvironment(profileRoot: string): Record<string, string> {
  return {
    ADE_CODEX_BIN: join(repositoryRoot, 'scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mockDirectory(profileRoot, 'codex'),
    ADE_CLAUDE_BRIDGE_BIN: join(repositoryRoot, 'scripts/fixtures/claude_mock.mjs'),
    ADE_MOCK_CLAUDE_DIR: mockDirectory(profileRoot, 'claude'),
  }
}

export type MockCall = Record<string, unknown> & { pid: number; method: string }

/** Every call a mock has recorded, oldest first; empty before its first call. */
export async function mockCalls(profileRoot: string, provider: MockProvider): Promise<MockCall[]> {
  const log = await readFile(join(mockDirectory(profileRoot, provider), 'calls.jsonl'), 'utf8').catch(() => '')
  return log.split('\n').filter(Boolean).map((line) => JSON.parse(line) as MockCall)
}

/** Create the file a scripted mock waits for, such as `release-tool` or `expire-approval`. */
export async function releaseMock(profileRoot: string, provider: MockProvider, name: string): Promise<void> {
  await writeFile(join(mockDirectory(profileRoot, provider), name), '')
}
