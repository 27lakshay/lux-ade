import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourcePath = resolve(root, 'protocol/daily-use.json')
const targetPath = resolve(root, 'packages/client/src/generated.ts')
const source = await readFile(sourcePath, 'utf8')
const contract = JSON.parse(source)
if (contract.version !== 1 || !contract.definitions || !contract.operations || !contract.feed) {
  throw new Error('Unsupported daily-use contract')
}

function tsType(spec) {
  if (spec === 'string') return 'string'
  if (spec === 'integer') return 'number'
  if (spec === 'boolean') return 'boolean'
  if (spec === 'unknown') return 'unknown'
  if (spec.ref) return `Wire${spec.ref}`
  if (spec.literal !== undefined) return JSON.stringify(spec.literal)
  if (spec.array) return `Array<${tsType(spec.array)}>`
  if (spec.nullable) return `${tsType(spec.nullable)} | null`
  if (spec.optional) return tsType(spec.optional)
  if (spec.fields) {
    const fields = Object.entries(spec.fields).map(([key, value]) => {
      const optional = typeof value === 'object' && 'optional' in value
      return `  ${JSON.stringify(key)}${optional ? '?' : ''}: ${tsType(value)};`
    })
    if (spec.additional) fields.push('  [key: string]: unknown;')
    return `{\n${fields.join('\n')}\n}`
  }
  throw new Error(`Unknown contract spec: ${JSON.stringify(spec)}`)
}

const operations = Object.keys(contract.operations)
const feedKinds = Object.keys(contract.feed)
const declarations = Object.entries(contract.definitions).map(([name, spec]) => `export type Wire${name} = ${tsType(spec)}\n`)
const operationTypes = operations.flatMap((op) => {
  const name = op.split('.').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
  return [
    `export type ${name}Request = ${tsType(contract.operations[op].request)}\n`,
    `export type ${name}Response = ${tsType(contract.operations[op].response)}\n`,
  ]
})
const feedTypes = feedKinds.map((kind) => {
  const name = kind.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
  return `export type ${name}FeedFrame = ${tsType(contract.feed[kind])}\n`
})
const requestMap = operations.map((op) => {
  const name = op.split('.').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
  return `  ${JSON.stringify(op)}: ${name}Request;`
})
const responseMap = operations.map((op) => {
  const name = op.split('.').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
  return `  ${JSON.stringify(op)}: ${name}Response;`
})
const output = `// Generated from protocol/daily-use.json by scripts/generate-client-contract.mjs. Do not edit.\n\n${[...declarations, ...operationTypes, ...feedTypes].join('\n')}\nexport type DailyUseOperation = ${operations.map((op) => JSON.stringify(op)).join(' | ')}\n\nexport interface DailyUseRequestByOperation {\n${requestMap.join('\n')}\n}\n\nexport interface DailyUseResponseByOperation {\n${responseMap.join('\n')}\n}\n\nexport type DailyUseRequest<O extends DailyUseOperation = DailyUseOperation> = DailyUseRequestByOperation[O]\nexport type DailyUseResponse<O extends DailyUseOperation = DailyUseOperation> = DailyUseResponseByOperation[O]\nexport type DailyUseFeedFrame = ${feedKinds.map((kind) => `${kind.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}FeedFrame`).join(' | ')}\n\ntype Spec = string | { ref: string } | { literal: unknown } | { array: Spec } | { nullable: Spec } | { optional: Spec } | { fields: Record<string, Spec>; additional?: boolean }\n\nconst contract: { version: number; definitions: Record<string, Spec>; operations: Record<string, { request: Spec; response: Spec }>; feed: Record<string, Spec> } = ${JSON.stringify(contract)}\n\nfunction record(value: unknown): value is Record<string, unknown> {\n  return value !== null && typeof value === 'object' && !Array.isArray(value)\n}\n\nfunction validate(spec: Spec, value: unknown, at: string): void {\n  if (typeof spec === 'string') {\n    const valid = spec === 'unknown' || (spec === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : typeof value === spec)\n    if (!valid) throw new TypeError(\`Invalid daily-use frame at \${at}: expected \${spec}\`)\n    return\n  }\n  if ('ref' in spec) return validate(contract.definitions[spec.ref], value, at)\n  if ('literal' in spec) {\n    if (value !== spec.literal) throw new TypeError(\`Invalid daily-use frame at \${at}: expected \${JSON.stringify(spec.literal)}\`)\n    return\n  }\n  if ('array' in spec) {\n    if (!Array.isArray(value)) throw new TypeError(\`Invalid daily-use frame at \${at}: expected array\`)\n    value.forEach((item, index) => validate(spec.array, item, \`\${at}[\${index}]\`))\n    return\n  }\n  if ('nullable' in spec) {\n    if (value !== null) validate(spec.nullable, value, at)\n    return\n  }\n  if ('optional' in spec) {\n    if (value !== undefined) validate(spec.optional, value, at)\n    return\n  }\n  if (!record(value)) throw new TypeError(\`Invalid daily-use frame at \${at}: expected object\`)\n  for (const [key, field] of Object.entries(spec.fields)) {\n    if (!(key in value) && !(typeof field === 'object' && 'optional' in field)) {\n      throw new TypeError(\`Invalid daily-use frame at \${at}.\${key}: missing field\`)\n    }\n    validate(field, value[key], \`\${at}.\${key}\`)\n  }\n  if (!spec.additional) {\n    for (const key of Object.keys(value)) {\n      if (!(key in spec.fields)) throw new TypeError(\`Invalid daily-use frame at \${at}.\${key}: unexpected field\`)\n    }\n  }\n}\n\nexport function decodeDailyUseRequest(value: unknown): DailyUseRequest {\n  if (!record(value) || typeof value.op !== 'string' || !Object.hasOwn(contract.operations, value.op)) {\n    throw new TypeError('Invalid daily-use request operation')\n  }\n  validate(contract.operations[value.op].request, value, 'request')\n  return value as DailyUseRequest\n}\n\nexport function decodeDailyUseResponse<O extends DailyUseOperation>(op: O, value: unknown): DailyUseResponse<O> {\n  validate(contract.operations[op].response, value, 'response')\n  return value as DailyUseResponse<O>\n}\n\nexport function decodeDailyUseFeedFrame(value: unknown): DailyUseFeedFrame {\n  if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(contract.feed, value.type)) {\n    throw new TypeError('Invalid daily-use feed frame type')\n  }\n  validate(contract.feed[value.type], value, 'feed')\n  return value as DailyUseFeedFrame\n}\n`

if (process.argv.includes('--check')) {
  const existing = await readFile(targetPath, 'utf8').catch(() => '')
  if (existing !== output) {
    console.error('Generated daily-use client contract is stale; run pnpm --filter @ade/client generate:contract')
    process.exitCode = 1
  }
} else {
  await writeFile(targetPath, output)
}
