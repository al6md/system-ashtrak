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
const db = new DatabaseSync(DB_PATH);

console.log('🚀 فحص وتحديث هيكل قاعدة البيانات لدعم بيانات الدلالين...');

// Ensure broker columns exist
const tableInfo = db.prepare("PRAGMA table_info(traders)").all();
const colNames = tableInfo.map(c => c.name);

function addColumnIfNotExists(colName, colType) {
  if (!colNames.includes(colName)) {
    db.exec(`ALTER TABLE traders ADD COLUMN ${colName} ${colType};`);
    console.log(`  ➕ تم إضافة العمود: ${colName}`);
  }
}

addColumnIfNotExists('stamp_no', 'TEXT');

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

// Preserve existing photo_path and uuid if available
const existingPhotos = new Map();
try {
  const currentBrokers = db.prepare("SELECT card_no, stamp_no, name, photo_path, uuid FROM traders WHERE member_type = 'broker' AND photo_path IS NOT NULL").all();
  for (const b of currentBrokers) {
    if (b.card_no && b.card_no !== '0') existingPhotos.set(`card_${b.card_no}`, { photo_path: b.photo_path, uuid: b.uuid });
    if (b.stamp_no && b.stamp_no !== '0') existingPhotos.set(`stamp_${b.stamp_no}`, { photo_path: b.photo_path, uuid: b.uuid });
    if (b.name) existingPhotos.set(`name_${b.name}`, { photo_path: b.photo_path, uuid: b.uuid });
  }
  if (existingPhotos.size > 0) {
    console.log(`  💾 تم الاحتفاظ بـ ${existingPhotos.size} صورة موجودة مسبقاً للدلالين.`);
  }
} catch (e) {}

// Clean previous broker imports
db.exec("DELETE FROM traders WHERE member_type = 'broker';");

const usedUuids = new Set(db.prepare("SELECT uuid FROM traders").all().map(r => r.uuid));

const insertStmt = db.prepare(`
  INSERT INTO traders (
    uuid, name, english_name, commercial_name,
    activity, english_activity,
    card_no, stamp_no, renewal_no, card_class, commercial_name_no,
    phone_number, address,
    affiliation_date, expire_date,
    created_by, created_at, updated_at, deleted_at,
    photo_path,
    member_type
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    ?,
    'broker'
  )
`);

const insertFromCompanyFormatStmt = db.prepare(`
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
    'broker'
  )
`);

const seenKeys = new Set();
let insertedCount = 0;

// 1. First, import from the official brokers file (1652 brokers)
const officialCsvPath = path.join(projectDir, 'brokers_official.csv');
if (fs.existsSync(officialCsvPath)) {
  console.log('📂 جاري استيراد الدلالين من ملف الدلالين الرسمي (brokers_official.csv)...');
  const lines = fs.readFileSync(officialCsvPath, 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 10) continue;

    const name = cols[0] || '';
    const english_name = cols[1] || '';
    const commercial_name = cols[2] || '';
    const activity = cols[3] || 'دلالية العقارات';
    const english_activity = cols[4] || 'Real Estates BROKER';
    const card_no = cols[5] || '';
    const stamp_no = cols[6] || '';
    const renewal_no = cols[7] || '';
    const card_class = cols[8] || '1';
    const commercial_name_no = cols[9] || '';
    const phone_number = cols[10] || '';
    const address = cols[11] || '';
    const affiliation_date = cols[12] || '';
    const expire_date = cols[13] || '';
    const created_by = cols[14] || 'Site Admin';
    const created_at = cols[15] || '';
    const updated_at = cols[16] || '';
    const deleted_at = cols[17] || null;

    const key = `${card_no}_${name}_${commercial_name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const saved = existingPhotos.get(`card_${card_no}`) || existingPhotos.get(`stamp_${stamp_no}`) || existingPhotos.get(`name_${name}`);
    let uuid = (saved?.uuid && !usedUuids.has(saved.uuid)) ? saved.uuid : crypto.randomUUID();
    while (usedUuids.has(uuid)) {
      uuid = crypto.randomUUID();
    }
    usedUuids.add(uuid);
    const photo_path = saved?.photo_path || null;

    insertStmt.run(
      uuid, name, english_name, commercial_name,
      activity, english_activity,
      card_no, stamp_no, renewal_no, card_class, commercial_name_no,
      phone_number, address,
      affiliation_date, expire_date,
      created_by, created_at, updated_at, deleted_at,
      photo_path
    );
    insertedCount++;
  }
  console.log(`  ✅ تم استيراد ${insertedCount} دلال من ملف الدلالين الرسمي.`);
}

// 2. Also check the user's uploaded file (media_*.csv or uploaded_companies.csv)
// If there are specific broker/intermediary companies in it that aren't already imported:
const userUploadedPath = 'C:/Users/tohiba/.gemini/antigravity/brain/1d2c0a7d-c341-4c36-88ef-bad76a16dd33/.user_uploaded/media_1793967433249_d79943da.csv';
if (fs.existsSync(userUploadedPath)) {
  console.log('📂 فحص الملف المرفوع من المستخدم لاستخراج أي دلالين/وسطاء إضافيين...');
  const userLines = fs.readFileSync(userUploadedPath, 'utf8').split('\n');
  let userInserted = 0;
  for (let i = 1; i < userLines.length; i++) {
    const line = userLines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 15) continue;

    const compName = cols[0] || '';
    const enCompName = cols[1] || '';
    const ceoName = cols[2] || '';
    const enCeoName = cols[3] || '';
    const activity = cols[4] || '';
    const enActivity = cols[5] || '';
    const card_no = cols[6] || '';
    const renewal_no = cols[7] || '';
    const card_class = cols[8] || '0';
    const comm_no = cols[9] || '';
    const inc_cert_no = cols[10] || '';
    const inc_cert_sym = cols[11] || '';
    const speciality = cols[12] || '';
    const phone = cols[13] || '';
    const address = cols[14] || '';
    const aff_date = cols[15] || '';
    const exp_date = cols[16] || '';
    const created_by = cols[17] || 'Site Admin';
    const created_at = cols[18] || '';
    const updated_at = cols[19] || '';
    const deleted_at = cols[20] || null;

    const fullText = (compName + ' ' + activity + ' ' + enActivity + ' ' + speciality).toLowerCase();
    const isBrokerRelated = fullText.includes('دلال') || fullText.includes('broker') || fullText.includes('وساط') || fullText.includes('توسط');

    if (isBrokerRelated) {
      const key = `${card_no}_${compName}_${ceoName}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        let uuid = crypto.randomUUID();
        while (usedUuids.has(uuid)) {
          uuid = crypto.randomUUID();
        }
        usedUuids.add(uuid);
        insertFromCompanyFormatStmt.run(
          uuid, ceoName, enCeoName, compName,
          compName, enCompName, ceoName, enCeoName,
          activity, enActivity,
          card_no, renewal_no, card_class, comm_no,
          inc_cert_no, inc_cert_sym,
          speciality, phone, address,
          aff_date, exp_date,
          created_by, created_at, updated_at, deleted_at
        );
        userInserted++;
      }
    }
  }
  console.log(`  ➕ تم إضافة ${userInserted} سجلات وساطة/دلالية مستخرجة من الملف المرفق.`);
}

const totalInDb = db.prepare("SELECT COUNT(*) as count FROM traders WHERE member_type = 'broker'").get().count;
console.log(`\n🎉 اكتمل الاستيراد بنجاح! إجمالي الدلالين في قاعدة البيانات الآن: ${totalInDb}`);
