import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

// Admission receipts; ChildTranscripts also uses this connection for native
// file references. lux-ade's Store owns prompts, attachments and queue ordering.
// Insertion must commit before writing to the provider. An unresolved receipt
// after a process crash is uncertain, never permission to send the prompt again.
export class SubmissionLedger {
  constructor(filename) {
    this.db = new Database(filename, { create: true, strict: true })
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS submissions (
        session TEXT NOT NULL, submission TEXT NOT NULL, turn TEXT NOT NULL,
        fingerprint TEXT NOT NULL, baseline TEXT, entry_id TEXT,
        outcome TEXT CHECK(outcome IN ('completed','failed','interrupted')),
        PRIMARY KEY(session, submission), UNIQUE(session, turn), UNIQUE(session, entry_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_submission ON submissions(session) WHERE outcome IS NULL;`)
  }
  get(session, submission) {
    return this.db.query('SELECT * FROM submissions WHERE session=? AND submission=?').get(session, submission)
  }
  pending(session) {
    return this.db.query('SELECT * FROM submissions WHERE session=? AND outcome IS NULL').get(session)
  }
  begin({ session, submission, turn, baseline = null, payload }) {
    for (const value of [session, submission, turn]) {
      if (typeof value !== 'string' || !value || value.length > 4096)
        throw new Error('Invalid Oh My Pi submission identity')
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonical(payload)))
      .digest('hex')
    return this.db
      .transaction(() => {
        const existing = this.get(session, submission)
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.turn !== turn)
            throw new Error('Oh My Pi submission identity was reused with different content')
          return { fresh: false, receipt: existing }
        }
        if (this.pending(session)) throw new Error('Oh My Pi has an unresolved submission; reconcile it before sending')
        this.db
          .query('INSERT INTO submissions(session,submission,turn,fingerprint,baseline) VALUES (?,?,?,?,?)')
          .run(session, submission, turn, fingerprint, baseline)
        return { fresh: true, receipt: this.get(session, submission) }
      })
      .immediate()
  }
  bind(session, submission, entryId) {
    if (typeof entryId !== 'string' || !entryId || entryId.length > 4096)
      throw new Error('Invalid Oh My Pi entry identity')
    this.db
      .transaction(() => {
        const receipt = this.get(session, submission)
        if (!receipt) throw new Error('Unknown Oh My Pi submission')
        if (receipt.entry_id === entryId) return
        if (receipt.entry_id || receipt.outcome)
          throw new Error('Oh My Pi submission can no longer change entry identity')
        this.db
          .query('UPDATE submissions SET entry_id=? WHERE session=? AND submission=?')
          .run(entryId, session, submission)
      })
      .immediate()
  }
  finish(session, submission, outcome) {
    if (!['completed', 'failed', 'interrupted'].includes(outcome))
      throw new Error('Invalid Oh My Pi submission outcome')
    this.db
      .transaction(() => {
        const receipt = this.get(session, submission)
        if (!receipt) throw new Error('Unknown Oh My Pi submission')
        if (receipt.outcome && receipt.outcome !== outcome)
          throw new Error('Oh My Pi submission outcome is already final')
        this.db
          .query('UPDATE submissions SET outcome=? WHERE session=? AND submission=?')
          .run(outcome, session, submission)
      })
      .immediate()
  }
  identities(session, entryIds) {
    const result = new Map()
    const query = this.db.query('SELECT turn,submission FROM submissions WHERE session=? AND entry_id=?')
    for (const id of entryIds) {
      const row = query.get(session, id)
      if (row) result.set(id, row)
    }
    return result
  }
  close() {
    this.db.close()
  }
}
