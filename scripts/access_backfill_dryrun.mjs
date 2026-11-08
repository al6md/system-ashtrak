// قراءة فقط: يجهّز الأسماء الناقصة في Share من نظام الاشتراكات. لا يرسل ولا يعدّل أي شيء.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SUBS_DB = 'c:/Users/tohiba/OneDrive/Desktop/نظام اشتراكات/data/cardval.db';
const SHARE_DIR = 'C:/Users/tohiba/Desktop/شييييير/web-dashboard/data/access-hub';
const MAIN_FILE = 'اسماء التجار والدلالين من جهاز الاشتراكات';
const OUT_DIR = 'c:/Users/tohiba/OneDrive/Desktop/نظام اشتراكات/access_backfill';
fs.mkdirSync(OUT_DIR, { recursive: true });

const norm = (s) => String(s ?? '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= '1980-01-01' && d <= '2027-12-31';
const CLASS = { '0': 'الممتاز', '1': 'الاول', '2': 'الثاني', '3': 'الثالث', '4': 'الرابع' };

// Share: كل ما فيه (من كل الملفات) لمنع التكرار
const shareKeys = { trader: new Set(), broker: new Set(), company: new Set() };
let companyCols = {};
for (const f of fs.readdirSync(SHARE_DIR).filter((x) => x.endsWith('.json') && x !== 'index.json' && x !== 'mutations.json')) {
  const j = JSON.parse(fs.readFileSync(path.join(SHARE_DIR, f), 'utf-8'));
  for (const [t, rows] of Object.entries(j.tables || {})) {
    if (t === 'التجار') rows.forEach((r) => shareKeys.trader.add(`${norm(r.ArabicName || r['اسم التاجر'])}|${r.IDNo || ''}|${r.AffiliationDate || ''}`));
    if (t === 'الدلالين') rows.forEach((r) => shareKeys.broker.add(`${norm(r.ArabicName)}|${r.IDNo || ''}|${r.AffiliationDate || ''}`));
    if (t === 'الشركات') { companyCols = j.columns?.[t] ? { [f]: j.columns[t] } : companyCols; rows.forEach((r) => shareKeys.company.add(`${norm(r['اسم الشركة'])}|${r['رقم الأسم التجاري'] || ''}`)); }
  }
}

const db = new DatabaseSync(SUBS_DB, { readOnly: true });
const rows = db.prepare("select * from traders where (deleted_at is null or deleted_at='')").all();

const toSend = [], dup = [], badDate = [], missing = [];
for (const r of rows) {
  const type = r.member_type === 'broker' ? 'broker' : r.member_type === 'company' ? 'company' : 'trader';
  if (!r.name && !r.company_name) { missing.push(r); continue; }
  let key, rec, table;
  if (type === 'company') {
    table = 'الشركات';
    key = `${norm(r.company_name || r.commercial_name)}|${r.commercial_name_no || ''}`;
    rec = { 'اسم الشركة': r.company_name || r.commercial_name, 'اسم صاحب المكتب': r.ceo_name || r.name, 'رقم الأسم التجاري': r.commercial_name_no || null, 'تاريخه': r.affiliation_date || null, 'العنوان': r.address || null, 'العمل': r.activity || null, 'رقم الهاتف': r.phone_number || null, 'رقم اجازة التأسيس': r.incorporation_certificate_no || null };
  } else {
    table = type === 'broker' ? 'الدلالين' : 'التجار';
    key = `${norm(r.name)}|${r.card_no || ''}|${r.affiliation_date || ''}`;
    rec = { ArabicName: r.name, EnglishName: r.english_name || null, ArabicCommercialName: r.commercial_name || null, Activity: r.activity || null, SpecificActivity: r.speciality || null, EnglishActivity: r.english_activity || null, Class: (CLASS[String(r.card_class)] || null) && CLASS[String(r.card_class)] + (type === 'broker' ? ' دلالية' : ''), Address: r.address || null, RenewalNo: r.renewal_no || null, AffiliationDate: r.affiliation_date || null, ExpirationDate: r.expire_date || null, IDNo: r.card_no || null, CommercialNo: r.commercial_name_no || null };
    if (type === 'trader') rec.Mobile = r.phone_number || null; else rec.StampNo = r.stamp_no || null;
  }
  if (shareKeys[type].has(key)) { dup.push({ type, name: r.name, card_no: r.card_no, date: r.affiliation_date }); continue; }
  if (!validDate(r.affiliation_date)) { badDate.push({ type, name: r.name || r.company_name, card_no: r.card_no, date: r.affiliation_date }); continue; }
  toSend.push({ uuid: r.uuid, type, file: MAIN_FILE, table, record: rec });
}

const count = (a, f) => a.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
const summary = { total_local_active: rows.length, already_in_share: dup.length, to_send: toSend.length, to_send_by_table: count(toSend, (x) => x.table), to_send_by_year: count(toSend, (x) => (x.record.AffiliationDate || x.record['تاريخه'] || '').slice(0, 4)), skipped_bad_date: badDate.length, skipped_no_name: missing.length, share_company_columns_example: companyCols };
fs.writeFileSync(path.join(OUT_DIR, 'to_send.json'), JSON.stringify(toSend, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'skipped_bad_date.json'), JSON.stringify(badDate, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
