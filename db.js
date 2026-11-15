import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Optional local SQLite override from .env or environment (file: URL or SQLITE_DB_PATH only)
let envFileDbUrl = process.env.DATABASE_URL?.startsWith('file:') ? process.env.DATABASE_URL : '';
if (!envFileDbUrl && process.env.SQLITE_DB_PATH) {
  envFileDbUrl = `file:${process.env.SQLITE_DB_PATH}`;
}

if (!envFileDbUrl) {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const raw = fs.readFileSync(envPath, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('DATABASE_URL=')) {
          const val = trimmed.slice('DATABASE_URL='.length).trim();
          if (val.startsWith('file:')) envFileDbUrl = val;
        } else if (trimmed.startsWith('SQLITE_DB_PATH=') && !envFileDbUrl) {
          const val = trimmed.slice('SQLITE_DB_PATH='.length).trim();
          if (val) envFileDbUrl = `file:${val}`;
        }
      }
    } catch (_) {}
  }
}

const defaultLocalDb = path.join(__dirname, 'data', 'cardval.db');
const SQLITE_URL = envFileDbUrl || `file:${defaultLocalDb}`;
const localFilePath = SQLITE_URL.slice('file:'.length);
if (localFilePath && localFilePath !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(__dirname, localFilePath)), { recursive: true });
}

export const sqliteClient = createClient({ url: SQLITE_URL });

(async () => {
  try {
    await sqliteClient.execute('PRAGMA busy_timeout = 5000');
    await sqliteClient.execute('PRAGMA journal_mode = WAL');
    await sqliteClient.execute('PRAGMA synchronous = NORMAL');
    await sqliteClient.execute('PRAGMA temp_store = MEMORY');
  } catch (_) {}
})();

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
    const res = await sqliteClient.execute({ sql, args: normalizeArgs(args) });
    return res.rows.length > 0 ? Object.assign({}, res.rows[0]) : null;
  },

  async all(sql, ...args) {
    const res = await sqliteClient.execute({ sql, args: normalizeArgs(args) });
    return res.rows.map((r) => Object.assign({}, r));
  },

  async run(sql, ...args) {
    const res = await sqliteClient.execute({ sql, args: normalizeArgs(args) });
    return { changes: res.rowsAffected, lastInsertRowid: res.lastInsertRowid };
  },

  async exec(sql) {
    return await sqliteClient.execute(sql);
  },

  async batch(statements, mode = 'read') {
    const normalized = statements.map((s) =>
      typeof s === 'string'
        ? s
        : { sql: s.sql, args: normalizeArgs(s.args || []) }
    );
    const results = await sqliteClient.batch(normalized, mode);
    return results.map((res) => ({
      rows: res.rows.map((r) => Object.assign({}, r)),
      first: res.rows.length > 0 ? Object.assign({}, res.rows[0]) : null,
      changes: res.rowsAffected,
      lastInsertRowid: res.lastInsertRowid,
    }));
  },
};
