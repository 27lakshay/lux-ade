// Generate packages/contracts from the Rust contract authority (D02).
//
// The ade-contracts binary prints the JSON Schema bundle. This script commits
// that bundle, TypeScript types from json-schema-to-typescript and Ajv
// standalone validators. With --check it writes nothing and fails when any
// committed file differs from a fresh generation.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import standaloneCode from 'ajv/dist/standalone/index.js'
import { compile } from 'json-schema-to-typescript'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = resolve(root, 'packages/contracts')

const cargo = spawnSync(
  'node',
  ['scripts/cargo.mjs', 'run', '--locked', '--quiet', '-p', 'ade-core', '--bin', 'ade-contracts'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
)
if (cargo.status !== 0) {
  console.error('ade-contracts failed; the Rust contracts do not build')
  process.exit(cargo.status ?? 1)
}
const bundle = JSON.parse(cargo.stdout)
const { operations, frames } = bundle
const terminalFrames = bundle.streams.terminal
const definitions = bundle.$defs
const banner =
  '// Generated from the Rust contracts in crates/ade-core/src/contract by scripts/generate-contracts.mjs. Do not edit.'
const quote = (value) => JSON.stringify(value)

const schemaFile = `${JSON.stringify(bundle, null, 2)}\n`

// A schema that only annotates (serde_json::Value in Rust) accepts any JSON.
// json-schema-to-typescript would read it as an object, so mark it unknown.
const shapeKeywords = ['type', '$ref', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', 'properties', 'items']
function unknownValue(schema) {
  if (schema === null || typeof schema !== 'object') return schema
  return shapeKeywords.some((keyword) => keyword in schema) ? schema : { ...schema, tsType: 'unknown' }
}
function unknownDefinitions(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, schema]) => [
      name,
      {
        ...schema,
        ...(schema.properties
          ? {
              properties: Object.fromEntries(
                Object.entries(schema.properties).map(([key, value]) => [key, unknownValue(value)]),
              ),
            }
          : {}),
      },
    ]),
  )
}

// One root that references every definition, so each becomes a named type.
const typeRoot = {
  $defs: unknownDefinitions(definitions),
  title: 'ContractDefinition',
  anyOf: Object.keys(definitions).map((name) => ({ $ref: `#/$defs/${name}` })),
}
const types = await compile(typeRoot, 'ContractDefinition', {
  bannerComment: banner,
  additionalProperties: true,
  unknownAny: true,
  style: { singleQuote: true, semi: false, printWidth: 120 },
})
const operationNames = operations.map((operation) => operation.name)
const typesFile = `${types}
export type Operation = ${operationNames.map(quote).join(' | ')}

export interface RequestByOperation {
${operations.map((operation) => `  ${quote(operation.name)}: ${operation.request}`).join('\n')}
}

export interface ResponseByOperation {
${operations.map((operation) => `  ${quote(operation.name)}: ${operation.response}`).join('\n')}
}

export type FeedFrame = ${frames.map((frame) => frame.frame).join(' | ')}

export type TerminalStreamFrame = ${terminalFrames.map((frame) => frame.frame).join(' | ')}
`

const operationIdOperations = operations
  .filter(
    (operation) =>
      operation.tier === 'effect_command' && definitions[operation.request]?.required?.includes('operation_id'),
  )
  .map((operation) => operation.name)

const tableFile = `${banner}

/** Each operation's tier and domain, and the validator names for its request and response. */
export const operations = {
${operations.map((operation) => `  ${quote(operation.name)}: { tier: ${quote(operation.tier)}, domain: ${quote(operation.domain)}, request: ${quote(operation.request)}, response: ${quote(operation.response)} },`).join('\n')}
} as const

/**
 * The effect commands whose request requires a caller-supplied \`operation_id\`.
 * The SDK fills a fresh one when a caller leaves it out.
 */
export const operationIdOperations = [
${operationIdOperations.map((name) => `  ${quote(name)},`).join('\n')}
] as const

/** Each feed frame's \`type\` tag and the validator name for it. */
export const frames = {
${frames.map((frame) => `  ${quote(frame.type)}: { domain: ${quote(frame.domain)}, frame: ${quote(frame.frame)} },`).join('\n')}
} as const

/** Each terminal attachment frame's \`type\` tag and the validator name for it. */
export const terminalFrames = {
${terminalFrames.map((frame) => `  ${quote(frame.type)}: { frame: ${quote(frame.frame)} },`).join('\n')}
} as const
`

const ajv = new Ajv2020({ code: { source: true, esm: true }, strict: true, allErrors: false })
ajv.addSchema({ $id: bundle.$id, $defs: definitions })
const exported = [
  ...new Set([
    ...operations.flatMap((operation) => [operation.request, operation.response]),
    ...frames.map((frame) => frame.frame),
    ...terminalFrames.map((frame) => frame.frame),
    'ProviderWorkerFailure',
    'ProviderWorkerInitialize',
    'ProviderWorkerRequest',
    'ProviderWorkerResponse',
    'ProviderWorkerOpenRequest',
    'ProviderWorkerSendRequest',
    'ProviderWorkerSendResult',
    'ProviderWorkerEventNotification',
    'ProviderWorkerHistoryRequest',
    'ProviderWorkerHistoryPage',
    'Connected',
    'ProviderWorkerSteerRequest',
    'ProviderWorkerCancelRequest',
    'ProviderWorkerAnswerRequest',
    'ProviderWorkerCompactRequest',
    'ProviderWorkerRewindRequest',
    'ProviderWorkerRewindResult',
    'ProviderWorkerConfigureMcpRequest',
    'ProviderWorkerChildTranscriptRequest',
    'ProviderWorkerAck',
    'ProviderWorkerCancelResult',
  ]),
].sort()
const validatorCode = standaloneCode(
  ajv,
  Object.fromEntries(exported.map((name) => [name, `${bundle.$id}#/$defs/${name}`])),
)
if (/\brequire\(/.test(validatorCode)) {
  throw new Error('Ajv standalone code needs its runtime; keep the contracts free of keywords that import it')
}
const validatorsFile = `${banner}\n${validatorCode}\n`

const outputs = {
  'schema/contracts.json': schemaFile,
  'src/generated/types.ts': typesFile,
  'src/generated/operations.ts': tableFile,
  'src/generated/validators.js': validatorsFile,
}

const stale = []
for (const [path, content] of Object.entries(outputs)) {
  const target = resolve(packageRoot, path)
  if (process.argv.includes('--check')) {
    let existing = ''
    try {
      existing = readFileSync(target, 'utf8')
    } catch {
      /* missing counts as stale */
    }
    if (existing !== content) stale.push(`packages/contracts/${path}`)
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}
if (stale.length) {
  console.error(`Generated contracts are stale; run pnpm contract:generate:\n  ${stale.join('\n  ')}`)
  process.exit(1)
}
