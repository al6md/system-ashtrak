// إرسال وتزامن دفعات الأسماء من نظام الاشتراكات إلى نظام Share COC
// يدعم التجار، الدلالين، والشركات مع حفظ فوري في السجل لمنع التكرار
import fs from 'node:fs';

const DIR = 'c:/Users/tohiba/OneDrive/Desktop/نظام اشتراكات/access_backfill';
const URL_ = 'https://web-dashboard-pi-self.vercel.app/api/access-hub';
const GUID = 'SUBS-SYNC-64564f5f-9443-4446-ab98-45e728ff48f3';
const limit = Number(process.argv[2] || 5000);
const fromYear = String(process.argv[3] || '2024');

const items = JSON.parse(fs.readFileSync(`${DIR}/to_send.json`, 'utf-8'));
const ledgerPath = `${DIR}/ledger.json`;
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) : {};
const year = (x) => (x.record.AffiliationDate || x.record['تاريخه'] || '').slice(0, 4);

// تجهيز قائمة الانتظار المتبقية
const queue = items
  .filter((x) => year(x) >= fromYear && !ledger[x.uuid])
  .slice(0, limit);

console.log(`[Backfill] إجمالي المتبقي للإرسال من سنة ${fromYear}: ${queue.length} اسماً`);

let sentCount = 0;
let failCount = 0;

for (let i = 0; i < queue.length; i++) {
  const x = queue[i];
  
  // ضبط حقول السجل لضمان العرض المثالي لكافة الجداول
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

  const displayName = sendRecord.ArabicName || sendRecord['اسم الشركة'] || 'بدون اسم';

  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-machine-guid': GUID,
      },
      body: JSON.stringify({
        file: x.file,
        table: x.table,
        record: sendRecord,
        guid: GUID,
      }),
    });

    const j = await res.json().catch(() => ({}));

    if (!res.ok || !j.success) {
      console.error(`[Backfill] ❌ فشل [${i + 1}/${queue.length}]: ${res.status} - ${j.error || 'خطأ غير معروف'} (${displayName})`);
      failCount++;
      if (failCount >= 5) {
        console.error('[Backfill] توقف مؤقت لتكرار الأخطاء (5 مرات متتالية).');
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }

    failCount = 0;
    sentCount++;

    ledger[x.uuid] = {
      adh_id: j.record?._adh_id,
      table: x.table,
      name: displayName,
      sent_at: new Date().toISOString(),
    };

    // حفظ دوري للسجل
    if (sentCount % 5 === 0 || i === queue.length - 1) {
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    }

    console.log(`[Backfill] ✅ [${sentCount}/${queue.length}] تم: ${x.table} - ${displayName} -> ${j.record?._adh_id}`);

    // فاصل زمني لتجنب إجهاد Google Drive
    await new Promise((r) => setTimeout(r, 1800));
  } catch (err) {
    console.error(`[Backfill] ⚠️ خطأ شبكة [${i + 1}/${queue.length}]: ${err.message} (${displayName})`);
    failCount++;
    if (failCount >= 5) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// حفظ نهائي
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
console.log(`[Backfill] انتهت الدفعة: تم بنجاح ${sentCount} من أصل ${queue.length}`);
