import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import multer from 'multer';
import { notifyAdded as accessSyncAdd, notifySaved as accessSyncNotify, notifyDeleted as accessSyncDelete } from './accessHubSync.js';
import { uploadPhotoToIsolatedDrive, downloadPhotoFromIsolatedDrive } from './gdrivePhotos.js';

const gzipAsync = promisify(zlib.gzip);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Setup View Engine + Enable Template Compilation Cache (prevents OneDrive disk reads on every click)
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', true);

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Safe CORS Policy (blocks unauthorized cross-site mutations from external websites while allowing same-host & LAN)
const allowedOriginsEnv = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOriginsEnv.includes(origin)) return callback(null, true);
      try {
        const u = new URL(origin);
        if (
          u.hostname === 'localhost' ||
          u.hostname === '127.0.0.1' ||
          u.hostname.endsWith('.vercel.app') ||
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(u.hostname)
        ) {
          return callback(null, true);
        }
      } catch (_) {}
      return callback(null, false);
    },
  })
);

// Fast Built-in Gzip Compression for HTML & JSON responses (>= 1KB)
app.use((req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('gzip')) return next();

  const origSend = res.send.bind(res);
  res.send = function (body) {
    if (res.headersSent || res.getHeader('Content-Encoding')) {
      return origSend(body);
    }
    const contentType = String(res.getHeader('Content-Type') || '');
    const isCompressible =
      contentType.startsWith('text/') ||
      contentType.includes('application/json') ||
      contentType.includes('application/javascript') ||
      contentType.includes('image/svg+xml') ||
      typeof body === 'string';

    if (!isCompressible) return origSend(body);

    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8');
    if (buf.byteLength < 1024) return origSend(body);

    if (!contentType && typeof body === 'string') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }

    gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED })
      .then((compressed) => {
        if (res.headersSent) return;
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', compressed.byteLength);
        origSend(compressed);
      })
      .catch(() => origSend(body));

    return res;
  };
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static files with aggressive browser caching
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('/public/build/assets/') || normalized.includes('/public/uploads/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (
        normalized.includes('/public/templates/') ||
        normalized.includes('/public/images/') ||
        normalized.includes('/public/js/') ||
        normalized.includes('/public/css/') ||
        /\.(woff2?|png|jpe?g|webp|ico)$/i.test(normalized)
      ) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  })
);

// Uploads Directory (supports Vercel serverless /tmp and local)
const uploadDir = isServerless ? path.join(os.tmpdir(), 'uploads') : path.join(__dirname, 'public', 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (_) {}

// ==========================================
// In-Memory Smart Cache (Instant Invalidation on Writes)
// ==========================================
const LIST_TTL_MS = 20_000;      // 20s for paginated feeds (instant invalidation on local writes)
const COUNT_TTL_MS = 60_000;     // 60s for total counts
const DASH_TTL_MS = 60_000;      // 60s for dashboard stats
const SETTINGS_TTL_MS = 300_000; // 5m for global card typography settings

let dashboardCache = null; // { data, expiresAt }
const listCache = new Map();
const countCache = new Map();
const settingsCache = new Map();
const qrCache = new Map();
const missingPhotoCache = new Map(); // filename -> timestamp

function setBoundedMap(map, key, val, maxEntries = 250) {
  if (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, val);
}

function invalidateTradersCache() {
  dashboardCache = null;
  listCache.clear();
  countCache.clear();
}

function invalidateSettingsCache(key = null) {
  if (key) settingsCache.delete(key);
  else settingsCache.clear();
}

// ==========================================
// Security & SQL Helpers
// ==========================================
function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isUuidLike(val) {
  return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(val.trim());
}

async function findTraderByIdentifier(idOrUuid, allowCardNoFallback = false) {
  const raw = String(idOrUuid || '').trim();
  if (!raw) return null;

  if (isUuidLike(raw) || raw.includes('-')) {
    return await db.prepare('SELECT * FROM traders WHERE uuid = ?').get(raw);
  }
  if (/^\d+$/.test(raw)) {
    const byId = await db.prepare('SELECT * FROM traders WHERE id = ?').get(Number(raw));
    if (byId || !allowCardNoFallback) return byId;
    return await db.prepare('SELECT * FROM traders WHERE card_no = ? ORDER BY id DESC LIMIT 1').get(raw);
  }
  const byUuid = await db.prepare('SELECT * FROM traders WHERE uuid = ?').get(raw);
  if (byUuid || !allowCardNoFallback) return byUuid;
  return await db.prepare('SELECT * FROM traders WHERE card_no = ? ORDER BY id DESC LIMIT 1').get(raw);
}

function buildKeyWhereClause(idOrUuid) {
  const raw = String(idOrUuid || '').trim();
  if (isUuidLike(raw) || raw.includes('-')) {
    return { clause: 'uuid = ?', param: raw };
  }
  if (/^\d+$/.test(raw)) {
    return { clause: 'id = ?', param: Number(raw) };
  }
  return { clause: 'uuid = ?', param: raw };
}

async function fileExistsFast(p) {
  try {
    await fsp.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Helper: Upload photo exclusively to isolated Google Drive folder (outside ShareExchange) and save Drive File ID
async function saveUploadedPhotoToCloud(file, traderInfo = null) {
  if (!file || !file.path) return;
  try {
    const buf = await fsp.readFile(file.path);
    const mimeType = file.mimetype || (file.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
    const now = new Date().toISOString();

    const driveRes = await uploadPhotoToIsolatedDrive(buf, file.filename, mimeType, db, traderInfo);
    const driveFileId = driveRes?.id || null;
    console.log(`[GDrive-Isolated] Uploaded "${file.filename}" -> Drive ID: ${driveFileId}`);

    if (driveFileId) {
      await db.prepare(`
        INSERT OR REPLACE INTO uploaded_photos (filename, mime_type, data_base64, drive_file_id, created_at)
        VALUES (?, ?, NULL, ?, ?)
      `).run(file.filename, mimeType, driveFileId, now);
    }
  } catch (err) {
    console.warn('[GDrive-Isolated] Failed to upload photo to Google Drive:', err.message);
  }
}

// Automatic on-demand photo fetch from isolated Google Drive folder for /uploads/:filename
app.get('/uploads/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const primaryPath = path.join(uploadDir, filename);
    const fallbackPath = path.join(__dirname, 'public', 'uploads', filename);

    if (await fileExistsFast(primaryPath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(primaryPath);
    }
    if (primaryPath !== fallbackPath && (await fileExistsFast(fallbackPath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(fallbackPath);
    }

    const negCachedAt = missingPhotoCache.get(filename);
    if (negCachedAt && Date.now() - negCachedAt < 300_000) {
      return res.redirect('/templates/avatar_placeholder.png');
    }

    // Fetch photo from isolated Google Drive folder (via mapped drive_file_id or filename search)
    try {
      const photoRow = await db.prepare('SELECT mime_type, drive_file_id FROM uploaded_photos WHERE filename = ?').get(filename);
      const dRes = await downloadPhotoFromIsolatedDrive(photoRow?.drive_file_id || null, filename, db);
      if (dRes && dRes.buffer && dRes.buffer.length > 50) {
        const ext = path.extname(filename).toLowerCase();
        const mimeType = photoRow?.mime_type || (ext === '.png' ? 'image/png' : 'image/jpeg');
        if (!photoRow?.drive_file_id && dRes.driveFileId) {
          db.prepare(`
            INSERT OR REPLACE INTO uploaded_photos (filename, mime_type, data_base64, drive_file_id, created_at)
            VALUES (?, ?, NULL, ?, ?)
          `).run(filename, mimeType, dRes.driveFileId, new Date().toISOString()).catch(() => {});
        }
        fsp.mkdir(uploadDir, { recursive: true })
          .then(() => fsp.writeFile(primaryPath, dRes.buffer))
          .catch(() => {});
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(dRes.buffer);
      }
    } catch (_) {}

    setBoundedMap(missingPhotoCache, filename, Date.now(), 500);
    return res.redirect('/templates/avatar_placeholder.png');
  } catch (err) {
    return res.redirect('/templates/avatar_placeholder.png');
  }
});

// Method override middleware for Laravel _method compatibility
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && '_method' in req.body) {
    req.method = String(req.body._method).toUpperCase();
  }
  next();
});

// Hardened File uploads configuration for person_pic (max 5MB, raster images only)
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
    } catch (_) {}
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_IMAGE_EXTS.has(rawExt) ? rawExt : '.jpg';
    cb(null, 'trader_' + uniqueSuffix + safeExt);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype) && (!ext || ALLOWED_IMAGE_EXTS.has(ext))) {
      return cb(null, true);
    }
    return cb(new Error('يُسمح برفع الصور فقط بصيغة JPG أو PNG أو WEBP وبحجم أقصى 5 ميجابايت'));
  },
});

