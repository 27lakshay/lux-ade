import { createHash } from 'node:crypto'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, type CommandResult } from '../shared.js'

export const diagnosticsUsage = `  diagnostics status                    Report queues, drops, receipts, live runs, claims and unknown execution
  diagnostics export [--output PATH] [--events N]
                                        Build a bounded, redacted bundle; --output writes a new private file
`

function eventCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 1000) {
    throw new CliError('usage', '--events must be an integer from 0 to 1000.')
  }
  return number
}

/** Writes the bundle to a new file readable only by this user; never overwrites. */
async function writeBundle(path: string, text: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError('conflict', 'The output path already exists; diagnostics export never overwrites a file.')
    }
    throw new CliError('unavailable', `Cannot create the output file: ${(error as Error).message}`)
  }
  try {
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    // A partial bundle must not look like a finished export.
    await rm(path, { force: true }).catch(() => undefined)
    throw new CliError('unavailable', `Writing the diagnostics bundle failed: ${(error as Error).message}`)
  }
}

export async function runDiagnosticsCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'diagnostics') return undefined
  if (action === 'status') {
    if (rest.length) throw new CliError('usage', 'diagnostics status does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'diagnostics.status' })
  }
  if (action === 'export') {
    const options = namedOptions(rest, ['--output', '--events'], 'diagnostics export')
    const maxEvents = eventCount(options['--events'])
    const bundle = await dailyUseCommand<'diagnostics.export'>(socketPath, {
      op: 'diagnostics.export',
      ...(maxEvents === undefined ? {} : { max_events: maxEvents }),
    })
    const output = options['--output']
    if (output === undefined) return bundle
    const path = resolve(output)
    const text = `${JSON.stringify(bundle, null, 2)}\n`
    await writeBundle(path, text)
    return {
      type: 'diagnostics_exported',
      path,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      events: bundle.events.length,
      events_truncated: bundle.events_truncated,
      redaction: bundle.redaction,
    }
  }
  return undefined
}
