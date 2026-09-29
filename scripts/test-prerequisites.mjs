import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

export function executable(command, env) {
  for (const candidate of command.includes('/')
    ? [resolve(command)]
    : (env.PATH ?? '').split(delimiter).map((part) => resolve(part, command))) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Search the remaining PATH entries without launching the candidate.
    }
  }
  return null
}
