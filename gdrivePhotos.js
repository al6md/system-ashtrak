import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env.gdrive or .env if exists
let envClientId = process.env.GDRIVE_CLIENT_ID;
let envClientSecret = process.env.GDRIVE_CLIENT_SECRET;
let envRefreshToken = process.env.GDRIVE_REFRESH_TOKEN;
let envFolderId = process.env.GDRIVE_PHOTOS_FOLDER_ID;

const envFiles = [
  path.join(__dirname, '.env.gdrive'),
  path.join(__dirname, '.env'),
  'C:\\Users\\tohiba\\Desktop\\شييييير\\web-dashboard\\.env.local'
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
        if (key === 'GDRIVE_CLIENT_ID' && !envClientId) envClientId = val;
        if (key === 'GDRIVE_CLIENT_SECRET' && !envClientSecret) envClientSecret = val;
        if (key === 'GDRIVE_REFRESH_TOKEN' && !envRefreshToken) envRefreshToken = val;
        if (key === 'GDRIVE_PHOTOS_FOLDER_ID' && !envFolderId) envFolderId = val;
      }
    } catch (_) {}
  }
}

export const GDRIVE_CONFIG = {
  clientId: envClientId || process.env.GDRIVE_CLIENT_ID || '',
  clientSecret: envClientSecret || process.env.GDRIVE_CLIENT_SECRET || '',
  refreshToken: envRefreshToken || process.env.GDRIVE_REFRESH_TOKEN || '',
  folderId: envFolderId || process.env.GDRIVE_PHOTOS_FOLDER_ID || '1PLlY6X4r5nQbTqIZOjcST55G-up46HOo'
};

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get or refresh Google Drive OAuth2 Access Token
 */
export async function getAccessToken() {
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
 * Sanitize strings for safe filenames
 */
export function sanitizeFilename(str) {
  if (!str) return '';
  return String(str).replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format a human-readable, descriptive photo title
 * Pattern: "[تاجر] الاسم - هوية 1234 - الاسم التجاري.jpg"
 */
export function formatPhotoTitle(trader, originalExt = '.jpg') {
  const memberType = (trader.member_type || '').toLowerCase();
  const typeAr = memberType === 'broker' ? 'دلال' : (memberType === 'company' ? 'شركة' : 'تاجر');
  const safeName = sanitizeFilename(trader.name || trader.company_name || 'مشترك');
  const safeCard = sanitizeFilename(trader.card_no || trader.incorporation_certificate_no || '');
  const safeComm = sanitizeFilename(trader.commercial_name);

  const parts = [`[${typeAr}]`, safeName];
  if (safeCard) {
    parts.push(`- هوية ${safeCard}`);
  } else if (trader.id) {
    parts.push(`- رقم ${trader.id}`);
  }
  if (safeComm) {
    parts.push(`- ${safeComm}`);
  }

  let ext = originalExt;
  if (!ext.startsWith('.')) ext = '.' + ext;
  return parts.join(' ') + ext;
}

/**
 * Upload buffer or file to Google Drive folder
 */
export async function uploadBufferToDrive(buffer, filename, mimeType = 'image/jpeg') {
  const token = await getAccessToken();
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: filename,
    parents: [GDRIVE_CONFIG.folderId]
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

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
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
 * Upload trader photo asynchronously in background
 */
export async function syncTraderPhotoToDrive(trader, fileBufferOrPath, originalExt = '.jpg') {
  try {
    let buf;
    if (typeof fileBufferOrPath === 'string') {
      if (!fs.existsSync(fileBufferOrPath)) {
        console.warn(`[GDrive] Photo file not found at: ${fileBufferOrPath}`);
        return null;
      }
      buf = fs.readFileSync(fileBufferOrPath);
    } else if (Buffer.isBuffer(fileBufferOrPath)) {
      buf = fileBufferOrPath;
    } else {
      console.warn('[GDrive] Invalid photo buffer/path provided');
      return null;
    }

    const title = formatPhotoTitle(trader, originalExt);
    const mimeType = originalExt.toLowerCase().includes('png') ? 'image/png' : 'image/jpeg';
    
    console.log(`[GDrive] Uploading photo for "${trader.name}" as "${title}"...`);
    const result = await uploadBufferToDrive(buf, title, mimeType);
    console.log(`[GDrive] Successfully uploaded photo "${title}" (ID: ${result.id})`);
    return result;
  } catch (err) {
    console.error(`[GDrive] Failed to upload photo for "${trader?.name}":`, err.message);
    return null;
  }
}
