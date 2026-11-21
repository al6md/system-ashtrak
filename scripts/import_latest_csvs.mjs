import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { notifySaved, flushQueue } from '../accessHubSync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CSV_DIR = 'C:\\Users\\tohiba\\Desktop\\شييييير\\تصاميم الهوية';
const LOCAL_DB_PATH = path.join(ROOT_DIR, 'data', 'cardval.db');

/** Parse RFC-4180 CSV content including quoted commas, doubled quotes, and newlines. */
function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      row.push(cur);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  if (row.some((c) => c !== '')) rows.push(row);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = (cols[i] ?? '').trim();
    }
    return obj;
  });
}

function norm(val) {
  return String(val ?? '').trim().replace(/\s+/g, ' ');
}

function normNum(val) {
  const v = norm(val);
  return v === '0' ? '' : v;
}

/** Find newest matching CSV file (e.g. traders-*.csv) inside csvDir. */
function resolveLatestCsv(csvDir, prefix) {
  const matches = fs
    .readdirSync(csvDir)
    .filter((f) => f.toLowerCase().startsWith(`${prefix}-`) && f.toLowerCase().endsWith('.csv'))
    .sort()
    .reverse();
  if (!matches.length) {
    throw new Error(`No ${prefix}-*.csv file found in ${csvDir}`);
  }
  return path.join(csvDir, matches[0]);
}

function mapCsvRow(memberType, raw) {
  if (memberType === 'company') {
    const companyName = raw['Company Name'] || '';
    const englishCompanyName = raw['English Company Name'] || '';
    const ceoName = raw['CEO Name'] || '';
    const englishCeoName = raw['English CEO Name'] || '';
    return {
      member_type: 'company',
      name: ceoName || companyName,
      english_name: englishCeoName || englishCompanyName,
      commercial_name: companyName,
      company_name: companyName,
      english_company_name: englishCompanyName,
      ceo_name: ceoName,
      english_ceo_name: englishCeoName,
      activity: raw['Activity'] || '',
      english_activity: raw['English Activity'] || '',
      card_no: raw['Card No'] || '',
      stamp_no: '',
      renewal_no: raw['Renewal No'] || '',
      card_class: raw['Card Class'] || '0',
      commercial_name_no: raw['Commercial Name No'] || '',
      incorporation_certificate_no: raw['Incorporation Certificate No'] || '',
      incorporation_certificate_symbol: raw['Incorporation Certificate Symbol'] || '',
      speciality: raw['Speciality'] || '',
      phone_number: raw['Phone Number'] || '',
      address: raw['Address'] || '',
      affiliation_date: raw['Affiliation Date'] || '',
      expire_date: raw['Expire Date'] || '',
      created_by: raw['Created By'] || 'Site Admin',
      created_at: raw['Created At'] || '',
      updated_at: raw['Updated At'] || raw['Created At'] || '',
      deleted_at: raw['Deleted At'] || '',
      gender: 'ذكر',
    };
  }

  return {
    member_type: memberType,
    name: raw['Name'] || '',
    english_name: raw['English Name'] || '',
    commercial_name: raw['Commercial Name'] || '',
    company_name: null,
    english_company_name: null,
    ceo_name: null,
    english_ceo_name: null,
    activity: raw['Activity'] || (memberType === 'broker' ? 'دلالية العقارات' : ''),
    english_activity: raw['English Activity'] || (memberType === 'broker' ? 'Real Estates BROKER' : ''),
    card_no: raw['Card No'] || '',
    stamp_no: memberType === 'broker' ? (raw['Stamp No'] || '') : '',
    renewal_no: raw['Renewal No'] || '',
    card_class: raw['Card Class'] || (memberType === 'broker' ? '1' : '4'),
    commercial_name_no: raw['Commercial Name No'] || '',
    incorporation_certificate_no: null,
    incorporation_certificate_symbol: null,
    speciality: raw['Speciality'] || '',
    phone_number: raw['Phone Number'] || '',
    address: raw['Address'] || '',
    affiliation_date: raw['Affiliation Date'] || '',
    expire_date: raw['Expire Date'] || '',
    created_by: raw['Created By'] || 'Site Admin',
    created_at: raw['Created At'] || '',
    updated_at: raw['Updated At'] || raw['Created At'] || '',
    deleted_at: raw['Deleted At'] || (memberType === 'broker' ? null : ''),
    gender: 'ذكر',
  };
}

