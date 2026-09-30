import { open, readFile } from 'node:fs/promises'
import {
  call,
  writeThemeExport,
  writeThemePackExport,
  writeGhosttyThemeExport,
  ThemeFileExportError,
} from '@ade/client'
import { CliError, parseWords, positionals, type CommandResult } from '../shared.js'

const WARP_SOURCE_LIMIT = 256 * 1024

async function readWarpSource(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(WARP_SOURCE_LIMIT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > WARP_SOURCE_LIMIT) throw new CliError('invalid_request', 'Warp YAML exceeds 256 KiB.')
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}

export const themesUsage = `  themes list [AFTER_ID]                 Read a page of the profile theme library
  themes ghostty-validate FILE ID NAME MODE
                                        Validate color-only Ghostty text; MODE is light or dark
  themes warp-validate FILE ID
                                        Preview a Warp YAML theme without installing it
  themes ghostty-export ID REVISION [--output PATH] [--overwrite]
                                        Export terminal colors and disclose omissions
  themes pack-export FILE               Serialize a revision-checked pack request as JSON data
                [--output PATH] [--overwrite]
                                        Write the resolved pack atomically with explicit replacement
  themes file-validate FILE             Validate a definition or pack and disclose independent candidates
  themes pack-install FILE ID REVISION [ID REVISION ...]
                                        Install only explicitly named valid pack members
  themes preview FILE                   Resolve a selection draft without applying it
  themes inspect ID                     Read a definition and its retained source
  themes validate FILE                  Validate ADE JSON/JSONC without installing it
  themes install FILE REVISION [FILE REVISION ...]
                                        Atomically install the accepted set; 0 creates an absent ID
  themes rename ID NAME REVISION         Rename a custom definition at its inspected revision
  themes removal ID [AFTER_KEY]          Inspect affected selections and same-mode fallbacks
  themes remove ID REVISION APPEARANCE_REVISION
                                        Remove a custom definition using reviewed revisions
  themes export ID [REVISION]            Serialize a self-contained definition as JSON data
                [--output PATH] [--overwrite]
                                        Write atomically; existing files require --overwrite
`

function revision(value: string): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new CliError('usage', 'Theme revision must be a non-negative safe integer.')
  return parsed
}

