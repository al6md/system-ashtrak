import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import {
  ensureIsolatedFolder,
  getAccessToken,
  uploadPhotoToIsolatedDrive
} from '../gdrivePhotos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(rootDir, 'public', 'uploads');
const LEDGER_PATH = path.join(rootDir, 'data', 'isolated_drive_photos_ledger.json');

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
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (_) {}
}

async function uploadWithRetry(buf, filename, mimeType, trader, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await uploadPhotoToIsolatedDrive(buf, filename, mimeType, db, trader);
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      const waitMs = Math.pow(2, attempt) * 800 + Math.random() * 400;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  console.log('=== بدء رفع جميع صور النظام إلى المجلد المعزول في Google Drive ===');
  const folderId = await ensureIsolatedFolder(db);
  await getAccessToken(db);
  console.log('✓ المجلد المعزول في Google Drive (خارج نظام الشير):', folderId);

  // Load existing mappings from Turso DB
  const existingDbRows = await db.all('SELECT filename, drive_file_id FROM uploaded_photos WHERE drive_file_id IS NOT NULL');
  const uploadedMap = new Map();
  for (const r of existingDbRows) {
    if (r.filename && r.drive_file_id) {
      uploadedMap.set(r.filename, r.drive_file_id);
    }
  }

  // Load trader metadata by filename
  const traders = await db.all("SELECT id, name, company_name, card_no, incorporation_certificate_no, commercial_name, member_type, photo_path FROM traders WHERE photo_path IS NOT NULL AND photo_path != ''");
  const traderByFile = new Map();
  for (const t of traders) {
    const fn = path.basename(t.photo_path.trim());
    traderByFile.set(fn, t);
  }

  const allFiles = fs.readdirSync(UPLOADS_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  console.log(`إجمالي الصور المحلية في public/uploads: ${allFiles.length}`);

  const queue = [];
  for (const filename of allFiles) {
    if (uploadedMap.has(filename)) continue;
    queue.push({
      filename,
      localPath: path.join(UPLOADS_DIR, filename),
      trader: traderByFile.get(filename) || null
    });
  }

  console.log(`✓ الصور المرفوعة مسبقاً: ${allFiles.length - queue.length}`);
  console.log(`🚀 الصور المتبقية للرفع الآن: ${queue.length}`);

  if (queue.length === 0) {
    console.log('جميع الصور مرفوعة بالكامل في المجلد المعزول على Google Drive!');
    return;
  }

  const totalToUpload = queue.length;
  const startTime = Date.now();
  let completed = 0;
  let errors = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const buf = fs.readFileSync(item.localPath);
        const mimeType = item.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const res = await uploadWithRetry(buf, item.filename, mimeType, item.trader);

        if (res && res.id) {
          const now = new Date().toISOString();
          await db.prepare(`
            INSERT OR REPLACE INTO uploaded_photos (filename, mime_type, data_base64, drive_file_id, created_at)
            VALUES (?, ?, NULL, ?, ?)
          `).run(item.filename, mimeType, res.id, now);

          ledger[item.filename] = {
            drive_file_id: res.id,
            name: res.name,
            uploaded_at: now
          };
        }

        completed++;
        if (completed % 25 === 0) saveLedger();
        if (completed % 50 === 0 || completed === 1 || completed === totalToUpload) {
          const elapsedSec = (Date.now() - startTime) / 1000;
          const rate = completed / (elapsedSec || 1);
          const remaining = queue.length;
          const etaSec = Math.round(remaining / (rate || 1));
          console.log(`[${completed}/${totalToUpload} (${((completed / totalToUpload) * 100).toFixed(1)}%)] السرعة: ${rate.toFixed(1)} صورة/ثانية | المتبقي: ~${etaSec} ثانية | آخر صورة: ${res?.name || item.filename}`);
        }
      } catch (err) {
        errors++;
        console.error(`✗ خطأ في رفع ${item.filename}:`, err.message);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  saveLedger();
  console.log(`\n========================================`);
  console.log(`✅ اكتمل رفع الصور إلى المجلد المعزول في Google Drive!`);
  console.log(`المرفوع بنجاح: ${completed} | الأخطاء: ${errors}`);
  console.log(`========================================\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  saveLedger();
  process.exit(1);
});