function getPrimaryName(memberType, row) {
  if (memberType === 'company') {
    return norm(row.company_name || row.commercial_name || row.name);
  }
  return norm(row.name);
}

const RENEWAL_CHECK_FIELDS = [
  'renewal_no', 'expire_date', 'affiliation_date', 'card_no',
  'commercial_name_no', 'card_class', 'stamp_no',
  'incorporation_certificate_no', 'incorporation_certificate_symbol',
  'activity', 'english_activity', 'speciality', 'phone_number', 'address',
  'commercial_name', 'english_name', 'company_name', 'english_company_name',
  'ceo_name', 'english_ceo_name'
];

function hasMeaningfulChanges(existing, incoming) {
  return RENEWAL_CHECK_FIELDS.some((field) => norm(existing[field]) !== norm(incoming[field]));
}

function shareNamePrefix(a, b) {
  const wA = norm(a).split(' ').filter(Boolean);
  const wB = norm(b).split(' ').filter(Boolean);
  if (wA.length < 2 || wB.length < 2) return false;
  return wA[0] === wB[0] && wA[1] === wB[1];
}

function buildLookupIndices(rows, memberType) {
  const byCreatedName = new Map();
  const byCardName = new Map();
  const byCertName = new Map();
  const byCreatedAtUnique = new Map();
  const createdCounts = new Map();

  for (const r of rows) {
    const nm = getPrimaryName(memberType, r);
    const cr = norm(r.created_at);
    const c = normNum(r.card_no);
    const cert = normNum(r.incorporation_certificate_no);
    if (cr && nm) byCreatedName.set(`${cr}|||${nm}`, r);
    if (c && nm) byCardName.set(`${c}|||${nm}`, r);
    if (memberType === 'company' && cert && nm) byCertName.set(`${cert}|||${nm}`, r);
    if (cr) {
      createdCounts.set(cr, (createdCounts.get(cr) || 0) + 1);
      byCreatedAtUnique.set(cr, r);
    }
  }
  for (const [cr, count] of createdCounts) {
    if (count > 1) byCreatedAtUnique.delete(cr);
  }
  return { byCreatedName, byCardName, byCertName, byCreatedAtUnique };
}

function findMatchingRow(indices, memberType, mapped) {
  const nm = getPrimaryName(memberType, mapped);
  const cr = norm(mapped.created_at);
  const c = normNum(mapped.card_no);
  const cert = normNum(mapped.incorporation_certificate_no);

  if (cr && nm && indices.byCreatedName.has(`${cr}|||${nm}`)) {
    return indices.byCreatedName.get(`${cr}|||${nm}`);
  }
  if (c && nm && indices.byCardName.has(`${c}|||${nm}`)) {
    return indices.byCardName.get(`${c}|||${nm}`);
  }
  if (memberType === 'company' && cert && nm && indices.byCertName.has(`${cert}|||${nm}`)) {
    return indices.byCertName.get(`${cert}|||${nm}`);
  }
  if (cr && nm && indices.byCreatedAtUnique.has(cr)) {
    const cand = indices.byCreatedAtUnique.get(cr);
    const candNm = getPrimaryName(memberType, cand);
    if (shareNamePrefix(candNm, nm)) {
      return cand;
    }
  }
  return null;
}

const INSERT_SQL = `
  INSERT INTO traders (
    uuid, name, english_name, commercial_name,
    company_name, english_company_name, ceo_name, english_ceo_name,
    activity, english_activity, card_no, stamp_no, renewal_no, card_class,
    gender, commercial_name_no, incorporation_certificate_no, incorporation_certificate_symbol,
    speciality, phone_number, address, affiliation_date, expire_date,
    created_by, created_at, updated_at, deleted_at, member_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_SQL = `
  UPDATE traders SET
    name = ?, english_name = ?, commercial_name = ?,
    company_name = ?, english_company_name = ?, ceo_name = ?, english_ceo_name = ?,
    activity = ?, english_activity = ?, card_no = ?, stamp_no = ?, renewal_no = ?,
    card_class = ?, commercial_name_no = ?, incorporation_certificate_no = ?,
    incorporation_certificate_symbol = ?, speciality = ?, phone_number = ?, address = ?,
    affiliation_date = ?, expire_date = ?, updated_at = ?
  WHERE uuid = ?