// Helper: Format class name
function formatClassName(cardClass, lang = 'ar') {
  const c = String(cardClass || '').trim();
  if (lang === 'ar') {
    if (c === '1' || c === 'الأولى' || c === 'الاولى' || c === 'الاول') return 'الأول';
    if (c === '2' || c === 'الثانية') return 'الثاني';
    if (c === '3' || c === 'الثالثة') return 'الثالث';
    if (c === '4' || c === 'الرابعة') return 'الرابع';
    if (c.toLowerCase().includes('ممتاز') || c === '0') return 'الممتاز';
    return c;
  } else {
    if (c === '1' || c === 'الأولى' || c === 'الاولى' || c === 'الأول' || c === 'الاول') return 'First';
    if (c === '2' || c === 'الثانية' || c === 'الثاني') return 'Second';
    if (c === '3' || c === 'الثالثة' || c === 'الثالث') return 'Third';
    if (c === '4' || c === 'الرابعة' || c === 'الرابع') return 'Fourth';
    if (c.toLowerCase().includes('ممتاز') || c === '0') return 'Excellent';
    return c;
  }
}

function normalizeGender(val) {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'أنثى' || v === 'انثى' || v === 'female' || v === 'f') return 'أنثى';
  return 'ذكر';
}

function appendGenderFilter(where, params, gender) {
  const g = String(gender || '').trim();
  if (!g) return;
  if (g === 'أنثى' || g === 'انثى' || g.toLowerCase() === 'female') {
    where.push("(gender IN ('أنثى', 'انثى', 'female', 'Female'))");
  } else if (g === 'ذكر' || g.toLowerCase() === 'male') {
    where.push("(gender = 'ذكر' OR gender IS NULL OR gender = '')");
  } else {
    where.push('gender = ?');
    params.push(g);
  }
}

// ==========================================
// Shared Filter Builders & Paginated Query Runner
// ==========================================
const LIST_SELECT_COLS = `
  id, uuid, name, commercial_name, company_name, ceo_name,
  activity, card_no, created_by, created_at, member_type
`;

async function runCachedPaginatedQuery(selectCols, whereSql, params, limit, offset) {
  const now = Date.now();
  const whereKey = `${whereSql}::${JSON.stringify(params)}`;
  const pageKey = `${whereKey}::${limit}::${offset}`;

  const cachedPage = listCache.get(pageKey);
  if (cachedPage && cachedPage.expiresAt > now) {
    return cachedPage.data;
  }

  const cachedCount = countCache.get(whereKey);
  let totalCount;
  let rows;

  if (cachedCount && cachedCount.expiresAt > now) {
    totalCount = cachedCount.count;
    rows = await db
      .prepare(`SELECT ${selectCols} FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
  } else {
    const [countRes, rowsRes] = await db.batch(
      [
        { sql: `SELECT COUNT(*) as count FROM traders WHERE ${whereSql}`, args: params },
        {
          sql: `SELECT ${selectCols} FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          args: [...params, limit, offset],
        },
      ],
      'read'
    );
    totalCount = countRes.first?.count || 0;
    rows = rowsRes.rows;
    setBoundedMap(countCache, whereKey, { count: totalCount, expiresAt: now + COUNT_TTL_MS });
  }

  const data = { totalCount, rows };
  setBoundedMap(listCache, pageKey, { data, expiresAt: now + LIST_TTL_MS });
  return data;
}

function buildTradersFilter(q) {
  const {
    search, name, english_name, commercial_name, activity,
    card_no, renewal_no, commercial_name_no, speciality,
    card_class, gender, affiliation_date_from, affiliation_date_to,
    expire_date_from, expire_date_to, status
  } = q;

  const isAdvancedSearch = Boolean(
    name || english_name || commercial_name || activity ||
    card_no || renewal_no || commercial_name_no || speciality ||
    card_class || (gender && gender.trim() !== '') ||
    affiliation_date_from || affiliation_date_to ||
    expire_date_from || expire_date_to || (status && status !== 'active')
  );

  const where = ["member_type = 'trader'"];
  const params = [];

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where.push('(name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ?)');
    params.push(term, term, term, term);
  }
  if (name && name.trim()) { where.push('name LIKE ?'); params.push(`%${name.trim()}%`); }
  if (english_name && english_name.trim()) { where.push('english_name LIKE ?'); params.push(`%${english_name.trim()}%`); }
  if (commercial_name && commercial_name.trim()) { where.push('commercial_name LIKE ?'); params.push(`%${commercial_name.trim()}%`); }
  if (activity && activity.trim()) { where.push('activity LIKE ?'); params.push(`%${activity.trim()}%`); }
  if (card_no && card_no.trim()) { where.push('card_no = ?'); params.push(card_no.trim()); }
  if (renewal_no && renewal_no.trim()) { where.push('renewal_no = ?'); params.push(renewal_no.trim()); }
  if (commercial_name_no && commercial_name_no.trim()) { where.push('commercial_name_no = ?'); params.push(commercial_name_no.trim()); }
  if (speciality && speciality.trim()) { where.push('speciality LIKE ?'); params.push(`%${speciality.trim()}%`); }
  if (card_class && card_class !== '') { where.push('card_class = ?'); params.push(card_class); }
  appendGenderFilter(where, params, gender);
  if (affiliation_date_from) { where.push('affiliation_date >= ?'); params.push(affiliation_date_from); }
  if (affiliation_date_to) { where.push('affiliation_date <= ?'); params.push(affiliation_date_to); }
  if (expire_date_from) { where.push('expire_date >= ?'); params.push(expire_date_from); }
  if (expire_date_to) { where.push('expire_date <= ?'); params.push(expire_date_to); }

  if (status === 'deleted') {
    where.push("deleted_at IS NOT NULL AND deleted_at != ''");
  } else if (status !== 'all') {
    where.push("(deleted_at IS NULL OR deleted_at = '')");
  }

  return { whereSql: where.join(' AND '), params, isAdvancedSearch };
}

