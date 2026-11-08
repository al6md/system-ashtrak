// خزن واسترجاع صور المشتركين في مجلد معزول تماماً في Google Drive (خارج مجلد ShareExchange الخاص بنظام الشير)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as defaultDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// المجلد الخاص بنظام الشير (ShareExchange) - يُمنع الرفع داخله نهائياً لضمان العزل التام
const FORBIDDEN_SHARE_FOLDER_ID = '1BF6mDMuwuaS5c4Ekq9KPcEXaAOxGOmfB';
const ISOLATED_FOLDER_NAME = 'صور نظام الاشتراكات - الهويات (معزول)';
const DEFAULT_ISOLATED_FOLDER_ID = '19U0mx_HaUARrW-BWpVldnQ9BAjEDcaGt';

export const GDRIVE_CONFIG = {
  clientId: process.env.GDRIVE_CLIENT_ID || '',
  clientSecret: process.env.GDRIVE_CLIENT_SECRET || '',
  refreshToken: process.env.GDRIVE_REFRESH_TOKEN || '',
  isolatedFolderId: process.env.GDRIVE_ISOLATED_PHOTOS_FOLDER_ID || DEFAULT_ISOLATED_FOLDER_ID
};

let configLoaded = false;
let lastConfigCheck = 0;
let cachedToken = null;
let tokenExpiry = 0;

async function ensureConfigLoaded(db = defaultDb) {
  if (configLoaded && GDRIVE_CONFIG.clientId && GDRIVE_CONFIG.clientSecret && GDRIVE_CONFIG.refreshToken) {
    return;
  }
  const now = Date.now();
  if (now - lastConfigCheck < 300000 && lastConfigCheck > 0) {
    return;
  }
  lastConfigCheck = now;

  // 1. محاولة القراءة من قاعدة البيانات السحابية Turso (تعمل على Vercel ومحلياً)
  if (db) {
    try {
      const row = await db.prepare("SELECT value FROM settings WHERE key = 'gdrive_oauth_config'").get();
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        if (parsed.clientId && !GDRIVE_CONFIG.clientId) GDRIVE_CONFIG.clientId = parsed.clientId;
        if (parsed.clientSecret && !GDRIVE_CONFIG.clientSecret) GDRIVE_CONFIG.clientSecret = parsed.clientSecret;
        if (parsed.refreshToken && !GDRIVE_CONFIG.refreshToken) GDRIVE_CONFIG.refreshToken = parsed.refreshToken;
        if (parsed.isolatedFolderId && parsed.isolatedFolderId !== FORBIDDEN_SHARE_FOLDER_ID) {
          GDRIVE_CONFIG.isolatedFolderId = parsed.isolatedFolderId;
        }
        configLoaded = true;
      }
    } catch (_) {}
  }

  // 2. محاولة القراءة من ملفات .env المحلية كبديل احتياطي
  if (!GDRIVE_CONFIG.clientId || !GDRIVE_CONFIG.refreshToken) {
    const envFiles = [
      path.join(__dirname, '.env.gdrive'),
      path.join(__dirname, '.env')
    ];
    for (const envPath of envFiles) {
      if (fs.existsSync(envPath)) {
        try {
          const raw = fs.readFileSync(envPath, 'utf-8');
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key === 'GDRIVE_CLIENT_ID' && !GDRIVE_CONFIG.clientId) GDRIVE_CONFIG.clientId = val;
            if (key === 'GDRIVE_CLIENT_SECRET' && !GDRIVE_CONFIG.clientSecret) GDRIVE_CONFIG.clientSecret = val;
            if (key === 'GDRIVE_REFRESH_TOKEN' && !GDRIVE_CONFIG.refreshToken) GDRIVE_CONFIG.refreshToken = val;
          }
        } catch (_) {}
      }
    }
  }
}

/**
 * الحصول على رمز الوصول (Access Token) من Google OAuth2
 */
export async function getAccessToken(db = defaultDb) {
  await ensureConfigLoaded(db);
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 60000) {
    return cachedToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GDRIVE_CONFIG.clientId,
      client_secret: GDRIVE_CONFIG.clientSecret,
      refresh_token: GDRIVE_CONFIG.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google Drive Token Error: ' + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) * 1000);
  return cachedToken;
}

