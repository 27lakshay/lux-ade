import { spawnSync } from 'node:child_process'

/** Include both sides of renames and each source of local changes independently. */
export function changedFiles(root, base) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
    return result.stdout
  }
  if (!base) return { files: [], fallback: 'No base was supplied' }
  try {
    const revision = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
    const lists = [
      git(['diff', '--name-only', '-z', '--no-renames', revision, 'HEAD', '--']),
      git(['diff', '--name-only', '-z', '--no-renames', '--cached', '--']),
      git(['diff', '--name-only', '-z', '--no-renames', '--']),
      git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]
    return { files: [...new Set(lists.flatMap((list) => list.split('\0')).filter(Boolean))].sort(), base: revision }
  } catch (error) {
    return { files: [], fallback: `Base or working changes could not be read: ${error.message}` }
  }
}

export function affectedSelection(changes) {
  const reasons = new Map()
  const add = (suites, reason) => {
    for (const suite of suites) {
      if (!reasons.has(suite)) reasons.set(suite, [])
      reasons.get(suite).push(reason)
    }
  }
  const broad = (reason) => add(['static', 'protocol', 'desktop'], reason)
  if (changes.fallback) broad(changes.fallback)
  for (const file of changes.files) {
    // Every change retains the repository's required static gate. This includes
    // generation/parity, all in-process Rust tests, providers and browser tests.
    add(['static'], `${file}: repository static gate`)
    if (file.endsWith('.md') && /^(docs\/|\.scratch\/|README\.md$|CONTEXT\.md$|THIRD-PARTY-NOTICES\.md$)/.test(file))
      continue
    if (/^(crates\/|packages\/contracts\/|packages\/client\/|apps\/cli\/|providers\/)/.test(file)) {
      broad(`${file}: shared backend, contract, SDK or provider consumers and recovery`)
    } else if (file.startsWith('apps/desktop/')) {
      add(['desktop'], `${file}: renderer or Electron consumer and host boundary`)
    } else if (file.startsWith('e2e/desktop/')) {
      add(['desktop'], `${file}: desktop acceptance or shared desktop fixture`)
    } else if (file.startsWith('e2e/protocol/')) {
      broad(`${file}: protocol acceptance or shared process fixture`)
    } else {
      broad(`${file}: shared configuration, runner input or unsupported relationship`)
    }
  }
  if (!reasons.size) add(['static'], 'No changed paths found; retain the required static gate')
  return {
    scope: 'Development selection. Full acceptance remains required for integration.',
    base: changes.base ?? null,
    files: changes.files,
    suites: ['static', 'protocol', 'desktop']
      .filter((suite) => reasons.has(suite))
      .map((suite) => ({ suite, reasons: reasons.get(suite) })),
  }
}
