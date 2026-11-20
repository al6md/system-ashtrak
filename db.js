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

let ftsReady = false;
let initPromise = null;
let resolveFtsInit;
export let ftsReadyPromise = new Promise((resolve) => {
  resolveFtsInit = resolve;
});

export function isFtsReady() {
  return ftsReady;
}

const FTS_COLUMNS = [
  'name',
  'english_name',
  'commercial_name',
  'company_name',
  'english_company_name',
  'ceo_name',
  'activity',
  'card_no',
  'stamp_no',
  'incorporation_certificate_no',
  'phone_number',
].join(', ');

const FTS_NEW_VALUES = [
  'new.name',
  'new.english_name',
  'new.commercial_name',
  'new.company_name',
  'new.english_company_name',
  'new.ceo_name',
  'new.activity',
  'new.card_no',
  'new.stamp_no',
  'new.incorporation_certificate_no',
  'new.phone_number',
].join(', ');

const FTS_OLD_VALUES = [
  'old.name',
  'old.english_name',
  'old.commercial_name',
  'old.company_name',
  'old.english_company_name',
  'old.ceo_name',
  'old.activity',
  'old.card_no',
  'old.stamp_no',
  'old.incorporation_certificate_no',
  'old.phone_number',
].join(', ');

async function ensureFtsTriggers() {
  await sqliteClient.execute(`
    CREATE TRIGGER IF NOT EXISTS traders_fts_ai AFTER INSERT ON traders BEGIN
      INSERT INTO traders_fts(rowid, ${FTS_COLUMNS})
      VALUES (new.id, ${FTS_NEW_VALUES});
    END
  `);
  await sqliteClient.execute(`
    CREATE TRIGGER IF NOT EXISTS traders_fts_ad AFTER DELETE ON traders BEGIN
      INSERT INTO traders_fts(traders_fts, rowid, ${FTS_COLUMNS})
      VALUES ('delete', old.id, ${FTS_OLD_VALUES});
    END
  `);
  await sqliteClient.execute(`
    CREATE TRIGGER IF NOT EXISTS traders_fts_au AFTER UPDATE ON traders BEGIN
      INSERT INTO traders_fts(traders_fts, rowid, ${FTS_COLUMNS})
      VALUES ('delete', old.id, ${FTS_OLD_VALUES});
      INSERT INTO traders_fts(rowid, ${FTS_COLUMNS})
      VALUES (new.id, ${FTS_NEW_VALUES});
    END
  `);
}

export function initDb() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await sqliteClient.execute('PRAGMA busy_timeout = 5000');
      await sqliteClient.execute('PRAGMA journal_mode = WAL');
      await sqliteClient.execute('PRAGMA synchronous = NORMAL');
      await sqliteClient.execute('PRAGMA temp_store = MEMORY');
      await sqliteClient.execute('PRAGMA cache_size = -32000');
      await sqliteClient.execute('PRAGMA mmap_size = 134217728');
    } catch (_) {}

    try {
      await sqliteClient.execute(
        'CREATE INDEX IF NOT EXISTS idx_traders_type_del_sort ON traders(member_type, deleted_at, created_at DESC, id DESC)'
      );
      await sqliteClient.execute(
        'CREATE INDEX IF NOT EXISTS idx_traders_type_card ON traders(member_type, card_no)'
      );
    } catch (_) {}

    try {
      const existing = await sqliteClient.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='traders_fts'"
      );
      const alreadyExists = existing.rows.length > 0;

      if (alreadyExists) {
        const triggerCheck = await sqliteClient.execute(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('traders_fts_ai','traders_fts_ad','traders_fts_au')"
        );
        if (triggerCheck.rows.length < 3) {
          await ensureFtsTriggers();
        }
        ftsReady = true;
        resolveFtsInit(true);
        ftsReadyPromise = Promise.resolve(true);
      } else {
        await sqliteClient.execute(`
          CREATE VIRTUAL TABLE IF NOT EXISTS traders_fts USING fts5(
            ${FTS_COLUMNS},
            content='traders',
            content_rowid='id',
            tokenize='trigram'
          )
        `);
        await ensureFtsTriggers();

        ftsReady = false;
        const rebuildPromise = (async () => {
          try {
            await sqliteClient.execute("INSERT INTO traders_fts(traders_fts) VALUES('rebuild')");
            ftsReady = true;
            return true;
          } catch (_) {
            ftsReady = false;
            return false;
          }
        })();
        rebuildPromise.then(resolveFtsInit, () => resolveFtsInit(false));
        ftsReadyPromise = rebuildPromise;
      }
    } catch (_) {
      ftsReady = false;
      resolveFtsInit(false);
      ftsReadyPromise = Promise.resolve(false);
    }
  })();

  return initPromise;
}

export const dbReady = initDb();

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
