import { test, expect } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionIdentity, verifySession } from './session.mjs';

test('empty sessions are durable before lux-ade advertises a resume identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-omp-session-'));
  try {
    const identity = await sessionIdentity({ cwd: directory, directory: join(directory, 'sessions') });
    expect((await stat(identity.file)).size).toBeGreaterThan(0);
    expect(await sessionIdentity({ resume: JSON.stringify(identity) })).toEqual(identity);
    await verifySession(identity, { sessionId: identity.id, sessionFile: identity.file });
    await expect(verifySession(identity, { sessionId: 'replacement', sessionFile: identity.file })).rejects.toThrow('different session');
    await rm(identity.file);
    await expect(sessionIdentity({ resume: JSON.stringify(identity) })).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
