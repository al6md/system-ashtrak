// رفع فائق السرعة لكافة الأسماء المتبقية (3000+ قيد) مباشرة إلى السحابة في ثوانٍ معدودة
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'c:/Users/tohiba/OneDrive/Desktop/نظام اشتراكات/access_backfill';
const items = JSON.parse(fs.readFileSync(`${DIR}/to_send.json`, 'utf-8'));
const ledgerPath = `${DIR}/ledger.json`;
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) : {};
const year = (x) => (x.record.AffiliationDate || x.record['تاريخه'] || '').slice(0, 4);

// 1. قراءة مفاتيح الاتصال المباشر بـ Google Drive
const envRaw = fs.readFileSync('C:/Users/tohiba/Desktop/شييييير/web-dashboard/.env.local', 'utf-8');
const env = Object.fromEntries(
  envRaw.split(/\r?\n/).filter(Boolean).map((l) => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
  })
);

console.log('⚡ بدء تسريع عملية رفع الأسماء إلى سحابة Share COC...');

// 2. تجديد التوكن
const tokRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.GDRIVE_CLIENT_ID,
    client_secret: env.GDRIVE_CLIENT_SECRET,
    refresh_token: env.GDRIVE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
});
const { access_token } = await tokRes.json();
if (!access_token) throw new Error('تعذر تجديد رمز الوصول لـ Google Drive');

// 3. العثور على ملف الطفرات والتعديلات السحابية
const q = `'${env.GDRIVE_FOLDER_ID}' in parents and name = '.sharecoc_access_mutations.json' and trashed = false`;
const listRes = await fetch(
  `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
  { headers: { Authorization: `Bearer ${access_token}` } }
);
const { files } = await listRes.json();
if (!files || !files.length) throw new Error('لم يتم العثور على ملف التعديلات السحابية على Google Drive');
const fileId = files[0].id;

// 4. تحميل أحدث نسخة حالية وأخذ نسخة احتياطية محلية
console.log('📥 تحميل أحدث نسخة من السحابة قبل الإضافة الجماعية...');
const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
const mutations = await getRes.json();
mutations.adds = Array.isArray(mutations.adds) ? mutations.adds : [];
mutations.updates = mutations.updates || {};
mutations.deletes = mutations.deletes || [];

fs.writeFileSync(`${DIR}/drive_mutations_backup_before_super_fast.json`, JSON.stringify(mutations, null, 1));
console.log(`✅ تم أخذ نسخة احتياطية سحابية. عدد القيود المضافة الحالية في السحابة: ${mutations.adds.length}`);

// 5. حصر القيود المتبقية (من سنة 2024 فما فوق)
const remaining = items.filter((x) => year(x) >= '2024' && !ledger[x.uuid]);
console.log(`📋 القيود المتبقية للإضافة: ${remaining.length} قيداً`);

let addedBatchCount = 0;
const nowIso = new Date().toISOString();

for (const x of remaining) {
  const sendRecord = { ...x.record };
  if (x.table === 'الشركات') {
    if (!sendRecord.ArabicName) sendRecord.ArabicName = sendRecord['اسم صاحب المكتب'] || sendRecord['اسم الشركة'];
    if (!sendRecord.ArabicCommercialName) sendRecord.ArabicCommercialName = sendRecord['اسم الشركة'];
    if (!sendRecord.Activity) sendRecord.Activity = sendRecord['العمل'];
    if (!sendRecord.Mobile) sendRecord.Mobile = sendRecord['رقم الهاتف'];
    if (!sendRecord.Address) sendRecord.Address = sendRecord['العنوان'];
    if (!sendRecord.AffiliationDate) sendRecord.AffiliationDate = sendRecord['تاريخه'];
    if (!sendRecord.CommercialNo) sendRecord.CommercialNo = sendRecord['رقم الأسم التجاري'];
    if (!sendRecord.IDNo) sendRecord.IDNo = sendRecord['رقم اجازة التأسيس'];
  }

  const newId = `${x.file}_${x.table}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const recordWithMeta = {
    ...sendRecord,
    _adh_id: newId,
    _adh_file: x.file,
    _adh_table: x.table,
    _adh_created_at: nowIso,
  };

  mutations.adds.unshift(recordWithMeta);
  addedBatchCount++;

  ledger[x.uuid] = {
    adh_id: newId,
    table: x.table,
    name: sendRecord.ArabicName || sendRecord['اسم الشركة'] || 'بدون اسم',
    sent_at: nowIso,
  };
}

mutations.last_sync = new Date().toISOString();

// 6. رفع الحزمة كاملة دفعة واحدة في ثوانٍ معدودة
console.log(`🚀 جاري رفع ${addedBatchCount} قيد دفعة واحدة إلى Google Drive مباشرة...`);
const jsonPayload = JSON.stringify(mutations);
const sizeMb = (Buffer.byteLength(jsonPayload, 'utf-8') / (1024 * 1024)).toFixed(2);
console.log(`📦 حجم البيانات الإجمالي: ${sizeMb} ميغابايت`);

const uploadRes = await fetch(
  `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: jsonPayload,
  }
);

if (uploadRes.status !== 200) {
  const errText = await uploadRes.text();
  throw new Error(`فشل رفع البيانات السحابية: ${uploadRes.status} - ${errText}`);
}

// 7. حفظ السجل المحلي المحدث
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));

// تحديث ملف الطفرات المحلي في مجلد شييييير إذا كان متاحاً
const localMutationsPath = 'C:/Users/tohiba/Desktop/شييييير/web-dashboard/data/access-hub/mutations.json';
try {
  if (fs.existsSync(localMutationsPath)) {
    fs.writeFileSync(localMutationsPath, jsonPayload, 'utf-8');
  }
} catch {
  // تجاهل
}

console.log(`🎉 نجح الرفع الفائق بالكامل!`);
console.log(`📊 إجمالي السجلات المضافة في السحابة الآن: ${mutations.adds.length}`);
console.log(`✅ إجمالي الأسماء في السجل (Ledger): ${Object.keys(ledger).length}`);
