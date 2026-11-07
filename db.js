import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env.turso if exists
let envUrl = process.env.TURSO_DATABASE_URL;
let envToken = process.env.TURSO_AUTH_TOKEN;

const tursoEnvPath = path.join(__dirname, '.env.turso');
if ((!envUrl || !envToken) && fs.existsSync(tursoEnvPath)) {
  const raw = fs.readFileSync(tursoEnvPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('TURSO_DATABASE_URL=')) {
      envUrl = trimmed.split('=')[1]?.trim();
    }
    if (trimmed.startsWith('TURSO_AUTH_TOKEN=')) {
      envToken = trimmed.slice(trimmed.indexOf('=') + 1).trim();
    }
  }
}

// Fallback to default cloud credentials
const TURSO_URL = envUrl || 'libsql://cardval-al6md.aws-eu-central-1.turso.io';
const TURSO_TOKEN = envToken || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTQwNjI5MTUsImlkIjoiMDFhMWI2N2EtMTgwMS03NzFlLTg5NjQtNWQzOTg3MmQ4MzYxIiwia2lkIjoiN2lhYXVLZUFMU1ZnQ0ZLZDJlR0hvQmRaaUFFVGNKdmhBSDZ3ZmlBazBNMCIsInJpZCI6IjkyMDliNGRmLWY4OTEtNDhjMi05Yzg0LTUyOTBlYTVlNjMyMiJ9.VeS2k-VbYAH7iHB52fUICdF4qVIKCtlhYGtSPwjqEvQC6LUoWJK8ACKaqh21OO40Uktn66xl-T2MO7GgfpKpAg';

export const turso = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

function normalizeArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args.map((a) => (a === undefined ? null : a));
}

export const db = {
  prepare(sql) {
    return {
      async get(...args) {
        return await db.get(sql, ...args);
      },
      async all(...args) {
        return await db.all(sql, ...args);
      },
      async run(...args) {
        return await db.run(sql, ...args);
      },
    };
  },

  async get(sql, ...args) {
    const res = await turso.execute({ sql, args: normalizeArgs(args) });
    return res.rows.length > 0 ? Object.assign({}, res.rows[0]) : null;
  },

  async all(sql, ...args) {
    const res = await turso.execute({ sql, args: normalizeArgs(args) });
    return res.rows.map((r) => Object.assign({}, r));
  },

  async run(sql, ...args) {
    const res = await turso.execute({ sql, args: normalizeArgs(args) });
    return { changes: res.rowsAffected, lastInsertRowid: res.lastInsertRowid };
  },

  async exec(sql) {
    return await turso.execute(sql);
  },
};
