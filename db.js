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

const PATCH_RECORD_COLUMNS = [
  'uuid',
  'name',
  'english_name',
  'commercial_name',
  'activity',
  'english_activity',
  'card_no',
  'renewal_no',
  'card_class',
  'commercial_name_no',
  'speciality',
  'phone_number',
  'address',
  'affiliation_date',
  'expire_date',
  'photo_path',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'member_type',
  'company_name',
  'english_company_name',
  'ceo_name',
  'english_ceo_name',
  'incorporation_certificate_no',
  'incorporation_certificate_symbol',
  'stamp_no',
  'adh_id',
  'gender',
  'company_role',
];

// Preserve existing non-empty identity/metadata fields when applying delta updates onto live DBs
const PRESERVE_IF_NON_EMPTY = new Set(['uuid', 'gender', 'company_role', 'adh_id', 'created_at']);

function normPatchStr(val) {
  return String(val ?? '').trim();
}

function normMatchName(val) {
  return normPatchStr(val).replace(/\s+/g, ' ');
}

function firstTwoWords(val) {
  const parts = normMatchName(val).split(' ').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : '';
}

function primaryRecordName(rec) {
  if (rec.member_type === 'company') {
    return normMatchName(rec.company_name || rec.name || rec.ceo_name);
  }
  return normMatchName(rec.name || rec.company_name);
}

function normTimestamp(ts) {
  return normPatchStr(ts).replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
}

function indexExistingRow(row, index) {
  const uuid = normPatchStr(row.uuid);
  if (uuid && !index.byUuid.has(uuid)) index.byUuid.set(uuid, row);

  const mType = normPatchStr(row.member_type);
  const pName = primaryRecordName(row);
  const cAt = normTimestamp(row.created_at);
  const card = normPatchStr(row.card_no);
  const cert = normPatchStr(row.incorporation_certificate_no);

  if (cAt && pName) {
    const key = `${cAt}||${pName}`;
    if (!index.byCreatedName.has(key)) index.byCreatedName.set(key, row);
  }
  if (card && pName) {
    const key = `${mType}||${card}||${pName}`;
    if (!index.byCardName.has(key)) index.byCardName.set(key, row);
  }
  if (mType === 'company' && cert && pName) {
    const key = `company||${cert}||${pName}`;
    if (!index.byCertName.has(key)) index.byCertName.set(key, row);
  }
  if (cAt) {
    index.createdAtCounts.set(cAt, (index.createdAtCounts.get(cAt) || 0) + 1);
    index.createdAtRows.set(cAt, row);
  }
}

function buildExistingRowIndex(rows) {
  const index = {
    byUuid: new Map(),
    byCreatedName: new Map(),
    byCardName: new Map(),
    byCertName: new Map(),
    createdAtCounts: new Map(),
    createdAtRows: new Map(),
  };
  for (const row of rows) indexExistingRow(row, index);
  return index;
}

function findMatchingExistingRow(rec, index) {
  const uuid = normPatchStr(rec.uuid);
  if (uuid && index.byUuid.has(uuid)) return index.byUuid.get(uuid);

  const mType = normPatchStr(rec.member_type);
  const pName = primaryRecordName(rec);
  const cAt = normTimestamp(rec.created_at);
  const card = normPatchStr(rec.card_no);
  const cert = normPatchStr(rec.incorporation_certificate_no);

  if (cAt && pName) {
    const match = index.byCreatedName.get(`${cAt}||${pName}`);
    if (match) return match;
  }
  if (card && pName) {
    const match = index.byCardName.get(`${mType}||${card}||${pName}`);
    if (match) return match;
  }
  if (mType === 'company' && cert && pName) {
    const match = index.byCertName.get(`company||${cert}||${pName}`);
    if (match) return match;
  }
  // Fallback for evolved full names (e.g. adding 4th surname word) sharing a unique creation timestamp
  if (cAt && index.createdAtCounts.get(cAt) === 1) {
    const candidate = index.createdAtRows.get(cAt);
    const incPrefix = firstTwoWords(pName);
    const extPrefix = firstTwoWords(primaryRecordName(candidate));
    if (
      candidate &&
      normPatchStr(candidate.member_type) === mType &&
      incPrefix &&
      incPrefix === extPrefix
    ) {
      return candidate;
    }
  }
  return null;
}

