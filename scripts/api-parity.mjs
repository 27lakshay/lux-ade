// API parity gate (F101-F103). Every operation in packages/contracts must be
// reachable from a named CLI command and through the typed @ade/client `call`,
// or carry a written exemption. check:static runs it; `--table` prints the
// parity table as Markdown for the evidence file.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Operations with no named CLI command, and why. Each stays reachable through
 * `ade request OP JSON` unless its reason says otherwise.
 */
export const cliExemptions = {
  'session.subscribe':
    'A stream: `ade request` returns its first catalog frame; AdeClient.subscribeFeed follows the feed',
  'settings.appearance.observe':
    'Only the registered local desktop owner reports sequenced OS observations; user mode changes use settings set',
  'themes.draft.preview': 'Transient preview of a local unsaved definition; generic `ade request` remains available',
  'browser.owner.register': 'Only the Electron main process registers itself as the browser owner',
  'browser.owner.unregister': 'Only the Electron main process unregisters itself as the browser owner',
  'notification.delivery.claim': 'Called by a notification-showing client (the desktop) for its own delivery channel',
  'notification.delivery.report': 'Called by a notification-showing client (the desktop) for its own delivery channel',
  'draft.send.get': 'Desktop window send-intent recovery (the SDK SendPipeline)',
  'draft.send.prepare': 'Desktop window send-intent recovery (the SDK SendPipeline)',
  'draft.send.complete': 'Desktop window send-intent recovery (the SDK SendPipeline)',
  'draft.send.abort': 'Desktop window send-intent recovery',
  'draft.send.list': 'Desktop window send-intent recovery',
  'draft.send.acknowledge': 'Desktop window send-intent recovery',
  'attachment.put': 'Carries base64 bytes for clients on another host; the local CLI uses `attachment import`',
  'conversation.export':
    '`conversation export ID FILE` reads it page by page through the SDK writer (@ade/client/export), shared with the desktop',
  'agent.list': 'Runtime socket only, with the daemon owner token; not served on the profile command socket',
  'agent.account_inspect': 'Runtime socket only, with the daemon owner token; not served on the profile command socket',
  'service.proxy.target': 'Asked by the runtime proxy before it forwards one connection',
}

