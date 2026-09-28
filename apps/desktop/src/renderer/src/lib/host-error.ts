/** The message of an error from main, without Electron's "Error invoking remote method" prefix. */
export const hostErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  )
