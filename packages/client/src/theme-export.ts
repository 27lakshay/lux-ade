import { randomUUID, createHash } from 'node:crypto'
import { link, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ThemeExport, ThemePackExport, GhosttyThemeExport, GhosttyExportOmission } from '@ade/contracts'

export interface ThemeFileExport {
  type: 'theme_file_export'
  path: string
  theme_id: string
  revision: number
  bytes: number
  sha256: string
}

export interface ThemePackFileExport {
  type: 'theme_pack_file_export'
  path: string
  pack_id: string
  revisions: Record<string, number>
  bytes: number
  sha256: string
}

export interface GhosttyThemeFileExport extends Omit<ThemeFileExport, 'type'> {
  type: 'ghostty_theme_file_export'
  omissions: GhosttyExportOmission[]
}

export async function writeGhosttyThemeExport(
  output: string,
  exported: GhosttyThemeExport,
  overwrite = false,
): Promise<GhosttyThemeFileExport> {
  return {
    ...(await publishThemeSource(output, exported.source, overwrite)),
    type: 'ghostty_theme_file_export',
    theme_id: exported.theme.id,
    revision: exported.theme.revision,
    omissions: exported.omissions,
  }
}

export class ThemeFileExportError extends Error {
  constructor(
    public readonly code: 'conflict' | 'unavailable',
    message: string,
    cause: unknown,
  ) {
    super(message, { cause })
  }
}

/** Host action after daemon serialization. A new target is exclusive; replacement needs explicit consent. */
export async function writeThemeExport(
  output: string,
  exported: ThemeExport,
  overwrite = false,
): Promise<ThemeFileExport> {
  return {
    ...(await publishThemeSource(output, exported.source, overwrite)),
    type: 'theme_file_export',
    theme_id: exported.theme.id,
    revision: exported.theme.revision,
  }
}

/** Publish a daemon-resolved pack using the same explicit replacement rules as a definition. */
export async function writeThemePackExport(
  output: string,
  exported: ThemePackExport,
  overwrite = false,
): Promise<ThemePackFileExport> {
  return {
    ...(await publishThemeSource(output, exported.source, overwrite)),
    type: 'theme_pack_file_export',
    pack_id: exported.pack.id,
    revisions: Object.fromEntries(exported.themes.map((theme) => [theme.id, theme.revision])),
  }
}

async function publishThemeSource(output: string, text: string, overwrite: boolean) {
  const target = resolve(output)
  const temporary = join(dirname(target), `.ade-theme-${randomUUID()}.tmp`)
  // Preserve the bounded serialization exactly; a trailing byte can invalidate a maximum-size definition.
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    // Both publication operations are on the same filesystem. link never replaces a target that appeared meanwhile.
    if (overwrite) await rename(temporary, target)
    else await link(temporary, target)
    return {
      path: target,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ThemeFileExportError(
        'conflict',
        'The output path already exists; confirm overwrite before exporting.',
        error,
      )
    throw new ThemeFileExportError(
      'unavailable',
      `Theme file export failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}