function buildBrokersFilter(q) {
  const {
    search, name, english_name, commercial_name, card_no,
    stamp_no, renewal_no, activity, phone_number,
    card_class, gender, affiliation_date_from, affiliation_date_to, status
  } = q;

  const isAdvancedSearch = Boolean(
    (name && name.trim()) || (english_name && english_name.trim()) ||
    (commercial_name && commercial_name.trim()) || (card_no && card_no.trim()) ||
    (stamp_no && stamp_no.trim()) || (renewal_no && renewal_no.trim()) ||
    (activity && activity.trim()) || (phone_number && phone_number.trim()) ||
    (card_class && card_class !== '') || (gender && gender.trim() !== '') ||
    affiliation_date_from || affiliation_date_to || (status && status !== 'active')
  );

  const where = ["member_type = 'broker'"];
  const params = [];

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where.push('(name LIKE ? OR english_name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR stamp_no LIKE ? OR phone_number LIKE ?)');
    params.push(term, term, term, term, term, term, term);
  }
  if (name && name.trim()) { where.push('name LIKE ?'); params.push(`%${name.trim()}%`); }
  if (english_name && english_name.trim()) { where.push('english_name LIKE ?'); params.push(`%${english_name.trim()}%`); }
  if (commercial_name && commercial_name.trim()) { where.push('commercial_name LIKE ?'); params.push(`%${commercial_name.trim()}%`); }
  if (card_no && card_no.trim()) { where.push('card_no = ?'); params.push(card_no.trim()); }
  if (stamp_no && stamp_no.trim()) { where.push('stamp_no = ?'); params.push(stamp_no.trim()); }
  if (renewal_no && renewal_no.trim()) { where.push('renewal_no = ?'); params.push(renewal_no.trim()); }
  if (activity && activity.trim()) { where.push('activity LIKE ?'); params.push(`%${activity.trim()}%`); }
  if (phone_number && phone_number.trim()) { where.push('phone_number LIKE ?'); params.push(`%${phone_number.trim()}%`); }
  if (card_class && card_class !== '') { where.push('card_class = ?'); params.push(card_class); }
  appendGenderFilter(where, params, gender);
  if (affiliation_date_from) { where.push('affiliation_date >= ?'); params.push(affiliation_date_from); }
  if (affiliation_date_to) { where.push('affiliation_date <= ?'); params.push(affiliation_date_to); }

  if (status === 'deleted') {
    where.push("deleted_at IS NOT NULL AND deleted_at != ''");
  } else if (status !== 'all') {
    where.push("(deleted_at IS NULL OR deleted_at = '')");
  }

  return { whereSql: where.join(' AND '), params, isAdvancedSearch };
}

function buildCompaniesFilter(q) {
  const {
    search, name, company_name, english_name, english_company_name,
    commercial_name, ceo_name, activity, card_no, renewal_no,
    commercial_name_no, incorporation_certificate_no, card_class, gender,
    affiliation_date_from, affiliation_date_to,
    expire_date_from, expire_date_to, status
  } = q;

  const isAdvancedSearch = Boolean(
    (company_name && company_name.trim()) || (english_company_name && english_company_name.trim()) ||
    (name && name.trim()) || (english_name && english_name.trim()) ||
    (commercial_name && commercial_name.trim()) || (ceo_name && ceo_name.trim()) ||
    (activity && activity.trim()) || (card_no && card_no.trim()) ||
    (renewal_no && renewal_no.trim()) || (commercial_name_no && commercial_name_no.trim()) ||
    (incorporation_certificate_no && incorporation_certificate_no.trim()) ||
    (card_class && card_class !== '') || (gender && gender.trim() !== '') ||
    affiliation_date_from || affiliation_date_to || expire_date_from || expire_date_to ||
    (status && status !== 'active')
  );

  const where = ["member_type = 'company'"];
  const params = [];

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where.push('(company_name LIKE ? OR english_company_name LIKE ? OR ceo_name LIKE ? OR name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR incorporation_certificate_no LIKE ? OR phone_number LIKE ?)');
    params.push(term, term, term, term, term, term, term, term, term);
  }

  const cName = company_name || name;
  if (cName && cName.trim()) {
    where.push('(company_name LIKE ? OR commercial_name LIKE ? OR name LIKE ?)');
    params.push(`%${cName.trim()}%`, `%${cName.trim()}%`, `%${cName.trim()}%`);
  }

  const cEnName = english_company_name || english_name;
  if (cEnName && cEnName.trim()) {
    where.push('(english_company_name LIKE ? OR english_name LIKE ?)');
    params.push(`%${cEnName.trim()}%`, `%${cEnName.trim()}%`);
  }

  if (commercial_name && commercial_name.trim()) { where.push('commercial_name LIKE ?'); params.push(`%${commercial_name.trim()}%`); }
  if (ceo_name && ceo_name.trim()) {
    where.push('(ceo_name LIKE ? OR name LIKE ?)');
    params.push(`%${ceo_name.trim()}%`, `%${ceo_name.trim()}%`);
  }
  if (activity && activity.trim()) { where.push('activity LIKE ?'); params.push(`%${activity.trim()}%`); }
  if (card_no && card_no.trim()) { where.push('card_no = ?'); params.push(card_no.trim()); }
  if (renewal_no && renewal_no.trim()) { where.push('renewal_no = ?'); params.push(renewal_no.trim()); }
  if (commercial_name_no && commercial_name_no.trim()) { where.push('commercial_name_no = ?'); params.push(commercial_name_no.trim()); }
  if (incorporation_certificate_no && incorporation_certificate_no.trim()) {
    where.push('incorporation_certificate_no LIKE ?');
    params.push(`%${incorporation_certificate_no.trim()}%`);
  }
  if (card_class && card_class !== '') { where.push('card_class = ?'); params.push(card_class); }
  appendGenderFilter(where, params, gender);
  if (affiliation_date_from) { where.push('affiliation_date >= ?'); params.push(affiliation_date_from); }
  if (affiliation_date_to) { where.push('affiliation_date <= ?'); params.push(affiliation_date_to); }
  if (expire_date_from) { where.push('expire_date >= ?'); params.push(expire_date_from); }
  if (expire_date_to) { where.push('expire_date <= ?'); params.push(expire_date_to); }

  if (status === 'deleted') {
    where.push("deleted_at IS NOT NULL AND deleted_at != ''");
  } else if (status !== 'all') {
    where.push("(deleted_at IS NULL OR deleted_at = '')");
  }

  return { whereSql: where.join(' AND '), params, isAdvancedSearch };
}

// ==========================================
// Cardval Original Web Routes
// ==========================================

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/traders');
});

// Dashboard (Single SQL Covering Query + In-Memory Cache, properly excluding deleted rows)
app.get('/dashboard', async (req, res) => {
  try {
    const now = Date.now();
    let stats;
    if (dashboardCache && dashboardCache.expiresAt > now) {
      stats = dashboardCache.data;
    } else {
      const today = new Date().toISOString().split('T')[0];
      const row = await db.prepare(`
        SELECT
          SUM(CASE WHEN member_type = 'trader' THEN 1 ELSE 0 END) AS totalTraders,
          SUM(CASE WHEN member_type = 'broker' THEN 1 ELSE 0 END) AS totalBrokers,
          SUM(CASE WHEN member_type = 'company' THEN 1 ELSE 0 END) AS totalCompanies,
          SUM(CASE WHEN expire_date >= ? THEN 1 ELSE 0 END) AS activeMembers,
          SUM(CASE WHEN photo_path IS NOT NULL AND photo_path != '' THEN 1 ELSE 0 END) AS withPhotos
        FROM traders
        WHERE deleted_at IS NULL OR deleted_at = ''
      `).get(today);

      stats = {
        totalTraders: row?.totalTraders || 0,
        totalBrokers: row?.totalBrokers || 0,
        totalCompanies: row?.totalCompanies || 0,
        activeMembers: row?.activeMembers || 0,
        withPhotos: row?.withPhotos || 0,
      };
      dashboardCache = { data: stats, expiresAt: now + DASH_TTL_MS };
    }

    res.render('dashboard', {
      currentPath: '/dashboard',
      stats,
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + escapeHtml(err.message));
  }
});

// Traders Feed List (Exact original layout, indexed + batched + cached)
app.get('/traders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const { whereSql, params, isAdvancedSearch } = buildTradersFilter(req.query);
    const { totalCount, rows: traders } = await runCachedPaginatedQuery(LIST_SELECT_COLS, whereSql, params, limit, offset);
    const totalPages = Math.ceil(totalCount / limit);

    const queryCopy = { ...req.query };
    delete queryCopy.page;
    const qs = Object.keys(queryCopy).length ? '&' + new URLSearchParams(queryCopy).toString() : '';

    res.render('traders/index', {
      currentPath: '/traders',
      traders,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      isAdvancedSearch,
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + escapeHtml(err.message));
  }
});

