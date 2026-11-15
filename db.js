import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env and .env.turso if exists
let envUrl = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL;
let envToken = process.env.TURSO_AUTH_TOKEN;

for (const envFile of ['.env', '.env.turso']) {
  const envPath = path.join(__dirname, envFile);
  if ((!envUrl || !envToken) && fs.existsSync(envPath)) {
    try {
      const raw = fs.readFileSync(envPath, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if ((trimmed.startsWith('DATABASE_URL=') || trimmed.startsWith('TURSO_DATABASE_URL=')) && !envUrl) {
          envUrl = trimmed.slice(trimmed.indexOf('=') + 1).trim();
        }
        if (trimmed.startsWith('TURSO_AUTH_TOKEN=') && !envToken) {
          envToken = trimmed.slice(trimmed.indexOf('=') + 1).trim();
        }
      }
    } catch (_) {}
  }
}

// Fallback to local SQLite file if running on a persistent server, otherwise Turso cloud
const defaultLocalDb = path.join(__dirname, 'data', 'cardval.db');
const TURSO_URL = envUrl || `file:${defaultLocalDb}`;
const TURSO_TOKEN = envToken || '';
const isLocalFileDb = TURSO_URL.startsWith('file:');

if (isLocalFileDb) {
  const localFilePath = TURSO_URL.slice('file:'.length);
  if (localFilePath && localFilePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(__dirname, localFilePath)), { recursive: true });
  }
}

export const turso = createClient(
  isLocalFileDb
    ? { url: TURSO_URL }
    : { url: TURSO_URL, authToken: TURSO_TOKEN }
);

if (isLocalFileDb) {
  (async () => {
    try {
      await turso.execute('PRAGMA busy_timeout = 5000');
      await turso.execute('PRAGMA journal_mode = WAL');
      await turso.execute('PRAGMA synchronous = NORMAL');
      await turso.execute('PRAGMA temp_store = MEMORY');
    } catch (_) {}
  })();
}

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

  async batch(statements, mode = 'read') {
    const normalized = statements.map((s) =>
      typeof s === 'string'
        ? s
        : { sql: s.sql, args: normalizeArgs(s.args || []) }
    );
    const results = await turso.batch(normalized, mode);
    return results.map((res) => ({
      rows: res.rows.map((r) => Object.assign({}, r)),
      first: res.rows.length > 0 ? Object.assign({}, res.rows[0]) : null,
      changes: res.rowsAffected,
      lastInsertRowid: res.lastInsertRowid,
    }));
  },
};
