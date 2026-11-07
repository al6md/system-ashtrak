// ربط نظام الاشتراكات بنظام Share COC (Access Hub).
// - يعمل في الخلفية بعد نجاح الحفظ المحلي، ولا يرمي أي خطأ ولا يؤثر على النظام عند فشله.
// - للإيقاف الفوري: ACCESS_SYNC_ENABLED=false
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const API_URL = process.env.ACCESS_SYNC_URL || 'https://web-dashboard-pi-self.vercel.app/api/access-hub';
const GUID = process.env.ACCESS_SYNC_GUID || 'SUBS-SYNC-64564f5f-9443-4446-ab98-45e728ff48f3';
const FILE_NAME = 'اسماء التجار والدلالين من جهاز الاشتراكات';
const ENABLED = String(process.env.ACCESS_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false';
const SYNC_COMPANIES = String(process.env.ACCESS_SYNC_COMPANIES ?? 'true').toLowerCase() === 'true';
const CUTOFF_DATE = '2024-01-01'; // لا يُرسل/يُحدَّث ما هو أقدم إلا إذا كان مرسلاً سابقاً

const LEDGER_PATH = path.join(DATA, 'access_sync_live.json');      // ما أُرسل عبر الربط المباشر
const BACKFILL_LEDGER = path.join(__dirname, 'access_backfill', 'ledger.json'); // ما أُرسل عبر الترحيل (قراءة فقط)
const QUEUE_PATH = path.join(DATA, 'access_sync_queue.json');

const CLASS = { '0': 'الممتاز', '1': 'الاول', '2': 'الثاني', '3': 'الثالث', '4': 'الرابع' };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return d; } };
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (e) { console.warn('[AccessSync] write failed', p, e.message); } };
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= '1980-01-01' && d <= '2027-12-31';

export function mapRow(r) {
  const type = r.member_type === 'broker' ? 'broker' : r.member_type === 'company' ? 'company' : 'trader';
  const cls = CLASS[String(r.card_class)];
  if (type === 'company') {
    return {
      type,
      table: 'الشركات',
      record: {
        ArabicName: r.ceo_name || r.name,
        ArabicCommercialName: r.company_name || r.commercial_name,
        EnglishName: r.english_company_name || r.english_name || null,
        'اسم الشركة': r.company_name || r.commercial_name,
        'اسم صاحب المكتب': r.ceo_name || r.name,
        'رقم الأسم التجاري': r.commercial_name_no || null,
        CommercialNo: r.commercial_name_no || null,
        'تاريخه': r.affiliation_date || null,
        AffiliationDate: r.affiliation_date || null,
        ExpirationDate: r.expire_date || null,
        'العنوان': r.address || null,
        Address: r.address || null,
        'العمل': r.activity || null,
        Activity: r.activity || null,
        SpecificActivity: r.speciality || null,
        'رقم الهاتف': r.phone_number || null,
        Mobile: r.phone_number || null,
        IDNo: r.card_no || r.incorporation_certificate_no || null,
        'رقم اجازة التأسيس': r.incorporation_certificate_no || null,
        RenewalNo: r.renewal_no || null,
        Class: cls || null,
      }
    };
  }
  const record = {
    ArabicName: r.name, EnglishName: r.english_name || null, ArabicCommercialName: r.commercial_name || null,
    Activity: r.activity || null, SpecificActivity: r.speciality || null, EnglishActivity: r.english_activity || null,
    Class: cls ? cls + (type === 'broker' ? ' دلالية' : '') : null, Address: r.address || null,
    RenewalNo: r.renewal_no || null, AffiliationDate: r.affiliation_date || null, ExpirationDate: r.expire_date || null,
    IDNo: r.card_no || null, CommercialNo: r.commercial_name_no || null,
  };
  if (type === 'trader') record.Mobile = r.phone_number || null; else record.StampNo = r.stamp_no || null;
  return { type, table: type === 'broker' ? 'الدلالين' : 'التجار', record };
}

let queue = readJson(QUEUE_PATH, []); // [{key, tries}]
let busy = false;

function adhIdFor(uuid) {
  return readJson(LEDGER_PATH, {})[uuid]?.adh_id || readJson(BACKFILL_LEDGER, {})[uuid]?.adh_id || null;
}

async function call(method, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(API_URL, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-machine-guid': GUID }, body: JSON.stringify({ ...body, guid: GUID }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(`HTTP ${res.status} ${j.error || ''}`);
    return j;
  } finally { clearTimeout(t); }
}

// يرجع true عند الانتهاء (نجاح أو تجاوز مقصود)، وfalse إن وجب إعادة المحاولة
async function syncOne(db, key) {
  const row = await db.prepare('SELECT * FROM traders WHERE uuid = ? OR id = ?').get(key, key);
  if (!row || (row.deleted_at && row.deleted_at !== '')) return true;
  const m = mapRow(row);
  if (m.type === 'company' && !SYNC_COMPANIES) return true;
  if (!row.name && !row.company_name) return true;
  const adhId = adhIdFor(row.uuid);
  if (adhId) {
    await call('PUT', { id: adhId, updates: m.record });
    console.log('[AccessSync] updated', m.table, row.name || row.company_name);
    return true;
  }
  // سجل لم يُرسل سابقاً: يُرسل فقط إن كان جديداً وتاريخه سليم (لتفادي تكرار السجلات القديمة)
  if (!validDate(row.affiliation_date) || row.affiliation_date < CUTOFF_DATE) {
    console.log('[AccessSync] skipped (old/invalid date, not previously synced):', row.name || row.company_name);
    return true;
  }
  const j = await call('POST', { file: FILE_NAME, table: m.table, record: m.record });
  const led = readJson(LEDGER_PATH, {});
  led[row.uuid] = { adh_id: j.record?._adh_id, table: m.table, name: row.name || row.company_name, sent_at: new Date().toISOString() };
  writeJson(LEDGER_PATH, led);
  console.log('[AccessSync] added', m.table, row.name || row.company_name);
  return true;
}

async function drain(db) {
  if (busy || !ENABLED) return;
  busy = true;
  try {
    while (queue.length) {
      const item = queue[0];
      try {
        await syncOne(db, item.key);
        queue.shift();
      } catch (e) {
        item.tries = (item.tries || 0) + 1;
        console.warn(`[AccessSync] failed (${item.tries}):`, e.message);
        if (item.tries >= 30) queue.shift(); // بعد 30 محاولة يُسقط ويُسجَّل
        writeJson(QUEUE_PATH, queue);
        break; // إعادة المحاولة في الدورة التالية
      }
      writeJson(QUEUE_PATH, queue);
    }
  } finally { busy = false; }
}

let timerStarted = false;
export function notifySaved(db, key) {
  try {
    if (!ENABLED || !key) return;
    if (!queue.some((q) => q.key === key)) { queue.push({ key, tries: 0 }); writeJson(QUEUE_PATH, queue); }
    setImmediate(() => drain(db).catch(() => {}));
    if (!timerStarted) { timerStarted = true; setInterval(() => drain(db).catch(() => {}), 120000).unref(); }
  } catch (e) { console.warn('[AccessSync] notify error', e.message); }
}