// Create Trader / Broker Page
app.get('/traders/create', (req, res) => {
  const memberType = req.query.type || 'trader';
  const currentPath = memberType === 'broker' ? '/brokers' : (memberType === 'company' ? '/companies' : '/traders');
  res.render('traders/create', { currentPath, member_type: memberType });
});

// Store New Trader / Broker / Company
app.post('/traders', upload.single('person_pic'), async (req, res) => {
  try {
    const {
      name, english_name, commercial_name, activity, english_activity,
      card_no, stamp_no, renewal_no, card_class, gender, commercial_name_no, speciality,
      phone_number, address, affiliation_date, expire_date, member_type,
      company_name, english_company_name, ceo_name, english_ceo_name,
      incorporation_certificate_no, incorporation_certificate_symbol
    } = req.body;

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const photoPath = req.file ? '/uploads/' + req.file.filename : null;
    const resolvedType = member_type === 'broker' ? 'broker' : (member_type === 'company' ? 'company' : 'trader');
    const resolvedGender = normalizeGender(gender);

    if (req.file) {
      const photoMeta = { name: name || company_name, card_no, commercial_name, member_type: resolvedType };
      if (isServerless) {
        await saveUploadedPhotoToCloud(req.file, photoMeta);
      } else {
        setImmediate(() => {
          saveUploadedPhotoToCloud(req.file, photoMeta).catch(() => {});
        });
      }
    }

    const effectiveName = name || ceo_name || company_name || '';

    await db.prepare(`
      INSERT INTO traders (
        uuid, name, english_name, commercial_name, activity, english_activity,
        card_no, stamp_no, renewal_no, card_class, gender, commercial_name_no, speciality,
        phone_number, address, affiliation_date, expire_date, photo_path,
        company_name, english_company_name, ceo_name, english_ceo_name,
        incorporation_certificate_no, incorporation_certificate_symbol,
        member_type, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Site Admin', ?, ?)
    `).run(
      uuid, effectiveName, english_name || '', commercial_name || '', activity || '', english_activity || '',
      card_no || '', stamp_no || '', renewal_no || '', card_class || '4', resolvedGender, commercial_name_no || '', speciality || '',
      phone_number || '', address || '', affiliation_date || '', expire_date || '', photoPath,
      company_name || '', english_company_name || '', ceo_name || '', english_ceo_name || '',
      incorporation_certificate_no || '', incorporation_certificate_symbol || '',
      resolvedType, now, now
    );

    invalidateTradersCache();

    const createdRow = {
      uuid,
      name: effectiveName,
      english_name: english_name || '',
      commercial_name: commercial_name || '',
      activity: activity || '',
      english_activity: english_activity || '',
      card_no: card_no || '',
      stamp_no: stamp_no || '',
      renewal_no: renewal_no || '',
      card_class: card_class || '4',
      gender: resolvedGender,
      commercial_name_no: commercial_name_no || '',
      speciality: speciality || '',
      phone_number: phone_number || '',
      address: address || '',
      affiliation_date: affiliation_date || '',
      expire_date: expire_date || '',
      company_name: company_name || '',
      english_company_name: english_company_name || '',
      ceo_name: ceo_name || '',
      english_ceo_name: english_ceo_name || '',
      incorporation_certificate_no: incorporation_certificate_no || '',
      incorporation_certificate_symbol: incorporation_certificate_symbol || '',
      member_type: resolvedType,
    };

    await accessSyncAdd(db, uuid, createdRow);

    const redirectPath = resolvedType === 'broker' ? '/brokers' : (resolvedType === 'company' ? '/companies' : '/traders');
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Error saving trader: ' + escapeHtml(err.message));
  }
});

// Edit Trader / Broker / Company Page
app.get('/traders/:uuid/edit', async (req, res) => {
  try {
    const trader = await findTraderByIdentifier(req.params.uuid, false);
    if (!trader) {
      return res.status(404).send('Trader not found');
    }
    const currentPath = trader.member_type === 'broker' ? '/brokers' : (trader.member_type === 'company' ? '/companies' : '/traders');
    res.render('traders/edit', { currentPath, trader });
  } catch (err) {
    res.status(500).send('Error loading edit page: ' + escapeHtml(err.message));
  }
});

// Shared Delete Execution (Fast DB soft-delete + Instant Cache Invalidation + Background Share Sync + AJAX support)
async function executeSoftDelete(req, res) {
  const trader = await findTraderByIdentifier(req.params.uuid, false);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const { clause, param } = buildKeyWhereClause(trader?.uuid || req.params.uuid);

  await db.prepare(`UPDATE traders SET deleted_at = ? WHERE ${clause}`).run(now, param);
  invalidateTradersCache();

  await accessSyncDelete(db, trader?.uuid || req.params.uuid, trader);

  const wantsJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.headers['x-requested-with'] === 'fetch';

  if (wantsJson) {
    return res.json({
      success: true,
      uuid: trader?.uuid || req.params.uuid,
      member_type: trader?.member_type || 'trader',
    });
  }

  const redirectPath = trader?.member_type === 'broker' ? '/brokers' : (trader?.member_type === 'company' ? '/companies' : '/traders');
  return res.redirect(redirectPath);
}