`;

function insertParams(uuid, m) {
  return [
    uuid, m.name, m.english_name, m.commercial_name,
    m.company_name, m.english_company_name, m.ceo_name, m.english_ceo_name,
    m.activity, m.english_activity, m.card_no, m.stamp_no, m.renewal_no, m.card_class,
    m.gender, m.commercial_name_no, m.incorporation_certificate_no, m.incorporation_certificate_symbol,
    m.speciality, m.phone_number, m.address, m.affiliation_date, m.expire_date,
    m.created_by, m.created_at, m.updated_at, m.deleted_at, m.member_type,
  ];
}

function updateParams(uuid, m) {
  return [
    m.name, m.english_name, m.commercial_name,
    m.company_name, m.english_company_name, m.ceo_name, m.english_ceo_name,
    m.activity, m.english_activity, m.card_no, m.stamp_no, m.renewal_no,
    m.card_class, m.commercial_name_no, m.incorporation_certificate_no,
    m.incorporation_certificate_symbol, m.speciality, m.phone_number, m.address,
    m.affiliation_date, m.expire_date, m.updated_at, uuid,
  ];
}

const UPDATE_BY_ID_LOCAL_SQL = `
  UPDATE traders SET
    name = ?, english_name = ?, commercial_name = ?,
    company_name = ?, english_company_name = ?, ceo_name = ?, english_ceo_name = ?,
    activity = ?, english_activity = ?, card_no = ?, stamp_no = ?, renewal_no = ?,
    card_class = ?, commercial_name_no = ?, incorporation_certificate_no = ?,
    incorporation_certificate_symbol = ?, speciality = ?, phone_number = ?, address = ?,
    affiliation_date = ?, expire_date = ?, updated_at = ?
  WHERE id = ?
