import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// SDK forks remap transcript UUIDs. Preserve ADE row IDs, never native turn IDs.
function aliasFile(session) {
  if (!process.env.ADE_DATA_DIR || !/^[a-zA-Z0-9_-]{1,128}$/.test(session)) return null
  return join(process.env.ADE_DATA_DIR, 'claude-forks', session + '.json')
}
export function loadAliases(session) {
  const file = aliasFile(session)
  if (!file) return new Map()
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')).aliases))
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw new Error('Claude identity record is unreadable: ' + error.message)
  }
}
export function saveAliases(session, forked_from, aliases) {
  const file = aliasFile(session)
  if (!file) return
  if (forked_from === null) {
    try {
      forked_from = JSON.parse(readFileSync(file, 'utf8')).forked_from ?? null
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify({ forked_from, aliases: Object.fromEntries(aliases) }))
  renameSync(file + '.tmp', file)
}
