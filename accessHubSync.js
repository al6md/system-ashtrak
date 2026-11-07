// ربط نظام الاشتراكات بنظام Share COC (Access Hub).
// - يدعم المزامنة الفورية للإضافة، التعديل، والحذف.
// - يعمل مع السحابة (Vercel + Turso) ومع السيرفر المحلي بدون التأثير على استقرار النظام.
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
const writeJson = (p, v) => { try { fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (_) {} };

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

let queue = readJson(QUEUE_PATH, []); // [{key, action, oldRow, tries}]
let busy = false;

function adhIdFor(uuid) {
  if (!uuid) return null;
  const live = readJson(LEDGER_PATH, {});
  if (live[uuid]?.adh_id) return live[uuid].adh_id;
  const back = readJson(BACKFILL_LEDGER, {});
  return back[uuid]?.adh_id || null;
}

async function saveAdhIdToDb(db, uuid, adhId) {
  if (!uuid || !adhId) return;
  try {
    await db.prepare('UPDATE traders SET adh_id = ? WHERE uuid = ? OR id = ?').run(adhId, uuid, uuid);
  } catch (_) {}
}

async function call(method, body = {}, query = '') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
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
 * البحث في Access Hub للعثور على معرّف القيد السحابي _adh_id بحال لم يكن مسجلاً
 * يطابق الاسم مع رقم الهوية معاً لتجنب استبدال تاجر قديم يحمل نفس رقم الهوية!
 */
async function findAdhIdBySearch(cardNo, name, table) {
  const cleanName = String(name || '').trim();
  const cleanCard = String(cardNo || '').trim();
  const q = cleanName || cleanCard;
  if (!q) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const url = `${API_URL}?file=${encodeURIComponent(FILE_NAME)}&table=${encodeURIComponent(table)}&search=${encodeURIComponent(q)}&limit=50`;
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

    // 1. مطابقة دقيقة للاسم + رقم الهوية معاً (الأهم لمنع تضارب أرقام الهويات المكررة عبر السنوات)
    if (cleanName && cleanCard) {
      const exactBoth = rows.find(r => {
        const rName = String(r.ArabicName || r['اسم الشركة'] || '').trim();
        const rCard = String(r.IDNo || r['رقم اجازة التأسيس'] || '').trim();
        return rName === cleanName && rCard === cleanCard;
      });
      if (exactBoth?._adh_id) return exactBoth._adh_id;
    }

    // 2. مطابقة دقيقة للاسم الكامل
    if (cleanName) {
      const exactName = rows.find(r => {
        const rName = String(r.ArabicName || r['اسم الشركة'] || '').trim();
        return rName === cleanName;
      });
      if (exactName?._adh_id) return exactName._adh_id;
    }

    return null;
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
  const oldRow = item.oldRow || null;

  const row = await db.prepare('SELECT * FROM traders WHERE uuid = ? OR id = ?').get(key, key);
  const isDeleted = explicitAction === 'delete' || Boolean(row && row.deleted_at && row.deleted_at !== '');

  // 1. حالة الحذف (DELETE)
  if (isDeleted) {
    const refRow = row || oldRow;
    let adhId = refRow?.adh_id || oldRow?.adh_id || adhIdFor(refRow?.uuid || key);
    let table = 'التجار';

    if (refRow) {
      const m = mapRow(refRow);
      table = m.table;
      if (!adhId) {
        adhId = await findAdhIdBySearch(
          refRow.card_no || refRow.incorporation_certificate_no,
          refRow.name || refRow.company_name,
          table
        );
      }
    }

    if (adhId) {
      await call('DELETE', {}, `?id=${encodeURIComponent(adhId)}`);
      const led = readJson(LEDGER_PATH, {});
      const k = refRow?.uuid || key;
      led[k] = {
        ...(led[k] || {}),
        adh_id: adhId,
        table,
        deleted: true,
        deleted_at: new Date().toISOString()
      };
      writeJson(LEDGER_PATH, led);
      console.log(`[AccessSync] DELETED from Share COC: [${table}] ${refRow?.name || refRow?.company_name || key}`);
      return true;
    } else {
      console.log(`[AccessSync] Record already not present or deleted in Share: ${refRow?.name || key}`);
      return true;
    }
  }

  // 2. حالة الإضافة أو التعديل (ADD / SAVE / UPDATE)
  if (!row) return true;
  const m = mapRow(row);
  if (m.type === 'company' && !SYNC_COMPANIES) return true;
  if (!row.name && !row.company_name) return true;

  // إذا كانت العملية إضافة اسم جديد (explicitAction === 'add')، نرسله مباشرة عبر POST ليظهر في أعلى القائمة (#1)
  let adhId = explicitAction === 'add' ? null : (row.adh_id || oldRow?.adh_id || adhIdFor(row.uuid));

  // في حالة التعديل فقط: إذا لم يكن المعرف محفوظاً، نبحث عنه باستخدام بيانات السجل قبل التعديل (أو الحالية)
  if (!adhId && explicitAction !== 'add') {
    const searchCard = oldRow ? (oldRow.card_no || oldRow.incorporation_certificate_no) : (row.card_no || row.incorporation_certificate_no);
    const searchName = oldRow ? (oldRow.name || oldRow.company_name) : (row.name || row.company_name);
    adhId = await findAdhIdBySearch(searchCard, searchName, m.table);
    if (!adhId && oldRow && (oldRow.name !== row.name || oldRow.card_no !== row.card_no)) {
      adhId = await findAdhIdBySearch(row.card_no || row.incorporation_certificate_no, row.name || row.company_name, m.table);
    }
  }

  // إذا وجدنا القيد في Share (تعديل)، نرسل طلب PUT
  if (adhId) {
    await call('PUT', { id: adhId, updates: m.record });
    await saveAdhIdToDb(db, row.uuid, adhId);
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

  // إضافة قيد جديد عبر POST (يظهر في أول سطر #1 في نظام الشير)
  const j = await call('POST', { file: FILE_NAME, table: m.table, record: m.record });
  const newAdhId = j.record?._adh_id;
  if (newAdhId) {
    await saveAdhIdToDb(db, row.uuid, newAdhId);
  }
  const led = readJson(LEDGER_PATH, {});
  led[row.uuid] = {
    adh_id: newAdhId,
    table: m.table,
    name: row.name || row.company_name,
    sent_at: new Date().toISOString()
  };
  writeJson(LEDGER_PATH, led);
  console.log(`[AccessSync] ADDED to Share COC: [${m.table}] ${row.name || row.company_name} -> ${newAdhId}`);
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
        if (item.tries >= 10) queue.shift();
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

async function enqueue(db, key, action = 'save', oldRow = null) {
  try {
    if (!ENABLED || !key) return;
    const existing = queue.find(q => q.key === key);
    if (existing) {
      existing.action = action;
      if (oldRow) existing.oldRow = oldRow;
    } else {
      queue.push({ key, action, oldRow, tries: 0 });
      writeJson(QUEUE_PATH, queue);
    }
    if (!timerStarted) {
      timerStarted = true;
      setInterval(() => drain(db).catch(() => {}), 60000).unref();
    }
    await drain(db);
  } catch (e) {
    console.warn('[AccessSync] notify error:', e.message);
  }
}

export async function notifyAdded(db, key) {
  return enqueue(db, key, 'add');
}

export async function notifySaved(db, key, oldRow = null) {
  return enqueue(db, key, 'save', oldRow);
}

export async function notifyDeleted(db, key, oldRow = null) {
  return enqueue(db, key, 'delete', oldRow);
}