/**
 * ضمان وجود مجلد معزول في الجذر الرئيسي لـ Google Drive ('root') خارج مجلد نظام الشير تماماً
 */
export async function ensureIsolatedFolder(db = defaultDb) {
  await ensureConfigLoaded(db);
  if (GDRIVE_CONFIG.isolatedFolderId && GDRIVE_CONFIG.isolatedFolderId !== FORBIDDEN_SHARE_FOLDER_ID) {
    return GDRIVE_CONFIG.isolatedFolderId;
  }

  const token = await getAccessToken(db);

  // البحث في الجذر الرئيسي (root) فقط عن المجلد المعزول
  const q = `'root' in parents and name = '${ISOLATED_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();

  if (searchData.files && searchData.files.length > 0) {
    const folderId = searchData.files[0].id;
    GDRIVE_CONFIG.isolatedFolderId = folderId;
    return folderId;
  }

  // إنشاء مجلد جديد في الجذر الرئيسي لـ Google Drive (خارج مجلد الشير ShareExchange)
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,parents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: ISOLATED_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root']
    })
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.id) {
    throw new Error('Failed to create isolated Google Drive folder: ' + JSON.stringify(created));
  }

  GDRIVE_CONFIG.isolatedFolderId = created.id;
  return created.id;
}

export function sanitizeFilename(str) {
  if (!str) return '';
  return String(str).replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatPhotoTitle(trader, systemFilename = '') {
  const ext = path.extname(systemFilename || '') || '.jpg';
  if (!trader) return systemFilename || `photo_${Date.now()}${ext}`;
  const memberType = (trader.member_type || '').toLowerCase();
  const typeAr = memberType === 'broker' ? 'دلال' : (memberType === 'company' ? 'شركة' : 'تاجر');
  const safeName = sanitizeFilename(trader.name || trader.company_name || 'مشترك');
  const safeCard = sanitizeFilename(trader.card_no || trader.incorporation_certificate_no || '');
  const parts = [`[${typeAr}]`, safeName];
  if (safeCard) parts.push(`- هوية ${safeCard}`);
  if (systemFilename) parts.push(`- ${systemFilename}`);
  else parts.push(ext);
  return parts.join(' ');
}

/**
 * رفع صورة إلى المجلد المعزول في Google Drive
 */
export async function uploadPhotoToIsolatedDrive(buffer, filename, mimeType = 'image/jpeg', db = defaultDb, trader = null) {
  const token = await getAccessToken(db);
  const folderId = await ensureIsolatedFolder(db);

  if (folderId === FORBIDDEN_SHARE_FOLDER_ID) {
    throw new Error('Refusing to upload photo into ShareExchange folder');
  }

  const driveTitle = trader ? formatPhotoTitle(trader, filename) : filename;
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: driveTitle,
    parents: [folderId],
    appProperties: {
      systemFilename: filename,
      isolatedFromShare: 'true'
    }
  };

  const multipartRequestBody = Buffer.concat([
    Buffer.from(
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      `Content-Type: ${mimeType}\r\n\r\n`
    ),
    buffer,
    Buffer.from(closeDelimiter)
  ]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': multipartRequestBody.length.toString()
    },
    body: multipartRequestBody
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google Drive Upload Error: ' + JSON.stringify(data));
  }

  return data;
}

/**
 * تحميل صورة من Google Drive بواسطة معرّف الملف (fileId) أو اسم الملف (filename)
 */
export async function downloadPhotoFromIsolatedDrive(driveFileId, filename = null, db = defaultDb) {
  const token = await getAccessToken(db);
  let targetId = driveFileId;

  if (!targetId && filename) {
    const folderId = await ensureIsolatedFolder(db);
    const q = `'${folderId}' in parents and trashed = false and name contains '${filename.replace(/'/g, "\\'")}'`;
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      targetId = searchData.files[0].id;
    }
  }

  if (!targetId) return null;

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${targetId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 50 ? { buffer: buf, driveFileId: targetId } : null;
}
