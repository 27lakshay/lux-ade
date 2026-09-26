// Read the pinned native 18.3.0 credential schema without opening OMP's mutable auth store.
// Never print credential data: the daemon only receives stable account metadata.
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const home = process.argv[2];
if (!home || home !== process.env.PI_CODING_AGENT_DIR) throw new Error('Oh My Pi account home is unavailable');
const db = new Database(join(home, 'agent.db'), { readonly: true });
try {
  const rows = db.query('SELECT id, provider, credential_type, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL').all();
  if (rows.length === 0) {
    process.stdout.write(JSON.stringify({ state: 'unauthenticated', reason: 'Oh My Pi has no active credential in this account home' }));
  } else if (rows.length !== 1) {
    process.stdout.write(JSON.stringify({ state: 'incompatible', reason: 'Managed Oh My Pi requires exactly one active native credential in this account home' }));
  } else {
    const row = rows[0];
    const credential = JSON.parse(row.data);
    if (row.credential_type !== 'oauth' || !Number.isSafeInteger(row.id) || row.id <= 0 ||
      typeof row.provider !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.provider) ||
      typeof row.identity_key !== 'string' || row.identity_key.length === 0 ||
      row.identity_key.length > 512 || credential.type === 'api_key') {
      process.stdout.write(JSON.stringify({ state: 'incompatible', reason: 'Managed Oh My Pi requires one identified native OAuth credential' }));
    } else {
      const field = name => typeof credential[name] === 'string' && credential[name].length <= 320 &&
        !/[\r\n\0]/.test(credential[name]) ? credential[name] : null;
      const email = field('email'), account_id = field('accountId'), org_id = field('orgId');
      if (!email && !account_id) {
        process.stdout.write(JSON.stringify({ state: 'incompatible', reason: 'Oh My Pi credential has no native account identifier' }));
      } else {
        process.stdout.write(JSON.stringify({ state: 'ready', reason: 'One native OAuth credential is available', identity: {
          provider: row.provider, credential_id: row.id, credential_type: row.credential_type,
          identity_key: row.identity_key, email, account_id, org_id,
        } }));
      }
    }
  }
} finally { db.close(); }