// Update or Delete Trader / Broker (supports POST with multipart _method=patch/delete as well as PATCH/PUT)
async function handleUpdateOrDeleteTrader(req, res) {
  try {
    if (req.body && String(req.body._method || '').toUpperCase() === 'DELETE') {
      return await executeSoftDelete(req, res);
    }

    const traderBefore = await findTraderByIdentifier(req.params.uuid, false);
    if (!traderBefore) {
      return res.status(404).send('Record not found');
    }

    const {
      name, english_name, commercial_name, activity, english_activity,
      card_no, stamp_no, renewal_no, card_class, gender, commercial_name_no, speciality,
      phone_number, address, affiliation_date, expire_date
    } = req.body;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const resolvedGender = normalizeGender(gender !== undefined ? gender : traderBefore.gender);
    let photoPath = traderBefore.photo_path;

    if (req.file) {
      photoPath = '/uploads/' + req.file.filename;
      const photoMeta = {
        name: name || traderBefore.name,
        card_no: card_no || traderBefore.card_no,
        commercial_name: commercial_name || traderBefore.commercial_name,
        member_type: traderBefore.member_type || 'trader',
      };
      if (isServerless) {
        await saveUploadedPhotoToCloud(req.file, photoMeta);
      } else {
        setImmediate(() => {
          saveUploadedPhotoToCloud(req.file, photoMeta).catch(() => {});
        });
      }
    }

    await db.prepare(`
      UPDATE traders SET
        name = ?, english_name = ?, commercial_name = ?, activity = ?, english_activity = ?,
        card_no = ?, stamp_no = ?, renewal_no = ?, card_class = ?, gender = ?, commercial_name_no = ?, speciality = ?,
        phone_number = ?, address = ?, affiliation_date = ?, expire_date = ?, photo_path = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      name, english_name || '', commercial_name || '', activity || '', english_activity || '',
      card_no, stamp_no || '', renewal_no || '', card_class || '4', resolvedGender, commercial_name_no || '', speciality || '',
      phone_number || '', address || '', affiliation_date || '', expire_date || '', photoPath,
      now, traderBefore.id
    );

    invalidateTradersCache();

    const updatedRow = {
      ...traderBefore,
      name,
      english_name: english_name || '',
      commercial_name: commercial_name || '',
      activity: activity || '',
      english_activity: english_activity || '',
      card_no,
      stamp_no: stamp_no || '',
      renewal_no: renewal_no || '',
      card_class: card_class || '4',
      gender: resolvedGender,
      commercial_name_no: commercial_name_no || '',
      speciality: speciality || '',
      phone_number: phone_number || '',
      address: address || '',
      affiliation_date: affiliation_date || '',
      expire_date: expire_date || '',
      photo_path: photoPath,
      updated_at: now,
    };

    await accessSyncNotify(db, traderBefore.uuid || req.params.uuid, traderBefore, updatedRow);

    const redirectPath = traderBefore.member_type === 'broker' ? '/brokers' : (traderBefore.member_type === 'company' ? '/companies' : '/traders');
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Error updating trader: ' + escapeHtml(err.message));
  }
}

app.patch('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.post('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.put('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);

// Delete Trader / Broker / Company
app.delete('/traders/:uuid', async (req, res) => {
  try {
    await executeSoftDelete(req, res);
  } catch (err) {
    res.status(500).send('Error deleting trader: ' + escapeHtml(err.message));
  }
});

// Export Traders CSV (Respects search & status filters; excludes deleted by default)
app.get('/traders/export/csv', async (req, res) => {
  try {
    const today = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const filename = `traders-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const headers = [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Renewal No', 'Card Class', 'Gender', 'Commercial Name No', 'Speciality',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map((h) => `"${h}"`).join(',') + '\n');

    const { whereSql, params } = buildTradersFilter(req.query);
    const rows = await db.prepare(`SELECT * FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC`).all(...params);

    for (const r of rows) {
      const line = [
        r.name || '', r.english_name || '', r.commercial_name || '', r.activity || '', r.english_activity || '',
        r.card_no || '', r.renewal_no || '', r.card_class || '', normalizeGender(r.gender), r.commercial_name_no || '', r.speciality || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map((val) => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + escapeHtml(err.message));
  }
});

// Brokers View
app.get('/brokers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const { whereSql, params, isAdvancedSearch } = buildBrokersFilter(req.query);
    const { totalCount, rows: brokers } = await runCachedPaginatedQuery(LIST_SELECT_COLS, whereSql, params, limit, offset);
    const totalPages = Math.ceil(totalCount / limit);

    const queryCopy = { ...req.query };
    delete queryCopy.page;
    const qs = Object.keys(queryCopy).length ? '&' + new URLSearchParams(queryCopy).toString() : '';

    res.render('brokers/index', {
      currentPath: '/brokers',
      brokers,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      isAdvancedSearch,
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + escapeHtml(err.message));
  }
});

// Export Brokers CSV
app.get('/brokers/export/csv', async (req, res) => {
  try {
    const today = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const filename = `brokers-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const headers = [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Stamp No', 'Renewal No', 'Card Class', 'Gender', 'Commercial Name No',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map((h) => `"${h}"`).join(',') + '\n');

    const { whereSql, params } = buildBrokersFilter(req.query);
    const rows = await db.prepare(`SELECT * FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC`).all(...params);

    for (const r of rows) {
      const line = [
        r.name || '', r.english_name || '', r.commercial_name || '', r.activity || '', r.english_activity || '',
        r.card_no || '', r.stamp_no || '', r.renewal_no || '', r.card_class || '', normalizeGender(r.gender), r.commercial_name_no || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map((val) => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + escapeHtml(err.message));
  }
});

// Redirect /brokers/:uuid/edit to /traders/:uuid/edit
app.get('/brokers/:uuid/edit', (req, res) => {
  res.redirect(`/traders/${encodeURIComponent(req.params.uuid)}/edit`);
});

// Companies View
app.get('/companies', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const { whereSql, params, isAdvancedSearch } = buildCompaniesFilter(req.query);
    const { totalCount, rows: companies } = await runCachedPaginatedQuery(LIST_SELECT_COLS, whereSql, params, limit, offset);
    const totalPages = Math.ceil(totalCount / limit);

    const queryCopy = { ...req.query };
    delete queryCopy.page;
    const qs = Object.keys(queryCopy).length ? '&' + new URLSearchParams(queryCopy).toString() : '';

    res.render('companies/index', {
      currentPath: '/companies',
      companies,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      isAdvancedSearch,
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + escapeHtml(err.message));
  }
});

// Export Companies CSV (Respects search & status filters; excludes deleted by default)
app.get('/companies/export/csv', async (req, res) => {
  try {
    const filename = `companies-export-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const headers = [
      'Company Name', 'English Company Name', 'CEO Name', 'English CEO Name', 'Activity',
      'Card No', 'Renewal No', 'Card Class', 'Gender', 'Incorporation Certificate No', 'Incorporation Symbol',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map((h) => `"${h}"`).join(',') + '\n');

    const { whereSql, params } = buildCompaniesFilter(req.query);
    const rows = await db.prepare(`SELECT * FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC`).all(...params);

    for (const r of rows) {
      const line = [
        r.company_name || r.commercial_name || '', r.english_company_name || '', r.ceo_name || r.name || '', r.english_ceo_name || r.english_name || '', r.activity || '',
        r.card_no || '', r.renewal_no || '', r.card_class || '', normalizeGender(r.gender), r.incorporation_certificate_no || '', r.incorporation_certificate_symbol || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map((val) => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + escapeHtml(err.message));
  }
});

// Company Edit / Actions redirect to trader unified handler
app.get('/companies/:uuid/edit', (req, res) => {
  res.redirect('/traders/' + encodeURIComponent(req.params.uuid) + '/edit');
});

// ==========================================
// API & Validation Endpoints
// ==========================================

const DEFAULT_CARD_TYPOGRAPHY = {
  front: {
    name_size: 28, name_x: 900, name_y: 308,
    class_size: 26, class_x: 890, class_y: 366,
    comm_size: 24, comm_x: 795, comm_y: 432,
    activity_size: 24, activity_x: 885, activity_y: 490,
    card_no_size: 30, card_no_x: 845, card_no_y: 560,
    aff_date_size: 23, aff_date_x: 885, aff_date_y: 626,
    exp_date_size: 23, exp_date_x: 465, exp_date_y: 626
  },
  back: {
    name_size: 26, name_x: 14, name_y: 305,
    class_size: 24, class_x: 118, class_y: 368,
    comm_no_size: 24, comm_no_x: 390, comm_no_y: 423,
    activity_size: 22, activity_x: 165, activity_y: 474,
    card_no_size: 30, card_no_x: 125, card_no_y: 560,
    aff_date_size: 22, aff_date_x: 170, aff_date_y: 620,
    exp_date_size: 22, exp_date_x: 735, exp_date_y: 620,
    qr_x: 757, qr_y: 210, qr_size: 238
  }
};

const DEFAULT_COMPANY_CARD_TYPOGRAPHY = {
  front: {
    comp_size: 26, comp_x: 900, comp_y: 285,
    ceo_size: 24, ceo_x: 815, ceo_y: 338,
    class_act_size: 24, class_act_x: 775, class_act_y: 385,
    cert_size: 24, cert_x: 725, cert_y: 435,
    comm_date_size: 24, comm_date_x: 800, comm_date_y: 485,
    card_no_size: 30, card_no_x: 845, card_no_y: 560,
    aff_date_size: 23, aff_date_x: 885, aff_date_y: 626,
    exp_date_size: 23, exp_date_x: 465, exp_date_y: 626
  },
  back: {
    comp_en_size: 36, comp_en_x: 195, comp_en_y: 322,
    ceo_en_size: 33, ceo_en_x: 105, ceo_en_y: 364,
    class_act_en_size: 33, class_act_en_x: 272, class_act_en_y: 410,
    license_en_size: 33, license_en_x: 215, license_en_y: 453,
    comm_no_size: 33, comm_no_x: 398, comm_no_y: 496,
    card_no_size: 30, card_no_x: 125, card_no_y: 560,
    aff_date_size: 23, aff_date_x: 170, aff_date_y: 620,
    exp_date_size: 24, exp_date_x: 649, exp_date_y: 620,
    qr_x: 754, qr_y: 212, qr_size: 234
  }
};

const DEFAULT_BROKER_CARD_TYPOGRAPHY = {
  front: {
    name_size: 28, name_x: 910, name_y: 308,
    class_size: 26, class_x: 898, class_y: 368,
    comm_size: 24, comm_x: 800, comm_y: 432,
    activity_size: 24, activity_x: 898, activity_y: 496,
    card_no_size: 30, card_no_x: 860, card_no_y: 560,
    aff_date_size: 23, aff_date_x: 898, aff_date_y: 630,
    exp_date_size: 23, exp_date_x: 470, exp_date_y: 630
  },
  back: {
    name_size: 28, name_x: 130, name_y: 308,
    class_size: 28, class_x: 120, class_y: 368,
    comm_no_size: 28, comm_no_x: 395, comm_no_y: 425,
    activity_size: 28, activity_x: 165, activity_y: 478,
    card_no_size: 30, card_no_x: 125, card_no_y: 560,
    aff_date_size: 24, aff_date_x: 170, aff_date_y: 625,
    exp_date_size: 24, exp_date_x: 735, exp_date_y: 625,
    qr_x: 758, qr_y: 207, qr_size: 238
  }
};

function getSettingDefaultsForKey(key) {
  if (key === 'company_card_typography') return DEFAULT_COMPANY_CARD_TYPOGRAPHY;
  if (key === 'broker_card_typography') return DEFAULT_BROKER_CARD_TYPOGRAPHY;
  return DEFAULT_CARD_TYPOGRAPHY;
}

function normalizeTraderTypography(parsed) {
  if (parsed && parsed.back) {
    if (parsed.back.name_size === undefined) parsed.back.name_size = DEFAULT_CARD_TYPOGRAPHY.back.name_size;
    if (parsed.back.name_x === undefined) parsed.back.name_x = DEFAULT_CARD_TYPOGRAPHY.back.name_x;
    if (parsed.back.name_y === undefined) parsed.back.name_y = DEFAULT_CARD_TYPOGRAPHY.back.name_y;
  }
  return parsed;
}

async function getTypographySettingCached(key) {
  const now = Date.now();
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const fallback = getSettingDefaultsForKey(key);
  let resolved = fallback;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value) {
      resolved = JSON.parse(row.value);
      if (key === 'card_typography') resolved = normalizeTraderTypography(resolved);
    }
  } catch (_) {}
  settingsCache.set(key, { value: resolved, expiresAt: now + SETTINGS_TTL_MS });
  return resolved;
}

async function getQrBundleForUuid(req, uuid) {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : req.protocol;
  const validateUrl = `${protocol}://${host}/traders/validate/${uuid}`;
  let qrDataUrl = qrCache.get(validateUrl);
  if (!qrDataUrl) {
    qrDataUrl = await QRCode.toDataURL(validateUrl, {
      margin: 0,
      width: 300,
      color: { dark: '#000000', light: '#00000000' },
    });
    setBoundedMap(qrCache, validateUrl, qrDataUrl, 500);
  }
  return { qr_url: qrDataUrl, validate_url: validateUrl };
}

// Profile Page (Batched 1-RTT Fetch + Cached Settings)
let profileSamplesCache = null; // { sampleTrader, sampleCompany, sampleBroker, expiresAt }

app.get('/profile', async (req, res) => {
  try {
    const now = Date.now();
    let settings, companySettings, brokerSettings, sampleTrader, sampleCompany, sampleBroker;

    const hasCachedSettings =
      settingsCache.get('card_typography')?.expiresAt > now &&
      settingsCache.get('company_card_typography')?.expiresAt > now &&
      settingsCache.get('broker_card_typography')?.expiresAt > now;

    if (hasCachedSettings && profileSamplesCache && profileSamplesCache.expiresAt > now) {
      settings = settingsCache.get('card_typography').value;
      companySettings = settingsCache.get('company_card_typography').value;
      brokerSettings = settingsCache.get('broker_card_typography').value;
      ({ sampleTrader, sampleCompany, sampleBroker } = profileSamplesCache);
    } else {
      const [sRes, tSampleRes, cSampleRes, bSampleRes] = await db.batch(
        [
          {
            sql: `SELECT key, value FROM settings WHERE key IN ('card_typography', 'company_card_typography', 'broker_card_typography')`,
            args: [],
          },
          { sql: `SELECT * FROM traders WHERE member_type = 'trader' AND photo_path IS NOT NULL AND commercial_name_no IS NOT NULL AND commercial_name_no != '' LIMIT 1`, args: [] },
          { sql: `SELECT * FROM traders WHERE member_type = 'company' AND photo_path IS NOT NULL AND commercial_name_no IS NOT NULL AND commercial_name_no != '' LIMIT 1`, args: [] },
          { sql: `SELECT * FROM traders WHERE member_type = 'broker' AND photo_path IS NOT NULL AND commercial_name_no IS NOT NULL AND commercial_name_no != '' LIMIT 1`, args: [] },
        ],
        'read'
      );

      const sMap = new Map(sRes.rows.map((r) => [r.key, r.value]));
      const parseOr = (k, def) => {
        try {
          return sMap.has(k) && sMap.get(k) ? JSON.parse(sMap.get(k)) : def;
        } catch {
          return def;
        }
      };

      settings = normalizeTraderTypography(parseOr('card_typography', DEFAULT_CARD_TYPOGRAPHY));
      companySettings = parseOr('company_card_typography', DEFAULT_COMPANY_CARD_TYPOGRAPHY);
      brokerSettings = parseOr('broker_card_typography', DEFAULT_BROKER_CARD_TYPOGRAPHY);

      settingsCache.set('card_typography', { value: settings, expiresAt: now + SETTINGS_TTL_MS });
      settingsCache.set('company_card_typography', { value: companySettings, expiresAt: now + SETTINGS_TTL_MS });
      settingsCache.set('broker_card_typography', { value: brokerSettings, expiresAt: now + SETTINGS_TTL_MS });

      sampleTrader = tSampleRes.first || {
        name: 'حسين عبد الاله جعفر',
        english_name: 'Hussein Abdul-Ilah Jaafar',
        commercial_name: 'اسواق بركات الرحمن',
        commercial_name_no: '49269',
        activity: 'المواد الغذائية',
        english_activity: 'Alimentative materials',
        card_class: '4',
        card_no: '7613',
        renewal_no: '1303',
        affiliation_date: '2026-10-12',
        expire_date: '2026-12-31',
        photo_path: '/templates/avatar_placeholder.png',
        uuid: 'sample-uuid',
        member_type: 'trader'
      };

      sampleCompany = cSampleRes.first || {
        name: 'محمد عبد الكريم عبد الحسين',
        english_name: 'MOHAMMED ABDULKAREEM A. AL',
        company_name: 'الطلبات',
        english_company_name: 'ALTALBAT CO.',
        ceo_name: 'محمد عبد الكريم عبد الحسين',
        english_ceo_name: 'MOHAMMED ABDULKAREEM A. AL',
        commercial_name: 'الطلبات',
        activity: 'توسط بيع وشراء العملات',
        english_activity: 'Foreign currency brokerage services',
        incorporation_certificate_no: '84067',
        incorporation_certificate_symbol: 'مش',
        commercial_name_no: '49349',
        card_class: '0',
        card_no: '996',
        renewal_no: '377',
        affiliation_date: '2026-11-03',
        expire_date: '2026-12-31',
        photo_path: '/templates/avatar_placeholder.png',
        uuid: 'sample-company-uuid',
        member_type: 'company'
      };

      sampleBroker = bSampleRes.first || {
        name: 'حسين حازم فرحان',
        english_name: 'HUSSEIN HAZIM FARHAN',
        commercial_name: 'مكتب طريق العلماء',
        commercial_name_no: '49465',
        activity: 'دلالية العقارات',
        english_activity: 'Real Estates BROKER',
        card_class: '1',
        card_no: '1337',
        stamp_no: '1337',
        renewal_no: '773',
        affiliation_date: '2026-11-05',
        expire_date: '2027-11-04',
        photo_path: '/templates/avatar_placeholder.png',
        uuid: 'sample-broker-uuid',
        member_type: 'broker'
      };

      profileSamplesCache = { sampleTrader, sampleCompany, sampleBroker, expiresAt: now + SETTINGS_TTL_MS };
    }

    res.render('profile/index', {
      currentPath: '/profile',
      user: { name: 'Site Admin', email: 'admin@k-coc.org' },
      settings,
      companySettings,
      brokerSettings,
      sampleTrader,
      sampleCompany,
      sampleBroker,
      successMsg: req.query.saved ? 'تم حفظ إعدادات الخطوط والتصميم بنجاح!' : null,
    });
  } catch (err) {
    res.status(500).send('Error loading profile: ' + escapeHtml(err.message));
  }
});

// Profile Update (Mock)
app.patch('/profile', (req, res) => {
  res.redirect('/profile?saved=1');
});

// Get Card Typography Settings API (Cached)
app.get('/api/settings/card-typography', async (req, res) => {
  const settings = await getTypographySettingCached('card_typography');
  res.json({ success: true, settings });
});

// Save Card Typography Settings API
app.post('/api/settings/card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('card_typography', ?)").run(JSON.stringify(newSettings));
    settingsCache.set('card_typography', { value: newSettings, expiresAt: Date.now() + SETTINGS_TTL_MS });
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Card Typography Settings API
app.post('/api/settings/card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('card_typography', ?)").run(JSON.stringify(DEFAULT_CARD_TYPOGRAPHY));
    invalidateSettingsCache('card_typography');
    res.json({ success: true, settings: DEFAULT_CARD_TYPOGRAPHY, message: 'Settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Company Card Typography Settings API (Cached)
app.get('/api/settings/company-card-typography', async (req, res) => {
  const settings = await getTypographySettingCached('company_card_typography');
  res.json({ success: true, settings });
});

// Save Company Card Typography Settings API
app.post('/api/settings/company-card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_card_typography', ?)").run(JSON.stringify(newSettings));
    settingsCache.set('company_card_typography', { value: newSettings, expiresAt: Date.now() + SETTINGS_TTL_MS });
    res.json({ success: true, message: 'Company settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Company Card Typography Settings API
app.post('/api/settings/company-card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_card_typography', ?)").run(JSON.stringify(DEFAULT_COMPANY_CARD_TYPOGRAPHY));
    invalidateSettingsCache('company_card_typography');
    res.json({ success: true, settings: DEFAULT_COMPANY_CARD_TYPOGRAPHY, message: 'Company settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Broker Card Typography Settings API (Cached)
app.get('/api/settings/broker-card-typography', async (req, res) => {
  const settings = await getTypographySettingCached('broker_card_typography');
  res.json({ success: true, settings });
});

// Save Broker Card Typography Settings API
app.post('/api/settings/broker-card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('broker_card_typography', ?)").run(JSON.stringify(newSettings));
    settingsCache.set('broker_card_typography', { value: newSettings, expiresAt: Date.now() + SETTINGS_TTL_MS });
    res.json({ success: true, message: 'Broker settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Broker Card Typography Settings API
app.post('/api/settings/broker-card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('broker_card_typography', ?)").run(JSON.stringify(DEFAULT_BROKER_CARD_TYPOGRAPHY));
    invalidateSettingsCache('broker_card_typography');
    res.json({ success: true, settings: DEFAULT_BROKER_CARD_TYPOGRAPHY, message: 'Broker settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Trader JSON API (Supports ?bundle=1 to return trader + globalTypography + QR in ONE single fast request!)
app.get('/api/traders/:id', async (req, res) => {
  try {
    const trader = await findTraderByIdentifier(req.params.id, true);
    if (!trader) return res.status(404).json({ success: false, error: 'Not found' });

    if (req.query.bundle === '1') {
      const settingKey =
        trader.member_type === 'company'
          ? 'company_card_typography'
          : trader.member_type === 'broker'
          ? 'broker_card_typography'
          : 'card_typography';

      const [globalTypography, qrData] = await Promise.all([
        getTypographySettingCached(settingKey),
        getQrBundleForUuid(req, trader.uuid),
      ]);

      return res.json({
        success: true,
        trader,
        globalTypography,
        qr_url: qrData.qr_url,
        validate_url: qrData.validate_url,
      });
    }

    res.json({ success: true, trader });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save Custom Typography for Single Trader
app.post('/api/traders/:id/typography', async (req, res) => {
  try {
    const typoJson = JSON.stringify(req.body.typography || req.body);
    const { clause, param } = buildKeyWhereClause(req.params.id);
    await db.prepare(`UPDATE traders SET custom_typography = ? WHERE ${clause}`).run(typoJson, param);
    res.json({ success: true, message: 'Custom typography saved for this trader' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Custom Typography for Single Trader
app.post('/api/traders/:id/typography/reset', async (req, res) => {
  try {
    const { clause, param } = buildKeyWhereClause(req.params.id);
    await db.prepare(`UPDATE traders SET custom_typography = NULL WHERE ${clause}`).run(param);
    res.json({ success: true, message: 'Reset to global settings for this trader' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trader QR Code Data URL (Zero DB query when UUID is passed directly + LRU cached!)
app.get('/api/traders/:id/qr', async (req, res) => {
  try {
    let targetUuid = req.params.id;
    if (!isUuidLike(targetUuid)) {
      const trader = await findTraderByIdentifier(req.params.id, false);
      if (!trader) return res.status(404).json({ success: false, error: 'Not found' });
      targetUuid = trader.uuid;
    }

    const qrData = await getQrBundleForUuid(req, targetUuid);
    res.json({ success: true, qr_url: qrData.qr_url, validate_url: qrData.validate_url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Official Public Validation Page (XSS-Hardened + Supports Traders, Brokers, and Companies)
app.get('/traders/validate/:uuid', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ? AND (deleted_at IS NULL OR deleted_at = '')").get(req.params.uuid);
    if (!trader) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="utf-8">
          <title>صحة الصدور - غير موجود</title>
          <link rel="stylesheet" href="/build/assets/app-514d3f3f.css" />
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
          <div class="bg-white p-8 rounded-xl shadow max-w-md w-full text-center">
            <h1 class="text-2xl font-bold text-red-600 mb-2">الهوية غير صالحة</h1>
            <p class="text-gray-600">لم يتم العثور على سجل فعال لهذه الهوية في غرفة تجارة كربلاء المقدسة.</p>
          </div>
        </body>
        </html>
      `);
    }

    const isExpired = trader.expire_date && new Date(trader.expire_date) < new Date();
    const rawPhoto = String(trader.photo_path || '');
    const safePhotoUrl = rawPhoto.startsWith('/uploads/') || rawPhoto.startsWith('/templates/')
      ? escapeHtml(rawPhoto)
      : '/templates/avatar_placeholder.png';

    const isComp = trader.member_type === 'company';
    const isBroker = trader.member_type === 'broker';
    const arTitleLabel = isComp ? 'الشركة' : (isBroker ? 'الدلال' : 'التاجر');
    const arDisplayName = isComp ? (trader.company_name || trader.commercial_name || trader.name) : trader.name;
    const enDisplayName = isComp ? (trader.english_company_name || trader.english_name || trader.company_name) : trader.english_name;

    res.send(`
<!DOCTYPE html>
<html lang="en" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Karbala Chamber of Commerce</title>
    <link rel="stylesheet" href="/build/assets/app-514d3f3f.css" />
    <style>
      @font-face {
        font-family: 'PT Bold Heading';
        src: url('/templates/PTBoldHeading.woff2') format('woff2');
        font-weight: bold;
        font-display: swap;
      }
      @font-face {
        font-family: 'Myriad Pro';
        src: url('/templates/MyriadPro-Bold.woff2') format('woff2');
        font-weight: bold;
        font-display: swap;
      }
      .ArText { font-family: "PT Bold Heading", sans-serif; display: block; font-size: 1em; text-align: right; direction: rtl; }
      .EnText { font-family: "Myriad Pro", Arial, sans-serif; display: block; font-size: 1em; text-align: left; direction: ltr; }
      #foreground, #background { border: 1px solid #000; border-radius: 5px; padding: 10px; margin-bottom: 15px; }
      .container { max-width: 450px; position: relative; }
      #ArPersonPic { width: 90px; height: 115px; object-fit: cover; border-radius: 4px; float: left; margin-bottom: 10px; }
    </style>
</head>
<body class="antialiased bg-gray-100 py-10">
<div class="max-w-2xl mx-auto px-4">
    <div class="flex justify-center">
        <img style="max-width: 100px" src="/images/chamber-logo.png" alt="Chamber Logo">
    </div>

    <div class="flex justify-center mt-6 text-center">
        <div>
            <p style="font-size: 3em; color: green">☑</p>
            <p class="font-medium text-gray-800 mt-2">اذا تطابقت المعلومات ادناه مع الهوية المرفقة فأن ذلك يعني صحة صدور الهوية من غرفة تجارة كربلاء المقدسة</p>
            <p class="text-xs text-gray-500 mt-1">If below information matches the physical ID then that proves the Authenticity of issuance of ID by Karbala Chamber of commerce</p>
        </div>
    </div>

    <div class="mt-8 flex justify-center">
        <div class="container w-full bg-white p-6 rounded-lg shadow">
            <div id="foreground">
                <img id="ArPersonPic" src="${safePhotoUrl}" onerror="this.onerror=null;this.src='/templates/avatar_placeholder.png'" alt="Photo"/>
                <p id="ArName" class="ArText">${escapeHtml(arTitleLabel)}: ${escapeHtml(arDisplayName || '-')}</p>
                ${isComp && trader.ceo_name ? `<p class="ArText">المدير المفوض: ${escapeHtml(trader.ceo_name)}</p>` : ''}
                <p id="ArClass" class="ArText">الصنف: ${escapeHtml(isBroker ? 'دلالية' : formatClassName(trader.card_class, 'ar'))}</p>
                <p id="ArCommercialName" class="ArText">الاسم التجاري: ${escapeHtml(trader.commercial_name || '-')} / <span id="ArCommercialNameNo">${escapeHtml(trader.commercial_name_no || '')}</span></p>
                <p id="ArActivity" class="ArText">النشاط: ${escapeHtml(trader.activity || '-')}</p>
                <p id="CardNo" class="ArText font-bold text-blue-700">رقم الهوية: ${escapeHtml(trader.card_no || '')} ${trader.renewal_no ? '/ ' + escapeHtml(trader.renewal_no) : ''}</p>
                <p id="ArAffiliationDate" class="ArText">الانتماء: <span dir="ltr" style="display:inline-block;">${escapeHtml(trader.affiliation_date || '-')}</span></p>
                <p id="ArExpireDate" class="ArText ${isExpired ? 'text-red-600' : 'text-green-700'}">النفاذ: <span dir="ltr" style="display:inline-block;">${escapeHtml(trader.expire_date || '-')}</span></p>
            </div>
            <div id="background">
                <p id="EnName" class="EnText font-bold">${escapeHtml(enDisplayName || '-')}</p>
                <p id="EnClass" class="EnText">Class: ${escapeHtml(formatClassName(trader.card_class, 'en'))}</p>
                <p id="EnCommercialNameNo" class="EnText">Commercial Name No: ${escapeHtml(trader.commercial_name_no || '-')}</p>
                <p id="EnActivity" class="EnText">Activity: ${escapeHtml(trader.english_activity || trader.activity || '-')}</p>
                <p id="EnCardNo" class="EnText font-bold">ID No: ${escapeHtml(trader.card_no || '')} ${trader.renewal_no ? '/ ' + escapeHtml(trader.renewal_no) : ''}</p>
                <p id="EnAffiliationDate" class="EnText">Affiliation: ${escapeHtml(trader.affiliation_date || '-')}</p>
                <p id="EnExpireDate" class="EnText">Expire: ${escapeHtml(trader.expire_date || '-')}</p>
            </div>
        </div>
    </div>

    <script>
        String.prototype.EntoAr = function () {
            return this.replace(/\\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
        };
        const elAff = document.getElementById('ArAffiliationDate');
        if (elAff) elAff.innerText = elAff.innerText.EntoAr();
        const elExp = document.getElementById('ArExpireDate');
        if (elExp) elExp.innerText = elExp.innerText.EntoAr();
        const elCard = document.getElementById('CardNo');
        if (elCard) elCard.innerText = elCard.innerText.EntoAr();
        const elComm = document.getElementById('ArCommercialNameNo');
        if (elComm) elComm.innerText = elComm.innerText.EntoAr();
    </script>
</div>
</body>
</html>
    `);
  } catch (err) {
    res.status(500).send('Error: ' + escapeHtml(err.message));
  }
});

// Friendly Multer / Upload Error Handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('حجم الصورة يتجاوز الحد الأقصى المسموح به (5 ميجابايت).');
    }
    return res.status(400).send('Upload error: ' + escapeHtml(err.message));
  }
  if (err) {
    return res.status(400).send(escapeHtml(err.message || 'Unexpected error'));
  }
  next();
});

function getNetworkIps() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 خادم نظام Cardval السريع والمحسّن يعمل الآن بنجاح!`);
  console.log(`💻 من هذا الكمبيوتر:        http://localhost:${PORT}/traders`);
  const ips = getNetworkIps();
  ips.forEach((ip) => {
    console.log(`📱 من الأجهزة الأخرى (${ip.name}): http://${ip.address}:${PORT}/traders`);
  });
  console.log(`======================================================\n`);
});

export default app;
