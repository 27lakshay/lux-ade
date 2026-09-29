import { join } from 'node:path'
import { secretStoreEnvironment } from '../protocol/fixtures/secret-store'

/** Keep native provider authentication discovery, but never inherit ADE state or mocks. */
export function nativeProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith('ADE_')))
  for (const name of ['ADE_CODEX_BIN', 'ADE_CLAUDE_BIN', 'ADE_BUN_BIN']) {
    if (source[name] !== undefined) env[name] = source[name]
  }
  return env
}

export function liveDaemonEnvironment(root: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...nativeProviderEnvironment(source),
    ...secretStoreEnvironment(root),
    ADE_PROFILES_HOME: join(root, 'profiles'),
    ADE_DATA_DIR: join(root, 'data'),
    ADE_SOCKET: join(root, 'daemon.sock'),
    ADE_RUNTIME_SOCKET: join(root, 'runtime.sock'),
    ADE_ROOT: root,
    SHELL: '/bin/sh',
  }
}