`;

function mirrorToLocalSqlite(localDb, action, uuid, m) {
  if (!localDb) return;
  if (action === 'insert') {
    const used = localDb.prepare('SELECT id FROM traders WHERE uuid = ?').get(uuid);
    if (!used) localDb.prepare(INSERT_SQL).run(...insertParams(uuid, m));
  } else if (action === 'update') {
    const existingLocal = localDb.prepare('SELECT id FROM traders WHERE uuid = ?').get(uuid);
    if (existingLocal) {
      localDb.prepare(UPDATE_SQL).run(...updateParams(uuid, m));
    } else if (m.created_at && m.name) {
      const byMeta = localDb
        .prepare('SELECT id FROM traders WHERE member_type = ? AND created_at = ? AND (name = ? OR company_name = ?) LIMIT 1')
        .get(m.member_type, m.created_at, m.name, m.company_name || m.name);
      if (byMeta) {
        const params = updateParams(uuid, m);
        params[params.length - 1] = byMeta.id;
        localDb.prepare(UPDATE_BY_ID_LOCAL_SQL).run(...params);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipAccessSync = args.includes('--no-access-sync');
  const dirFlagIdx = args.indexOf('--dir');
  const csvDir = dirFlagIdx !== -1 && args[dirFlagIdx + 1] ? args[dirFlagIdx + 1] : DEFAULT_CSV_DIR;

  const csvPaths = {
    trader: resolveLatestCsv(csvDir, 'traders'),
    broker: resolveLatestCsv(csvDir, 'brokers'),
    company: resolveLatestCsv(csvDir, 'companies'),
  };

  console.log(`=== استيراد السجلات الجديدة والمجددة (${dryRun ? 'معاينة بدون تعديل' : 'تنفيذ فعلي'}) ===`);
  console.log('المجلد:', csvDir);
  for (const [k, v] of Object.entries(csvPaths)) {
    console.log(`  - ${k}: ${path.basename(v)}`);
  }

  const allExisting = await db.all('SELECT * FROM traders');
  const usedUuids = new Set(allExisting.map((r) => r.uuid).filter(Boolean));
  const usingRemoteDb = Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('file:'));
  const localDb = !dryRun && usingRemoteDb && fs.existsSync(LOCAL_DB_PATH)
    ? new DatabaseSync(LOCAL_DB_PATH)
    : null;

  const summary = {
    inserted: { trader: 0, broker: 0, company: 0 },
    updated: { trader: 0, broker: 0, company: 0 },
    skippedEmpty: 0,
    skippedExisting: 0,
  };
  const syncItems = [];

  for (const memberType of ['trader', 'broker', 'company']) {
    const existingRows = allExisting.filter((r) => (r.member_type || 'trader') === memberType);
    const indices = buildLookupIndices(existingRows, memberType);
    const rawRows = parseCsvFile(csvPaths[memberType]);

    for (const raw of rawRows) {
      const mapped = mapCsvRow(memberType, raw);
      const primaryName = getPrimaryName(memberType, mapped);

      // Skip blank placeholder rows with no name/company and no card number
      if (!primaryName && !norm(mapped.commercial_name)) {
        summary.skippedEmpty++;
        continue;
      }

      const matched = findMatchingRow(indices, memberType, mapped);
      if (!matched) {
        let uuid = crypto.randomUUID();
        while (usedUuids.has(uuid)) uuid = crypto.randomUUID();
        usedUuids.add(uuid);

        console.log(`  [+] جديد (${memberType}): ${primaryName} | هوية=${mapped.card_no} | تجديد=${mapped.renewal_no} | تجاري=${mapped.commercial_name_no} | ${mapped.created_at}`);
        if (!dryRun) {
          await db.prepare(INSERT_SQL).run(...insertParams(uuid, mapped));
          mirrorToLocalSqlite(localDb, 'insert', uuid, mapped);
          syncItems.push({ uuid, oldRow: null, newRow: { ...mapped, uuid } });
        }
        // Prevent duplicates within the same CSV batch
        const insertedFake = { ...mapped, uuid };
        indices.byCreatedName.set(`${norm(mapped.created_at)}|||${primaryName}`, insertedFake);
        if (normNum(mapped.card_no)) {
          indices.byCardName.set(`${normNum(mapped.card_no)}|||${primaryName}`, insertedFake);
        }
        summary.inserted[memberType]++;
        continue;
      }

      // Only apply CSV updates if CSV timestamp is strictly newer AND subscription fields differ
      if (norm(mapped.updated_at) > norm(matched.updated_at) && hasMeaningfulChanges(matched, mapped)) {
        console.log(`  [~] تجديد/تحديث (${memberType}): ${primaryName} | هوية ${matched.card_no}->${mapped.card_no} | تجديد ${matched.renewal_no}->${mapped.renewal_no} | نفاذ ${matched.expire_date}->${mapped.expire_date}`);
        if (!dryRun) {
          await db.prepare(UPDATE_SQL).run(...updateParams(matched.uuid, mapped));
          mirrorToLocalSqlite(localDb, 'update', matched.uuid, mapped);
          syncItems.push({ uuid: matched.uuid, oldRow: matched, newRow: { ...matched, ...mapped } });
        }
        summary.updated[memberType]++;
      } else {
        summary.skippedExisting++;
      }
    }
  }

  if (localDb) localDb.close();

  console.log('\n--- الملخص ---');
  console.log('الإضافات الجديدة:', summary.inserted);
  console.log('التحديثات/التجديدات:', summary.updated);
  console.log(`السجلات الموجودة مسبقاً بدون تغيير: ${summary.skippedExisting} | الصفوف الفارغة المتجاهلة: ${summary.skippedEmpty}`);

  if (!dryRun && !skipAccessSync && syncItems.length > 0) {
    console.log(`\n🔄 جاري مزامنة ${syncItems.length} سجل (جديد + محدث) مع نظام الشير (Access Hub)...`);
    for (const item of syncItems) {
      await notifySaved(db, item.uuid, item.oldRow, item.newRow);
    }
    const flushRes = await flushQueue(db);
    console.log(`✅ اكتملت مزامنة الشير! المتبقي في الطابور: ${flushRes.remaining}`);
  } else if (!dryRun && syncItems.length === 0) {
    console.log('\n✅ لا توجد سجلات جديدة أو محدثة لإضافتها.');
  }
}

main().catch((err) => {
  console.error('❌ خطأ أثناء الاستيراد:', err);
  process.exit(1);
});
