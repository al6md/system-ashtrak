import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import {
  GDRIVE_CONFIG,
  getAccessToken,
  formatPhotoTitle,
  uploadBufferToDrive
} from '../gdrivePhotos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(rootDir, 'data', 'photos_gdrive_ledger.json');
const UPLOADS_DIR = path.join(rootDir, 'public', 'uploads');

// Load or initialize ledger
let ledger = {};
if (fs.existsSync(LEDGER_PATH)) {
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
  } catch (_) {
    ledger = {};
  }
}

function saveLedger() {
  try {
    const tmpPath = LEDGER_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), 'utf-8');
    fs.renameSync(tmpPath, LEDGER_PATH);
  } catch (err) {
    console.error('Failed to save ledger:', err.message);
  }
}

async function uploadWithRetry(buffer, filename, mimeType, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await uploadBufferToDrive(buffer, filename, mimeType);
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      const waitTime = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`[Retry ${attempt}/${maxRetries}] for "${filename}" after ${Math.round(waitTime)}ms:`, err.message);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
}

async function runBulkUpload() {
  console.log('--- بدء فحص صور المشتركين للرفع إلى Google Drive ---');
  console.log('المجلد الهدف في Google Drive:', GDRIVE_CONFIG.folderId);
  
  // Verify token
  await getAccessToken();
  console.log('✓ تم التحقق من اتصال Google Drive بنجاح');

  const rows = await db.all("SELECT id, card_no, name, commercial_name, member_type, photo_path FROM traders WHERE photo_path IS NOT NULL AND photo_path != ''");
  console.log(`إجمالي السجلات التي تحتوي على صور في قاعدة البيانات: ${rows.length}`);

  // Pre-calculate unique titles
  const usedTitles = new Set();
  const queue = [];

  for (const r of rows) {
    const fn = path.basename(r.photo_path.trim());
    const localPath = path.join(UPLOADS_DIR, fn);
    if (!fs.existsSync(localPath)) {
      continue;
    }

    const ext = path.extname(fn) || '.jpg';
    let title = formatPhotoTitle(r, ext);
    if (usedTitles.has(title)) {
      const baseName = title.slice(0, title.length - ext.length);
      title = `${baseName} (${r.id})${ext}`;
    }
    usedTitles.add(title);

    // Check if already uploaded in ledger
    if (ledger[r.photo_path] && ledger[r.photo_path].drive_file_id) {
      continue;
    }

    queue.push({
      trader: r,
      localPath,
      title,
      ext
    });
  }

  const alreadyUploadedCount = rows.length - queue.length;
  console.log(`✓ الصور المرفوعة مسبقاً (سيتم تخطيها): ${alreadyUploadedCount}`);
  console.log(`الصور المتبقية للرفع: ${queue.length}`);

  if (queue.length === 0) {
    console.log('جميع الصور مرفوعة بالكامل! لا يوجد ملفات جديدة.');
    return;
  }

  const startTime = Date.now();
  let completed = 0;
  let errors = 0;
  const CONCURRENCY = 6;
  let saveCounter = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        const buffer = fs.readFileSync(item.localPath);
        const mimeType = item.ext.toLowerCase().includes('png') ? 'image/png' : 'image/jpeg';
        const res = await uploadWithRetry(buffer, item.title, mimeType);

        ledger[item.trader.photo_path] = {
          trader_id: item.trader.id,
          name: item.trader.name,
          title: item.title,
          drive_file_id: res.id,
          webViewLink: res.webViewLink,
          uploaded_at: new Date().toISOString()
        };

        completed++;
        saveCounter++;
        if (saveCounter >= 25) {
          saveLedger();
          saveCounter = 0;
        }

        if (completed % 50 === 0 || completed === 1) {
          const elapsedSec = (Date.now() - startTime) / 1000;
          const rate = completed / elapsedSec;
          const remaining = queue.length;
          const etaSec = remaining / (rate || 1);
          console.log(`[التقدم: ${completed}/${completed + remaining} (${((completed / (completed + remaining)) * 100).toFixed(1)}%)] السرعة: ${rate.toFixed(1)} صورة/ثانية | الوقت المتبقي التقريبي: ${Math.round(etaSec)} ثانية | آخر ملف: ${item.title}`);
        }
      } catch (err) {
        errors++;
        console.error(`خطأ في رفع: ${item.title}:`, err.message);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  saveLedger();
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`تم الانتهاء بنجاح!`);
  console.log(`عدد الصور المرفوعة الآن: ${completed}`);
  console.log(`الأخطاء: ${errors}`);
  console.log(`الوقت المستغرق: ${totalElapsed} ثانية`);
  console.log(`إجمالي المرفوع في السجل (Ledger): ${Object.keys(ledger).length}`);
  console.log(`========================================\n`);
}

runBulkUpload().catch(err => {
  console.error('Fatal upload error:', err);
  saveLedger();
  process.exit(1);
});
