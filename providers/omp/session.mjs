import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export async function sessionIdentity({ resume, cwd, directory }) {
  if (resume) {
    const value = JSON.parse(resume)
    if (
      value.v !== 1 ||
      typeof value.id !== 'string' ||
      !value.id ||
      typeof value.file !== 'string' ||
      !isAbsolute(value.file)
    )
      throw new Error('Invalid Oh My Pi resume identity')
    const info = await stat(value.file)
    if (!info.isFile()) throw new Error('Oh My Pi session file is unavailable')
    return value
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const manager = SessionManager.create(cwd, directory)
  try {
    // OMP normally persists lazily after its first assistant message. Force its
    // own durable storage path so even an empty lux-ade Conversation can reconnect.
    await manager.ensureOnDisk()
    return { v: 1, id: manager.getSessionId(), file: await realpath(manager.getSessionFile()) }
  } finally {
    await manager.close()
  }
}

export async function verifySession(identity, state) {
  if (
    state.sessionId !== identity.id ||
    typeof state.sessionFile !== 'string' ||
    (await realpath(state.sessionFile)) !== (await realpath(identity.file))
  ) {
    throw new Error('Oh My Pi opened a different session; refusing replacement')
  }
}
