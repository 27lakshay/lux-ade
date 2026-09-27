// F132: an installed skill bundle is placed where one provider reads skills
// and invoked through that provider's adapter rules. A placement writes only
// an absent path or one the catalog owns and that is unchanged; an external
// skill is never written over. Codex's adapter has no skill input yet, which
// its listing says explicitly.
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, startConversation, test, waitForIdle, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { treeSnapshot } from '../fixtures/tree'

async function writeSkill(directory: string, name: string, description: string,
  extra: Record<string, string> = {}): Promise<void> {
  const files = { 'SKILL.md': `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nGreet $ARGUMENTS.\n`, ...extra }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), content)
  }
}

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

async function install(profile: ScratchProfile, source: string, operationId: string, replace?: string): Promise<string> {
  const reply = await call(profile, 'skill.install', { operation_id: operationId, source_path: source,
    ...(replace ? { replace_content_hash: replace } : {}) })
  return reply.skill.content_hash
}

async function claudePrompts(profile: ScratchProfile): Promise<string[]> {
  return (await profile.mockCalls('claude')).filter((entry) => entry.method === 'send').map((entry) => String(entry.text))
}

async function claudeConversation(profile: ScratchProfile, repo: ScratchRepo): Promise<string> {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'claude',
    provider_config: { setting_sources: ['project'] } })
  return conversation.id
}

test('F132: a placed bundle is invoked through the Claude adapter, replays once, and is replaced only by ADE', async ({ ade, profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const source = join(ade.root, 'sources', 'greet')
  await writeSkill(source, 'greet', 'Greets someone.', { 'scripts/wave.sh': '#!/bin/sh\necho wave\n', 'notes/tone.md': 'Be kind.\n' })
  await chmod(join(source, 'scripts/wave.sh'), 0o755)
  const hash = await install(profile, source, 'install-greet')
  // The catalog holds the bundle; the source can go away before placement.
  await rm(source, { recursive: true })

  const conversationId = await claudeConversation(profile, repo)
  const before = (await profile.call('command.list', { conversation_id: conversationId })).entries.find((entry) => entry.name === 'greet')
  expect(before).toMatchObject({ invocable: false, provenance: { source: 'ade_catalog' },
    reason: expect.stringContaining('skill.place') })

  const place = { operation_id: 'place-greet', name: 'greet', expected_content_hash: hash, provider: 'claude',
    scope: 'workspace', workspace_id: workspace.id }
  const placed = await call(profile, 'skill.place', place)
  const target = join(repo.path, '.claude/skills/greet')
  expect(placed).toMatchObject({ type: 'skill_placed', outcome: 'created', path: target, content_hash: hash,
    provider: 'claude', scope: 'workspace', workspace_id: workspace.id })
  // The complete bundle, byte for byte, with its executable bit.
  expect(await readFile(join(target, 'notes/tone.md'), 'utf8')).toBe('Be kind.\n')
  expect((await stat(join(target, 'scripts/wave.sh'))).mode & 0o111).not.toBe(0)
  expect((await call(profile, 'skill.inspect', { name: 'greet', workspace_id: workspace.id })).projection
    .find((entry: any) => entry.path === target)).toMatchObject({ observed: 'adopted_unchanged', decision: 'up_to_date' })
  expect((await call(profile, 'skill.list', {})).skills[0].adopted_paths).toEqual([target])

  // The same operation replays its reply, also after a daemon crash, and writes nothing.
  const placedTree = await treeSnapshot(target)
  await profile.restartDaemon('kill')
  expect(await call(profile, 'skill.place', place)).toEqual(placed)
  await expect(call(profile, 'skill.place', { ...place, provider: 'codex' })).rejects.toThrow(/different parameters/)
  expect(await call(profile, 'skill.place', { ...place, operation_id: 'place-greet-again' }))
    .toMatchObject({ outcome: 'up_to_date' })
  expect(await treeSnapshot(target)).toEqual(placedTree)

  // Claude's adapter rule: a workspace skill runs as /name when the project source is loaded.
  const listed = (await profile.call('command.list', { conversation_id: conversationId })).entries.find((entry) => entry.name === 'greet')
  expect(listed).toMatchObject({ kind: 'skill', invocable: true, invocation: '/greet', mechanism: 'claude.prompt_slash',
    provenance: { source: 'provider_skill', scope: 'workspace', path: expect.stringContaining('.claude/skills/greet'),
      content_hash: hash, catalog_name: 'greet' } })
  const invoked = await profile.call('command.invoke', { operation_id: 'invoke-greet', conversation_id: conversationId,
    name: 'greet', kind: 'skill', arguments: 'the team' })
  expect(invoked).toMatchObject({ outcome: 'queued', native_text: '/greet the team' })
  await expect.poll(() => claudePrompts(profile)).toEqual(['/greet the team'])
  await waitForIdle(profile, conversationId)

  // A newer bundle replaces ADE's own unchanged placement; a removed file goes with it.
  const next = join(ade.root, 'sources', 'v2', 'greet')
  await writeSkill(next, 'greet', 'Greets warmly.', { 'scripts/wave.sh': '#!/bin/sh\necho wave twice\n' })
  const newHash = await install(profile, next, 'install-greet-v2', hash)
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-stale' })).rejects.toThrow(/not /)
  const replaced = await call(profile, 'skill.place', { ...place, operation_id: 'place-v2', expected_content_hash: newHash })
  expect(replaced).toMatchObject({ outcome: 'replaced', content_hash: newHash })
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Greets warmly.')
  await expect(stat(join(target, 'notes/tone.md'))).rejects.toThrow()
  // No staging directory is left beside the skill.
  expect(Object.keys(await treeSnapshot(join(repo.path, '.claude/skills'))).filter((path) => path.includes('.ade-')))
    .toEqual([])

  // An edit outside ADE ends ADE's ownership of the content: the next placement refuses.
  await writeFile(join(target, 'SKILL.md'), '---\nname: greet\ndescription: Edited by hand.\n---\n')
  const edited = await treeSnapshot(target)
  const third = join(ade.root, 'sources', 'v3', 'greet')
  await writeSkill(third, 'greet', 'Greets a third way.')
  const thirdHash = await install(profile, third, 'install-greet-v3', newHash)
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-v3', expected_content_hash: thirdHash }))
    .rejects.toThrow(/changed since adoption/)
  expect(await treeSnapshot(target)).toEqual(edited)
})

test('F132: an external skill is never written over, and identical content stays externally owned', async ({ ade, profile, repo }) => {
  const workspace = (await profile.call('workspace.open', { path: repo.path })).workspace
  const source = join(ade.root, 'sources', 'deploy')
  await writeSkill(source, 'deploy', 'Deploys.')
  const hash = await install(profile, source, 'install-deploy')
  const external = join(repo.path, '.claude/skills/deploy')
  await writeSkill(external, 'deploy', 'Someone else deploys.')
  const externalTree = await treeSnapshot(external)

  const place = { operation_id: 'place-deploy', name: 'deploy', expected_content_hash: hash, provider: 'claude',
    scope: 'workspace', workspace_id: workspace.id }
  await expect(call(profile, 'skill.place', place)).rejects.toThrow(/adopt it explicitly/)
  expect(await treeSnapshot(external)).toEqual(externalTree)
  // The refusal left no receipt: the same operation ID runs once the path is free.
  await rm(external, { recursive: true })
  await writeSkill(external, 'deploy', 'Deploys.')
  const identical = await call(profile, 'skill.place', place)
  expect(identical).toMatchObject({ outcome: 'external_identical', path: external })
  expect((await call(profile, 'skill.list', {})).skills[0].adopted_paths).toEqual([])

  // A link at the path is refused, and nothing is written through it.
  const linkedSource = join(ade.root, 'sources', 'linked')
  await writeSkill(linkedSource, 'linked', 'Linked.')
  const linkedHash = await install(profile, linkedSource, 'install-linked')
  const elsewhere = join(ade.root, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  await symlink(elsewhere, join(repo.path, '.claude/skills/linked'))
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-linked', name: 'linked',
    expected_content_hash: linkedHash })).rejects.toThrow(/link or file/)
  expect(Object.keys(await treeSnapshot(elsewhere))).toEqual(['.'])

  // Refusals of the request itself.
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-missing', name: 'absent' }))
    .rejects.toThrow(/No bundle of this name/)
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-noworkspace', workspace_id: undefined }))
    .rejects.toThrow(/needs workspace_id/)
  await expect(call(profile, 'skill.place', { ...place, operation_id: 'place-unknown', provider: 'gemini' }))
    .rejects.toThrow(/no workspace skill root/)
})

