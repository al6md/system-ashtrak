import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = __dirname;

const DB_PATH = path.join(projectDir, 'data', 'cardval.db');
const CSV_PATH = path.join(projectDir, 'companies-20261103-214221.csv');

if (!fs.existsSync(CSV_PATH)) {
  console.error('❌ ملف CSV للشركات غير موجود في المسار:', CSV_PATH);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);

console.log('🚀 فحص وتحديث هيكل قاعدة البيانات لدعم بيانات الشركات...');

// Ensure company columns exist
const tableInfo = db.prepare("PRAGMA table_info(traders)").all();
const colNames = tableInfo.map(c => c.name);

function addColumnIfNotExists(colName, colType) {
  if (!colNames.includes(colName)) {
    db.exec(`ALTER TABLE traders ADD COLUMN ${colName} ${colType};`);
    console.log(`  ➕ تم إضافة العمود: ${colName}`);
  }
}

addColumnIfNotExists('company_name', 'TEXT');
addColumnIfNotExists('english_company_name', 'TEXT');
addColumnIfNotExists('ceo_name', 'TEXT');
addColumnIfNotExists('english_ceo_name', 'TEXT');
addColumnIfNotExists('incorporation_certificate_no', 'TEXT');
addColumnIfNotExists('incorporation_certificate_symbol', 'TEXT');

// Clean previous company import
db.exec("DELETE FROM traders WHERE member_type = 'company';");

function parseCsvLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
}

const fileStream = fs.createReadStream(CSV_PATH, { encoding: 'utf8' });
const rl = readline.createInterface({
  input: fileStream,
  crlfDelay: Infinity
});

let isHeader = true;
let insertedCount = 0;
let skippedCount = 0;
const seenKeys = new Set();

const insertStmt = db.prepare(`
  INSERT INTO traders (
    uuid, name, english_name, commercial_name,
    company_name, english_company_name, ceo_name, english_ceo_name,
    activity, english_activity,
    card_no, renewal_no, card_class, commercial_name_no,
    incorporation_certificate_no, incorporation_certificate_symbol,
    speciality, phone_number, address,
    affiliation_date, expire_date,
    created_by, created_at, updated_at, deleted_at,
    member_type
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    'company'
  )
`);

console.log('📦 بدء استيراد وإدراج سجلات الشركات من ملف الـ CSV...');

db.exec('BEGIN TRANSACTION;');

rl.on('line', (line) => {
  if (!line || !line.trim()) return;
  if (isHeader) {
    isHeader = false;
    return;
  }

  const cols = parseCsvLine(line.replace(/^\uFEFF/, ''));
  if (cols.length < 5) {
    skippedCount++;
    return;
  }

  const [
    company_name,
    english_company_name,
    ceo_name,
    english_ceo_name,
    activity,
    english_activity,
    card_no,
    renewal_no,
    card_class,
    commercial_name_no,
    incorporation_certificate_no,
    incorporation_certificate_symbol,
    speciality,
    phone_number,
    address,
    affiliation_date,
    expire_date,
    created_by,
    created_at,
    updated_at,
    deleted_at
  ] = cols;

  if (!company_name && !ceo_name) {
    skippedCount++;
    return;
  }

  // Deduplication check
  const key = `${(company_name || '').trim()}___${(commercial_name_no || '').trim()}___${(card_no || '').trim()}`;
  if (seenKeys.has(key)) {
    skippedCount++;
    return;
  }
  seenKeys.add(key);

  const nameVal = ceo_name || company_name || '';
  const enNameVal = english_ceo_name || english_company_name || '';
  const commVal = company_name || '';
  const uuid = crypto.randomUUID();

  try {
    insertStmt.run(
      uuid,
      nameVal,
      enNameVal,
      commVal,
      company_name || '',
      english_company_name || '',
      ceo_name || '',
      english_ceo_name || '',
      activity || '',
      english_activity || '',
      card_no || '',
      renewal_no || '',
      card_class || '',
      commercial_name_no || '',
      incorporation_certificate_no || '',
      incorporation_certificate_symbol || '',
      speciality || '',
      phone_number || '',
      address || '',
      affiliation_date || '',
      expire_date || '',
      created_by || 'Site Admin',
      created_at || new Date().toISOString(),
      updated_at || new Date().toISOString(),
      deleted_at || ''
    );
    insertedCount++;
  } catch (err) {
    console.error('Error inserting row:', err.message);
    skippedCount++;
  }
});

rl.on('close', () => {
  db.exec('COMMIT;');
  console.log('========================================================');
  console.log('✅ اكتمل استيراد بيانات قسم الشركات بنجاح تام!');
  console.log(`📊 إجمالي عدد الشركات المخزنة: ${insertedCount}`);
  console.log(`⚠️ السجلات المتجاهلة (المكررة): ${skippedCount}`);
  console.log('========================================================');
});