// A literal in an operation position: `op: '…'`, or the second argument of a request helper.
const OP_SITE =
  /(?:\bop:\s*|\b(?:requestDaemon|call|serviceRequest|dailyUseCommand|decodeReply|decodeDailyUseResponse)(?:<[^>]*>)?\([^,()]+,\s*)(['"])([^'"\n]+)\1/g
const LITERAL = /(['"`])([a-z_]+(?:\.[a-z_]+)*)\1/g
// A template literal that builds an operation name, such as `agent.${action}`.
const DYNAMIC = /`[a-z_]+(?:\.[a-z_]+)*\.\$\{/g

/**
 * Decide parity. `operations` maps each name to its spec; `cliSources` maps a
 * CLI source path to its text; `validators` is the set of generated validator
 * names; `genericModule` is the CLI path of the generic `request` command.
 */
export function computeParity({ operations, cliSources, validators, exemptions, genericModule }) {
  const failures = []
  const names = new Set(Object.keys(operations))
  const commands = new Map([...names].map((name) => [name, new Set()]))
  for (const [path, source] of Object.entries(cliSources)) {
    for (const match of source.matchAll(DYNAMIC)) {
      failures.push(`${path}: builds an operation name dynamically (${match[0]}…); name each operation literally`)
    }
    for (const match of source.matchAll(OP_SITE)) {
      if (!names.has(match[2])) failures.push(`${path}: '${match[2]}' is not an operation in packages/contracts`)
    }
    if (path === genericModule) continue
    for (const match of source.matchAll(LITERAL)) {
      if (names.has(match[2])) commands.get(match[2]).add(path)
    }
  }
  for (const [name, reason] of Object.entries(exemptions)) {
    if (!names.has(name)) failures.push(`exemption ${name} names no operation; remove it`)
    else if (commands.get(name).size)
      failures.push(`exemption ${name} is stale: ${[...commands.get(name)].join(', ')} exposes it`)
    else if (!reason) failures.push(`exemption ${name} needs a reason`)
  }
  const rows = [...names].sort().map((name) => {
    const spec = operations[name]
    const sdk = validators.has(spec.request) && validators.has(spec.response)
    if (!sdk)
      failures.push(
        `${name}: no generated validator for ${spec.request} or ${spec.response}; @ade/client call cannot check it`,
      )
    const cli = [...commands.get(name)].sort()
    if (!cli.length && !Object.hasOwn(exemptions, name)) {
      failures.push(
        `${name}: no CLI command exposes it; add one in apps/cli/src/commands or an exemption with a reason`,
      )
    }
    return { name, domain: spec.domain, tier: spec.tier, cli, exemption: exemptions[name] ?? null, sdk }
  })
  return { rows, failures }
}

/** The SDK must stay free of React and Electron (F103). */
export function sdkIndependence(packageJson, sources) {
  const failures = []
  const forbidden = /^(react|react-dom|electron)(\/|$)/
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(packageJson[field] ?? {})) {
      if (forbidden.test(name)) failures.push(`@ade/client ${field} includes ${name}`)
    }
  }
  for (const [path, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g)) {
      if (forbidden.test(match[1] ?? match[2])) failures.push(`${path} imports ${match[1] ?? match[2]}`)
    }
  }
  return failures
}

function markdownTable(rows) {
  const lines = ['| Operation | Domain | Tier | CLI | SDK `call` |', '|---|---|---|---|---|']
  for (const row of rows) {
    const cli = row.cli.length
      ? row.cli.map((path) => path.replace(/^apps\/cli\/src\/(commands\/)?/, '')).join(', ')
      : `exempt: ${row.exemption}`
    lines.push(`| \`${row.name}\` | ${row.domain} | ${row.tier} | ${cli} | ${row.sdk ? 'yes' : 'NO'} |`)
  }
  return `${lines.join('\n')}\n`
}

function sourceFiles(root, directory) {
  const found = {}
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    const path = join(entry.parentPath, entry.name)
    found[relative(root, path)] = readFileSync(path, 'utf8')
  }
  return found
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const bundle = JSON.parse(readFileSync(join(root, 'packages/contracts/schema/contracts.json'), 'utf8'))
  const operations = Object.fromEntries(bundle.operations.map((operation) => [operation.name, operation]))
  const validatorSource = readFileSync(join(root, 'packages/contracts/src/generated/validators.js'), 'utf8')
  const validators = new Set([...validatorSource.matchAll(/export const (\w+)\s*=/g)].map((match) => match[1]))
  const { rows, failures } = computeParity({
    operations,
    validators,
    exemptions: cliExemptions,
    cliSources: sourceFiles(root, join(root, 'apps/cli/src')),
    genericModule: 'apps/cli/src/commands/request.ts',
  })
  const clientRoot = join(root, 'packages/client')
  failures.push(
    ...sdkIndependence(
      JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')),
      sourceFiles(root, join(clientRoot, 'src')),
    ),
  )
  const index = readFileSync(join(clientRoot, 'src/index.ts'), 'utf8')
  if (!/export \{[^}]*\bcall\b[^}]*\} from '\.\/call\.js'/.test(index))
    failures.push('@ade/client does not export call')
  if (process.argv.includes('--table')) process.stdout.write(markdownTable(rows))
  if (failures.length) {
    console.error(`API parity failed:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  const exempt = rows.filter((row) => !row.cli.length).length
  console.error(
    `API parity: ${rows.length} operations; ${rows.length - exempt} with a CLI command, ${exempt} exempt; all callable through @ade/client call`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