export async function runThemesCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'themes') return undefined
  if (action === 'ghostty-export') {
    const parsed = parseWords(rest, ['--output'], ['--overwrite'], 'themes ghostty-export')
    const [id, expected] = positionals(parsed, 2, 'Use themes ghostty-export ID REVISION [--output PATH] [--overwrite]')
    const output = parsed.options['--output']
    const overwrite = parsed.flags.has('--overwrite')
    if (overwrite && !output) throw new CliError('usage', '--overwrite requires --output PATH.')
    const exported = await call(socketPath, 'themes.ghostty.export', {
      id: id!,
      expected_revision: revision(expected!),
    })
    if (!output) return exported
    try {
      return { ...(await writeGhosttyThemeExport(output, exported, overwrite)) }
    } catch (error) {
      if (error instanceof ThemeFileExportError) throw new CliError(error.code, error.message)
      throw error
    }
  }
  if (action === 'ghostty-validate' && rest.length === 4) {
    const mode = rest[3]
    if (mode !== 'light' && mode !== 'dark') throw new CliError('usage', 'Theme mode must be light or dark.')
    return call(socketPath, 'themes.ghostty.validate', {
      source: await readFile(rest[0]!, 'utf8'),
      id: rest[1]!,
      name: rest[2]!,
      mode,
      source_name: rest[0]!,
    })
  }
  if (action === 'warp-validate' && rest.length === 2) {
    return call(socketPath, 'themes.warp.validate', {
      source: await readWarpSource(rest[0]!),
      id: rest[1]!,
      source_name: rest[0]!,
    })
  }
  if (action === 'file-validate' && rest.length === 1) {
    return call(socketPath, 'themes.file.validate', { source: await readFile(rest[0]!, 'utf8') })
  }
  if (action === 'pack-install' && rest.length >= 3 && rest.length <= 33 && rest.length % 2 === 1) {
    const accepted = new Map<string, number>()
    for (let index = 1; index < rest.length; index += 2) {
      const id = rest[index]!
      if (accepted.has(id)) throw new CliError('usage', `Accepted member ${id} repeats.`)
      accepted.set(id, revision(rest[index + 1]!))
    }
    const report = await call(socketPath, 'themes.file.validate', { source: await readFile(rest[0]!, 'utf8') })
    if (!report.container_valid || !report.pack)
      throw new CliError(
        'invalid_request',
        'The source must be a valid ADE theme pack; use themes file-validate for diagnostics.',
      )
    const items = []
    for (const [id, expected_revision] of accepted) {
      const candidate = report.candidates.find((entry) => entry.validation.definition?.id === id)
      if (!candidate?.validation.valid)
        throw new CliError(
          'invalid_request',
          `Accepted member ${id} is missing or invalid; use themes file-validate for diagnostics.`,
        )
      items.push({ source: candidate.source, expected_revision })
    }
    return call(socketPath, 'themes.install', { items })
  }
  if (action === 'pack-export') {
    const parsed = parseWords(rest, ['--output'], ['--overwrite'], 'themes pack-export')
    const [file] = positionals(parsed, 1, 'Use themes pack-export FILE [--output PATH] [--overwrite]')
    const output = parsed.options['--output']
    const overwrite = parsed.flags.has('--overwrite')
    if (overwrite && !output) throw new CliError('usage', '--overwrite requires --output PATH.')
    const exported = await call(socketPath, 'themes.pack.export', JSON.parse(await readFile(file!, 'utf8')))
    if (!output) return exported
    try {
      return { ...(await writeThemePackExport(output, exported, overwrite)) }
    } catch (error) {
      if (error instanceof ThemeFileExportError) throw new CliError(error.code, error.message)
      throw error
    }
  }
  if (action === 'removal' && (rest.length === 1 || rest.length === 2)) {
    return call(socketPath, 'themes.removal', { id: rest[0]!, after_key: rest[1] ?? null })
  }
  if (action === 'remove' && rest.length === 3) {
    return call(socketPath, 'themes.remove', {
      id: rest[0]!,
      expected_revision: revision(rest[1]!),
      expected_appearance_revision: revision(rest[2]!),
    })
  }
  if (action === 'preview' && rest.length === 1) {
    const input = JSON.parse(await readFile(rest[0]!, 'utf8'))
    return call(socketPath, 'themes.preview', input)
  }
  if (action === 'list' && rest.length <= 1) return call(socketPath, 'themes.list', { after_id: rest[0] ?? null })
  if (action === 'inspect' && rest.length === 1) return call(socketPath, 'themes.inspect', { id: rest[0]! })
  if (action === 'export') {
    const words = [...rest]
    const id = words.shift()
    const expected = words[0] && !words[0].startsWith('--') ? revision(words.shift()!) : null
    let output: string | undefined
    let overwrite = false
    while (words.length) {
      const option = words.shift()
      if (option === '--output' && output === undefined && words[0] && !words[0].startsWith('--'))
        output = words.shift()
      else if (option === '--overwrite' && !overwrite) overwrite = true
      else throw new CliError('usage', 'Use themes export ID [REVISION] [--output PATH] [--overwrite].')
    }
    if (!id || id.startsWith('--') || (overwrite && !output))
      throw new CliError('usage', 'Use themes export ID [REVISION] [--output PATH] [--overwrite].')
    const exported = await call(socketPath, 'themes.export', { id, expected_revision: expected })
    if (!output) return exported
    try {
      return { ...(await writeThemeExport(output, exported, overwrite)) }
    } catch (error) {
      if (error instanceof ThemeFileExportError) throw new CliError(error.code, error.message)
      throw error
    }
  }
  if (action === 'rename' && rest.length === 3) {
    return call(socketPath, 'themes.rename', { id: rest[0]!, name: rest[1]!, expected_revision: revision(rest[2]!) })
  }
  if (action === 'validate' && rest.length === 1) {
    return call(socketPath, 'themes.validate', { source: await readFile(rest[0]!, 'utf8') })
  }
  if (action === 'install' && rest.length > 0 && rest.length <= 32 && rest.length % 2 === 0) {
    const items = []
    for (let index = 0; index < rest.length; index += 2) {
      items.push({ source: await readFile(rest[index]!, 'utf8'), expected_revision: revision(rest[index + 1]!) })
    }
    return call(socketPath, 'themes.install', { items })
  }
  throw new CliError(
    'usage',
    'Use themes list, preview FILE, inspect ID, validate FILE, install FILE REVISION, rename ID NAME REVISION, removal ID, remove ID REVISION APPEARANCE_REVISION or export ID [REVISION].',
  )
}
