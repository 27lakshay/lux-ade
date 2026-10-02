// Minimal contracts adapted from OpenCode; provenance: PROVENANCE.md.
// Upstream copyright and MIT permission: LICENSE-opencode.
export function spec(current) {
  const root = '/api/session/{sessionID}'
  const paths = {}
  for (const [path, method] of [
    ['/api/session', 'post'],
    [root, 'get'],
    [`${root}/message`, 'get'],
    [`${root}/message/{messageID}`, 'get'],
    [`${root}/inbox`, 'get'],
    [`${root}/inbox/{inboxID}`, 'delete'],
    [`${root}/permission`, 'get'],
    [`${root}/form`, 'get'],
    [`${root}/form/{formID}/reply`, 'post'],
    ['/api/session/active', 'get'],
  ])
    paths[path] = { [method]: {} }
  const json = (schema) => ({ requestBody: { content: { 'application/json': { schema } } } })
  const field = current ? 'decision' : 'reply'
  paths[`${root}/permission/{requestID}/reply`] = {
    post: json({ required: [field], properties: { [field]: { $ref: '#/components/schemas/Permission.Reply' } } }),
  }
  paths[`${root}/prompt`] = {
    post: json({
      properties: Object.fromEntries(['id', 'text', 'files', 'metadata', 'resume'].map((key) => [key, {}])),
    }),
  }
  paths[`${root}/interrupt`] = { post: { parameters: [{ in: 'query', name: current ? 'resume' : 'continue' }] } }
  paths[`${root}/form/{formID}${current ? '' : '/cancel'}`] = { [current ? 'delete' : 'post']: {} }
  return { paths, components: { schemas: { 'Permission.Reply': { enum: ['once', 'always', 'reject'] } } } }
}
