// Deterministic process fixtures. Scratch profiles launch Rust-supervised v2
// workers; the Claude worker loads its SDK double through ADE_E2E_CLAUDE_SDK.
// The mock SDK never calls a model or reads a real account.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  /** An unknown Codex native request that remains pending until withdrawn. */
  unsupportedRequest: 'unsupported-request',
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
    // The Claude worker's named SDK seam. A managed-account launch keeps the seam but
    // not this directory: its call log and sessions then live in the account's home.
    ADE_E2E_CLAUDE_SDK: join(repositoryRoot, 'providers/claude/worker-test-sdk.mjs'),
    ADE_CLAUDE_WORKER_TEST_DIR: mockDirectory(profileRoot, 'claude'),
  }
}

export type MockCall = Record<string, unknown> & { pid: number; method: string }

/** Every call a mock has recorded, oldest first; empty before its first call. */
export async function mockCalls(profileRoot: string, provider: MockProvider): Promise<MockCall[]> {
  const log = await readFile(join(mockDirectory(profileRoot, provider), 'calls.jsonl'), 'utf8').catch(() => '')
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MockCall)
}

/** Create the file a scripted mock waits for, such as `release-tool` or `expire-approval`. */
export async function releaseMock(profileRoot: string, provider: MockProvider, name: string): Promise<void> {
  // A marker may be set before the provider first starts and creates its directory.
  await mkdir(mockDirectory(profileRoot, provider), { recursive: true })
  await writeFile(join(mockDirectory(profileRoot, provider), name), '')
}

type ClaudeEntry = { type: string; parent_tool_use_id?: string | null; message?: { content?: unknown } }

/**
 * The prompt a native Claude transcript entry holds, or null for any other entry. The
 * worker sends native content blocks; the prompt is the first text block.
 */
export function claudePrompt(entry: ClaudeEntry): string | null {
  if (entry.type !== 'user' || entry.parent_tool_use_id) return null
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type: string; text?: string }>
  if (blocks.some((block) => block.type === 'tool_result')) return null
  return blocks.find((block) => block.type === 'text')?.text ?? null
}