test('F132: a global placement goes under the profile HOME through the CLI; Codex reports its missing skill input', async ({ ade, profile, repo }) => {
  const source = join(ade.root, 'sources', 'lint')
  await writeSkill(source, 'lint', 'Lints.')
  const hash = await install(profile, source, 'install-lint')
  const cli = await profile.cli('skill', 'place', 'lint', hash, 'codex', '--request-id', 'place-lint-codex')
  expect(cli.code, cli.stderr).toBe(0)
  const target = join(profile.home, '.codex/skills/lint')
  expect(cli.json).toMatchObject({ type: 'skill_placed', outcome: 'created', path: target, scope: 'global' })
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('description: Lints.')
  const again = await profile.cli('skill', 'place', 'lint', hash, 'codex', '--request-id', 'place-lint-codex')
  expect(again.json).toEqual(cli.json)

  // Codex's adapter rule is explicit: its skill input item is not sent yet, so nothing is queued.
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  const entry = (await profile.call('command.list', { conversation_id: conversationId })).entries
    .find((candidate) => candidate.name === 'lint')
  expect(entry).toMatchObject({ invocable: false, reason: expect.stringContaining('skill turn input item') })
  const refused = await profile.call('command.invoke', { operation_id: 'invoke-lint', conversation_id: conversationId,
    name: 'lint', kind: 'skill' }).catch((error: unknown) => error)
  expect(JSON.stringify(refused)).toMatch(/unavailable|skill turn input item/)
  expect((await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toEqual([])
})
