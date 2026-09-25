import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubmissionLedger } from './submissions.mjs';

const first = { session: 'session', submission: 'ade-1', turn: 'turn-1', baseline: 'entry-0', payload: { message: 'hello', images: [] } };

test('receipts survive process exit and do not authorize automatic resend', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-omp-ledger-'));
  const filename = join(directory, 'receipts.sqlite');
  let ledger;
  try {
    const script = `import { SubmissionLedger } from ${JSON.stringify(new URL('./submissions.mjs', import.meta.url).pathname)};
      const ledger = new SubmissionLedger(process.argv[1]);
      ledger.begin(${JSON.stringify(first)}); process.exit(0);`;
    const child = Bun.spawnSync([process.execPath, '-e', script, filename]);
    expect(child.exitCode).toBe(0);
    ledger = new SubmissionLedger(filename);
    expect(ledger.pending('session').submission).toBe('ade-1');
    expect(ledger.begin(first).fresh).toBe(false);
    expect(() => ledger.begin({ ...first, submission: 'ade-2', turn: 'turn-2' })).toThrow('unresolved');
    ledger.finish('session', 'ade-1', 'interrupted');
    expect(ledger.begin(first).fresh).toBe(false);
    expect(ledger.begin({ ...first, submission: 'ade-2', turn: 'turn-2' }).fresh).toBe(true);
  } finally { ledger?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('idempotence is canonical and rejects payload and identity substitution', () => {
  const ledger = new SubmissionLedger(':memory:');
  try {
    ledger.begin(first);
    expect(ledger.begin({ ...first, payload: { images: [], message: 'hello' } }).fresh).toBe(false);
    expect(() => ledger.begin({ ...first, payload: { message: 'different' } })).toThrow('different content');
    expect(() => ledger.begin({ ...first, turn: 'other' })).toThrow('different content');
  } finally { ledger.close(); }
});

test('durable entry binding is immutable and session scoped', () => {
  const ledger = new SubmissionLedger(':memory:');
  try {
    ledger.begin(first); ledger.bind('session', 'ade-1', 'entry-1');
    ledger.bind('session', 'ade-1', 'entry-1');
    expect(() => ledger.bind('session', 'ade-1', 'entry-2')).toThrow('change entry identity');
    expect(ledger.identities('session', ['entry-1']).get('entry-1')).toEqual({ turn: 'turn-1', submission: 'ade-1' });
    expect(ledger.identities('other', ['entry-1']).size).toBe(0);
    ledger.finish('session', 'ade-1', 'completed');
    expect(() => ledger.finish('session', 'ade-1', 'interrupted')).toThrow('already final');
  } finally { ledger.close(); }
});