function copyPatchUploads(patchDir, uploadsTargetDir) {
  const srcUploadsDir = path.join(patchDir, 'uploads');
  if (!fs.existsSync(srcUploadsDir)) return { copied: 0, skipped: 0 };

  fs.mkdirSync(uploadsTargetDir, { recursive: true });
  let copied = 0;
  let skipped = 0;

  for (const entry of fs.readdirSync(srcUploadsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const srcFile = path.join(srcUploadsDir, entry.name);
    const destFile = path.join(uploadsTargetDir, entry.name);
    if (fs.existsSync(destFile) && fs.statSync(destFile).size > 200) {
      skipped++;
      continue;
    }
    fs.copyFileSync(srcFile, destFile);
    copied++;
  }
  return { copied, skipped };
}

async function applySinglePatchRecords(recordsFile, syncCols, index) {
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  if (!fs.existsSync(recordsFile)) return stats;

  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf-8'));
  if (!Array.isArray(records) || records.length === 0) return stats;

  const insertSql = `INSERT INTO traders (${syncCols.join(', ')}) VALUES (${syncCols.map(() => '?').join(', ')})`;

  for (const rec of records) {
    const existing = findMatchingExistingRow(rec, index);
    if (!existing) {
      const insertArgs = syncCols.map((col) => {
        if (col === 'name') {
          return rec.name ?? rec.company_name ?? rec.ceo_name ?? '';
        }
        return rec[col] === undefined ? null : rec[col];
      });
      const res = await sqliteClient.execute({ sql: insertSql, args: insertArgs });
      indexExistingRow({ id: Number(res.lastInsertRowid || 0), ...rec }, index);
      stats.inserted++;
      continue;
    }

    const incUpd = normTimestamp(rec.updated_at);
    const extUpd = normTimestamp(existing.updated_at);
    const isIncomingNewer = Boolean(incUpd && (!extUpd || incUpd > extUpd));
    const missingPhotoOnly = !normPatchStr(existing.photo_path) && normPatchStr(rec.photo_path);

    if (isIncomingNewer) {
      const updateCols = [];
      const updateArgs = [];
      for (const col of syncCols) {
        if (col === 'updated_at') {
          updateCols.push('updated_at = ?');
          updateArgs.push(rec.updated_at);
          continue;
        }
        if (PRESERVE_IF_NON_EMPTY.has(col) && normPatchStr(existing[col])) {
          continue;
        }
        if (col === 'name') {
          const resolvedName = rec.name ?? existing.name ?? rec.company_name ?? '';
          updateCols.push('name = ?');
          updateArgs.push(resolvedName);
          continue;
        }
        if (rec[col] !== undefined) {
          updateCols.push(`${col} = ?`);
          updateArgs.push(rec[col]);
        }
      }
      if (updateCols.length > 0) {
        updateArgs.push(existing.id);
        await sqliteClient.execute({
          sql: `UPDATE traders SET ${updateCols.join(', ')} WHERE id = ?`,
          args: updateArgs,
        });
        stats.updated++;
      } else {
        stats.skipped++;
      }
    } else if (missingPhotoOnly) {
      await sqliteClient.execute({
        sql: 'UPDATE traders SET photo_path = ? WHERE id = ?',
        args: [rec.photo_path, existing.id],
      });
      stats.updated++;
    } else {
      stats.skipped++;
    }
  }

  return stats;
}

async function applyPendingDataPatches() {
  const tableCheck = await sqliteClient.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='traders'"
  );
  if (tableCheck.rows.length === 0) return false;

  await sqliteClient.execute(
    'CREATE TABLE IF NOT EXISTS applied_patches (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
  );

  const patchesDir = path.join(__dirname, 'patches');
  if (!fs.existsSync(patchesDir)) return false;

  const patchNames = fs
    .readdirSync(patchesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (patchNames.length === 0) return false;

  // Always ensure patch photos exist in target uploads volume (copy-if-missing, <1ms check)
  const uploadsTargetDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
  const photoTotals = new Map();
  for (const name of patchNames) {
    const photoRes = copyPatchUploads(path.join(patchesDir, name), uploadsTargetDir);
    photoTotals.set(name, photoRes);
    if (photoRes.copied > 0) {
      console.log(`[DataPatch] Restored ${photoRes.copied} photo(s) from ${name}`);
    }
  }

  const appliedRes = await sqliteClient.execute('SELECT name FROM applied_patches');
  const appliedSet = new Set(appliedRes.rows.map((r) => r.name));
  const pendingPatches = patchNames.filter((name) => !appliedSet.has(name));
  if (pendingPatches.length === 0) return false;

  const colsRes = await sqliteClient.execute('PRAGMA table_info(traders)');
  const existingColSet = new Set(colsRes.rows.map((r) => r.name));
  const syncCols = PATCH_RECORD_COLUMNS.filter((c) => existingColSet.has(c));

  const existingRowsRes = await sqliteClient.execute(`SELECT id, ${syncCols.join(', ')} FROM traders`);
  const index = buildExistingRowIndex(existingRowsRes.rows);

  let anyDbChanges = false;
  for (const name of pendingPatches) {
    const recordsFile = path.join(patchesDir, name, 'records.json');
    const recStats = await applySinglePatchRecords(recordsFile, syncCols, index);
    if (recStats.inserted > 0 || recStats.updated > 0) anyDbChanges = true;

    await sqliteClient.execute({
      sql: 'INSERT OR IGNORE INTO applied_patches (name, applied_at) VALUES (?, ?)',
      args: [name, new Date().toISOString()],
    });

    const pStats = photoTotals.get(name) || { copied: 0, skipped: 0 };
    console.log(
      `[DataPatch] Applied ${name}: photos copied=${pStats.copied} (skipped=${pStats.skipped}), records inserted=${recStats.inserted}, updated=${recStats.updated}, skipped=${recStats.skipped}`
    );
  }

  return anyDbChanges;
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
      const colsRes = await sqliteClient.execute('PRAGMA table_info(traders)');
      const existingCols = new Set(colsRes.rows.map((r) => r.name));
      const requiredCompanyCols = [
        ['company_role', "TEXT DEFAULT 'ceo'"],
        ['company_name', 'TEXT'],
        ['english_company_name', 'TEXT'],
        ['ceo_name', 'TEXT'],
        ['english_ceo_name', 'TEXT'],
        ['incorporation_certificate_no', 'TEXT'],
        ['incorporation_certificate_symbol', 'TEXT'],
      ];
      for (const [colName, colDef] of requiredCompanyCols) {
        if (!existingCols.has(colName)) {
          await sqliteClient.execute(`ALTER TABLE traders ADD COLUMN ${colName} ${colDef}`);
        }
      }
    } catch (_) {}

    try {
      await sqliteClient.execute(
        'CREATE INDEX IF NOT EXISTS idx_traders_type_del_sort ON traders(member_type, deleted_at, created_at DESC, id DESC)'
      );
      await sqliteClient.execute(
        'CREATE INDEX IF NOT EXISTS idx_traders_type_card ON traders(member_type, card_no)'
      );
    } catch (_) {}

    let patchedDb = false;
    try {
      patchedDb = await applyPendingDataPatches();
    } catch (err) {
      console.error('[DataPatch] Startup patch runner failed:', err);
    }

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
        if (patchedDb) {
          try {
            await sqliteClient.execute("INSERT INTO traders_fts(traders_fts) VALUES('rebuild')");
          } catch (_) {}
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
