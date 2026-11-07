// ربط نظام الاشتراكات بنظام Share COC (Access Hub).
// - يدعم المزامنة الفورية للإضافة، التعديل، والحذف.
// - يعمل في الخلفية بعد نجاح الحفظ/الحذف المحلي، ولا يرمي أي خطأ ولا يؤثر على النظام عند فشله.
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

const LEDGER_PATH = path.join(DATA, 'access_sync_live.json');      // ما أُرسل عبر الربط المباشر
const BACKFILL_LEDGER = path.join(__dirname, 'access_backfill', 'ledger.json'); // ما أُرسل عبر الترحيل (قراءة فقط)
const QUEUE_PATH = path.join(DATA, 'access_sync_queue.json');

const CLASS = { '0': 'الممتاز', '1': 'الاول', '2': 'الثاني', '3': 'الثالث', '4': 'الرابع' };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return d; } };
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (e) { console.warn('[AccessSync] write failed', p, e.message); } };

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

let queue = readJson(QUEUE_PATH, []); // [{key, action, tries}]
let busy = false;

function adhIdFor(uuid) {
  if (!uuid) return null;
  const live = readJson(LEDGER_PATH, {});
  const back = readJson(BACKFILL_LEDGER, {});
  return live[uuid]?.adh_id || back[uuid]?.adh_id || null;
}

async function call(method, body = {}, query = '') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const url = query ? `${API_URL}${query}` : API_URL;
    const isNoBody = method === 'GET' || method === 'DELETE';
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-machine-guid': GUID,
        'x-admin-role': 'admin'
      },
      body: isNoBody ? undefined : JSON.stringify({ ...body, guid: GUID })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(`HTTP ${res.status} ${j.error || ''}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

/**
 * البحث في Access Hub للبحث عن معرّف القيد السحابي _adh_id بحال لم يكن مسجلاً في السجل المحلي
 */
async function findAdhIdBySearch(cardNo, name, table) {
  const q = cardNo || name;
  if (!q) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const url = `${API_URL}?file=${encodeURIComponent(FILE_NAME)}&table=${encodeURIComponent(table)}&search=${encodeURIComponent(q)}&limit=25`;
    const res = await fetch(url, {
      method: 'GET',
      signal: ctl.signal,
      headers: {
        'x-machine-guid': GUID,
        'x-admin-role': 'admin'
      }
    });
    const data = await res.json().catch(() => ({}));
    const rows = data.rows || [];
    const match = rows.find(r => 
      (cardNo && String(r.IDNo || '').trim() === String(cardNo).trim()) ||
      (name && String(r.ArabicName || '').trim() === String(name).trim()) ||
      (name && String(r['اسم الشركة'] || '').trim() === String(name).trim())
    );
    return match?._adh_id || null;
  } catch (err) {
    console.warn('[AccessSync] Search fallback error:', err.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * معالجة مزامنة عنصر واحد (إضافة أو تعديل أو حذف)
 */
async function syncOne(db, item) {
  const key = item.key;
  const explicitAction = item.action || 'save';

  const row = await db.prepare('SELECT * FROM traders WHERE uuid = ? OR id = ?').get(key, key);
  const isDeleted = explicitAction === 'delete' || Boolean(row && row.deleted_at && row.deleted_at !== '');

  // 1. حالة الحذف (DELETE)
  if (isDeleted) {
    let adhId = adhIdFor(row?.uuid || key);
    let table = 'التجار';

    if (row) {
      const m = mapRow(row);
      table = m.table;
      if (!adhId) {
        adhId = await findAdhIdBySearch(row.card_no || row.incorporation_certificate_no, row.name || row.company_name, table);
      }
    }

    if (adhId) {
      await call('DELETE', {}, `?id=${encodeURIComponent(adhId)}`);
      const led = readJson(LEDGER_PATH, {});
      const k = row?.uuid || key;
      led[k] = {
        ...(led[k] || {}),
        adh_id: adhId,
        table,
        deleted: true,
        deleted_at: new Date().toISOString()
      };
      writeJson(LEDGER_PATH, led);
      console.log(`[AccessSync] DELETED from Share COC: [${table}] ${row?.name || row?.company_name || key}`);
      return true;
    } else {
      console.log(`[AccessSync] Record already not present or deleted in Share: ${row?.name || key}`);
      return true;
    }
  }

  // 2. حالة الإضافة أو التعديل (SAVE / UPDATE)
  if (!row) return true;
  const m = mapRow(row);
  if (m.type === 'company' && !SYNC_COMPANIES) return true;
  if (!row.name && !row.company_name) return true;

  let adhId = adhIdFor(row.uuid);

  // إذا لم يكن المعرف في السجل المحلي، نحاول البحث عنه في Share
  if (!adhId) {
    adhId = await findAdhIdBySearch(row.card_no || row.incorporation_certificate_no, row.name || row.company_name, m.table);
  }

  // إذا وجدنا القيد في Share، نرسل طلب التعديل PUT
  if (adhId) {
    await call('PUT', { id: adhId, updates: m.record });
    const led = readJson(LEDGER_PATH, {});
    led[row.uuid] = {
      adh_id: adhId,
      table: m.table,
      name: row.name || row.company_name,
      updated_at: new Date().toISOString()
    };
    writeJson(LEDGER_PATH, led);
    console.log(`[AccessSync] UPDATED in Share COC: [${m.table}] ${row.name || row.company_name}`);
    return true;
  }

  // إذا لم يكن موجوداً أصلاً، نرسل طلب الإضافة POST
  const j = await call('POST', { file: FILE_NAME, table: m.table, record: m.record });
  const newAdhId = j.record?._adh_id;
  const led = readJson(LEDGER_PATH, {});
  led[row.uuid] = {
    adh_id: newAdhId,
    table: m.table,
    name: row.name || row.company_name,
    sent_at: new Date().toISOString()
  };
  writeJson(LEDGER_PATH, led);
  console.log(`[AccessSync] ADDED to Share COC: [${m.table}] ${row.name || row.company_name}`);
  return true;
}

async function drain(db) {
  if (busy || !ENABLED) return;
  busy = true;
  try {
    while (queue.length) {
      const item = queue[0];
      try {
        await syncOne(db, item);
        queue.shift();
      } catch (e) {
        item.tries = (item.tries || 0) + 1;
        console.warn(`[AccessSync] failed (${item.tries}):`, e.message);
        if (item.tries >= 10) queue.shift(); // بعد 10 محاولات يسقط لتجنب تجميد الطابور
        writeJson(QUEUE_PATH, queue);
        break;
      }
      writeJson(QUEUE_PATH, queue);
    }
  } finally {
    busy = false;
  }
}

let timerStarted = false;

function enqueue(db, key, action = 'save') {
  try {
    if (!ENABLED || !key) return;
    const existing = queue.find(q => q.key === key);
    if (existing) {
      existing.action = action;
    } else {
      queue.push({ key, action, tries: 0 });
      writeJson(QUEUE_PATH, queue);
    }
    setImmediate(() => drain(db).catch(() => {}));
    if (!timerStarted) {
      timerStarted = true;
      setInterval(() => drain(db).catch(() => {}), 60000).unref();
    }
  } catch (e) {
    console.warn('[AccessSync] notify error:', e.message);
  }
}

export function notifySaved(db, key) {
  enqueue(db, key, 'save');
}

export function notifyDeleted(db, key) {
  enqueue(db, key, 'delete');
}
