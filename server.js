import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db, dbReady, isFtsReady, removeUnreferencedUploadFile } from './db.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import multer from 'multer';
import { notifyAdded as accessSyncAdd, notifySaved as accessSyncNotify, notifyDeleted as accessSyncDelete } from './accessHubSync.js';
import {
  LANG_COOKIE_NAME,
  isValidLang,
  parseLangFromRequest,
  createTranslator,
  getCsvHeaders,
  sanitizeRedirectPath,
} from './i18n.js';

const gzipAsync = promisify(zlib.gzip);
const brotliCompressAsync = promisify(zlib.brotliCompress);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Deterministic asset revision hash for cache/PJAX invalidation across deploys
const APP_ASSET_REV = (() => {
  const hash = crypto.createHash('sha1');
  const assetPaths = [
    path.join(__dirname, 'public', 'js', 'cardModal.js'),
    path.join(__dirname, 'public', 'js', 'fastNav.js'),
    path.join(__dirname, 'public', 'css', 'cardModal.css'),
    path.join(__dirname, 'views', 'partials', 'card_modal.ejs'),
  ];
  for (const p of assetPaths) {
    try {
      hash.update(fs.readFileSync(p));
    } catch (_) {}
  }
  return hash.digest('hex').slice(0, 12);
})();

// Setup View Engine + Enable Template Compilation Cache (prevents OneDrive disk reads on every click)
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', true);

// Security Headers & Asset Revision Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Cardval-Asset-Rev', APP_ASSET_REV);
  res.locals.appAssetRev = APP_ASSET_REV;
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
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(u.hostname)
        ) {
          return callback(null, true);
        }
      } catch (_) {}
      return callback(null, false);
    },
  })
);

// Fast Built-in Brotli + Gzip Compression for HTML & JSON responses (>= 1KB)
app.use((req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const supportsBr = acceptEncoding.includes('br');
  const supportsGzip = acceptEncoding.includes('gzip');
  if (!supportsBr && !supportsGzip) return next();

  const origSend = res.send.bind(res);
  res.send = function (body) {
    if (res.headersSent || res.getHeader('Content-Encoding') || body === undefined || body === null) {
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

    const useBr = supportsBr;
    const compressPromise = useBr
      ? brotliCompressAsync(buf, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          },
        })
      : gzipAsync(buf, { level: zlib.constants.Z_BEST_SPEED });

    compressPromise
      .then((compressed) => {
        if (res.headersSent) return;
        res.setHeader('Content-Encoding', useBr ? 'br' : 'gzip');
        res.vary('Accept-Encoding');
        res.setHeader('Content-Length', compressed.byteLength);
        origSend(compressed);
      })
      .catch(() => {
        if (!res.headersSent) origSend(body);
      });

    return res;
  };
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Pre-Compressed Static Asset Middleware (Brotli + Gzip with mtime-checked bounded LRU cache)
const publicRoot = path.resolve(__dirname, 'public');
const staticCompressedCache = new Map();
const STATIC_MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

app.use(async (req, res, next) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const pathname = req.path || '/';
    if (pathname.startsWith('/api/')) return next();

    const ext = path.extname(pathname).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext];
    if (!contentType) return next();

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const encoding = acceptEncoding.includes('br')
      ? 'br'
      : acceptEncoding.includes('gzip')
      ? 'gzip'
      : null;
    if (!encoding) return next();

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return next();
    }
    if (decodedPath.includes('\0')) return next();

    const relativePath = decodedPath.replace(/^[/\\]+/, '');
    const resolved = path.resolve(publicRoot, relativePath);
    if (!resolved.startsWith(publicRoot + path.sep)) {
      return next();
    }

    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    const cacheKey = `${resolved}::${stat.mtimeMs}::${encoding}`;
    let entry = staticCompressedCache.get(cacheKey);
    if (entry) {
      staticCompressedCache.delete(cacheKey);
      staticCompressedCache.set(cacheKey, entry);
    } else {
      const raw = await fsp.readFile(resolved);
      const buf =
        encoding === 'br'
          ? zlib.brotliCompressSync(raw, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
              },
            })
          : zlib.gzipSync(raw, { level: 6 });
      const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${encoding}"`;
      entry = { buf, etag };
      setBoundedMap(staticCompressedCache, cacheKey, entry, 120);
    }

    const isImmutable =
      pathname.includes('/build/assets/') ||
      pathname.includes('/templates/previews/') ||
      'v' in req.query;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', entry.etag);
    res.setHeader(
      'Cache-Control',
      isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
    );

    if (req.headers['if-none-match'] === entry.etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', entry.buf.byteLength);
    return res.status(200).end(req.method === 'HEAD' ? undefined : entry.buf);
  } catch {
    return next();
  }
});

// Static files with aggressive browser caching
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      if (
        normalized.includes('/public/build/assets/') ||
        normalized.includes('/public/uploads/') ||
        normalized.includes('/public/templates/previews/') ||
        (res.req && res.req.query && 'v' in res.req.query)
      ) {
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

// Ensure SQLite PRAGMAs, indexes, and FTS availability check complete before dynamic routes run
app.use((req, res, next) => {
  dbReady.then(() => next(), () => next());
});

// Bilingual UI Middleware (Arabic default, persisted via cookie, LTR layout)
app.use((req, res, next) => {
  const lang = parseLangFromRequest(req);
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.isAr = lang === 'ar';
  res.locals.t = createTranslator(lang);
  res.locals.currentUrl = req.originalUrl || '/';
  res.vary('Cookie');
  next();
});

// Local persistent uploads directory
const uploadDir = path.join(__dirname, 'public', 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (_) {}

// ==========================================
// In-Memory Smart Cache (Instant Invalidation on Writes)
// ==========================================
const LIST_TTL_MS = 60_000;      // 60s for paginated feeds (instant invalidation on local writes)
const COUNT_TTL_MS = 120_000;    // 120s for total counts
const DASH_TTL_MS = 60_000;      // 60s for dashboard stats
const SETTINGS_TTL_MS = 300_000; // 5m for global card typography settings

let dashboardCache = null; // { data, expiresAt }
const listCache = new Map();
const countCache = new Map();
const settingsCache = new Map();
const qrCache = new Map();

function setBoundedMap(map, key, val, maxEntries = 250) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
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

// Serve trader/broker/company photos directly from local persistent storage
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

function normalizeCompanyRole(val) {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'bm' || v === 'branch_manager') return 'bm';
  return 'ceo';
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
  activity, card_no, created_by, created_at, deleted_at, member_type, company_role
`;

function memberBasePath(memberType) {
  if (memberType === 'broker') return '/brokers';
  if (memberType === 'company') return '/companies';
  return '/traders';
}

function memberEditPath(memberType, uuid) {
  const editBase = memberType === 'company' ? '/companies' : '/traders';
  return `${editBase}/${encodeURIComponent(uuid)}/edit`;
}

function resolveListReturnUrl(req, basePath, isDeleted = false) {
  const defaultUrl = isDeleted ? `${basePath}?status=deleted` : basePath;
  const rawCandidate = req.query?.return_to || req.get('referer') || '';
  if (!rawCandidate) return defaultUrl;
  const sanitized = sanitizeRedirectPath(rawCandidate, req.headers.host || '', '');
  if (!sanitized) return defaultUrl;
  try {
    const parsed = new URL(sanitized, 'http://localhost');
    const cleanPathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (cleanPathname === basePath) {
      return `${cleanPathname}${parsed.search}`;
    }
  } catch (_) {}
  return defaultUrl;
}

function wantsJsonRequest(req) {
  return Boolean(
    req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      req.headers['x-requested-with'] === 'fetch'
  );
}

function buildListQueryStrings(rawQuery = {}) {
  const queryCopy = { ...rawQuery };
  delete queryCopy.page;
  const serialized = new URLSearchParams(queryCopy).toString();
  return {
    queryString: serialized ? '&' + serialized : '',
    exportQueryString: serialized ? '?' + serialized : '',
  };
}

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

function appendFastTextSearch(where, params, rawTerm, ftsColumns, fallbackLikeSql, fallbackParamCount) {
  const trimmed = String(rawTerm || '').trim();
  if (!trimmed) return;

  if (isFtsReady() && Array.from(trimmed).length >= 3) {
    const escaped = trimmed.replace(/"/g, '""');
    where.push('id IN (SELECT rowid FROM traders_fts WHERE traders_fts MATCH ?)');
    params.push(`{${ftsColumns.join(' ')}} : "${escaped}"`);
    return;
  }

  where.push(fallbackLikeSql);
  const likeTerm = `%${trimmed}%`;
  for (let i = 0; i < fallbackParamCount; i++) {
    params.push(likeTerm);
  }
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

  appendFastTextSearch(
    where,
    params,
    search,
    ['name', 'commercial_name', 'activity', 'card_no'],
    '(name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ?)',
    4
  );
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

  appendFastTextSearch(
    where,
    params,
    search,
    ['name', 'english_name', 'commercial_name', 'activity', 'card_no', 'stamp_no', 'phone_number'],
    '(name LIKE ? OR english_name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR stamp_no LIKE ? OR phone_number LIKE ?)',
    7
  );
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
    commercial_name, ceo_name, english_ceo_name, activity, card_no, renewal_no,
    commercial_name_no, incorporation_certificate_no, incorporation_certificate_symbol,
    speciality, card_class, gender, company_role,
    affiliation_date_from, affiliation_date_to,
    expire_date_from, expire_date_to, status
  } = q;

  const isAdvancedSearch = Boolean(
    (company_name && company_name.trim()) || (english_company_name && english_company_name.trim()) ||
    (name && name.trim()) || (english_name && english_name.trim()) ||
    (commercial_name && commercial_name.trim()) || (ceo_name && ceo_name.trim()) ||
    (english_ceo_name && english_ceo_name.trim()) ||
    (activity && activity.trim()) || (card_no && card_no.trim()) ||
    (renewal_no && renewal_no.trim()) || (commercial_name_no && commercial_name_no.trim()) ||
    (incorporation_certificate_no && incorporation_certificate_no.trim()) ||
    (incorporation_certificate_symbol && incorporation_certificate_symbol.trim()) ||
    (speciality && speciality.trim()) ||
    (card_class && card_class !== '') || (gender && gender.trim() !== '') ||
    (company_role && company_role.trim() !== '') ||
    affiliation_date_from || affiliation_date_to || expire_date_from || expire_date_to ||
    (status && status !== 'active')
  );

  const where = ["member_type = 'company'"];
  const params = [];

  appendFastTextSearch(
    where,
    params,
    search,
    ['company_name', 'english_company_name', 'ceo_name', 'name', 'english_name', 'commercial_name', 'activity', 'card_no', 'incorporation_certificate_no', 'phone_number'],
    '(company_name LIKE ? OR english_company_name LIKE ? OR ceo_name LIKE ? OR name LIKE ? OR english_name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR incorporation_certificate_no LIKE ? OR phone_number LIKE ?)',
    10
  );

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
  if (english_ceo_name && english_ceo_name.trim()) {
    where.push('(english_ceo_name LIKE ? OR english_name LIKE ?)');
    params.push(`%${english_ceo_name.trim()}%`, `%${english_ceo_name.trim()}%`);
  }
  if (activity && activity.trim()) { where.push('activity LIKE ?'); params.push(`%${activity.trim()}%`); }
  if (card_no && card_no.trim()) { where.push('card_no = ?'); params.push(card_no.trim()); }
  if (renewal_no && renewal_no.trim()) { where.push('renewal_no = ?'); params.push(renewal_no.trim()); }
  if (commercial_name_no && commercial_name_no.trim()) { where.push('commercial_name_no = ?'); params.push(commercial_name_no.trim()); }
  if (incorporation_certificate_no && incorporation_certificate_no.trim()) {
    where.push('incorporation_certificate_no LIKE ?');
    params.push(`%${incorporation_certificate_no.trim()}%`);
  }
  if (incorporation_certificate_symbol && incorporation_certificate_symbol.trim()) {
    where.push('incorporation_certificate_symbol LIKE ?');
    params.push(`%${incorporation_certificate_symbol.trim()}%`);
  }
  if (speciality && speciality.trim()) {
    where.push('speciality LIKE ?');
    params.push(`%${speciality.trim()}%`);
  }
  if (card_class && card_class !== '') { where.push('card_class = ?'); params.push(card_class); }
  appendGenderFilter(where, params, gender);
  const roleFilter = String(company_role || '').trim().toLowerCase();
  if (roleFilter === 'bm') {
    where.push("company_role = 'bm'");
  } else if (roleFilter === 'ceo') {
    where.push("(company_role IS NULL OR company_role = '' OR company_role = 'ceo')");
  }
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

async function getDashboardStats() {
  const now = Date.now();
  if (dashboardCache && dashboardCache.expiresAt > now) {
    return dashboardCache.data;
  }

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

  const stats = {
    totalTraders: row?.totalTraders || 0,
    totalBrokers: row?.totalBrokers || 0,
    totalCompanies: row?.totalCompanies || 0,
    activeMembers: row?.activeMembers || 0,
    withPhotos: row?.withPhotos || 0,
  };
  dashboardCache = { data: stats, expiresAt: now + DASH_TTL_MS };
  return stats;
}

// ==========================================
// Cardval Original Web Routes
// ==========================================

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/traders');
});

// Language Switcher Routes (Cookie persisted, same-origin redirect safe)
function handleLanguageSwitch(req, res) {
  const rawLang = String(req.params.lang || '').trim().toLowerCase();
  const targetLang = isValidLang(rawLang) ? rawLang : 'ar';
  res.setHeader(
    'Set-Cookie',
    `${LANG_COOKIE_NAME}=${targetLang}; Path=/; Max-Age=31536000; SameSite=Lax`
  );
  const candidate = req.query.redirect || req.get('referer') || '';
  const redirectTarget = sanitizeRedirectPath(candidate, req.headers.host || '', '/traders');
  return res.redirect(redirectTarget);
}

app.get('/language/:lang', handleLanguageSwitch);
app.get('/traders/language/:lang', handleLanguageSwitch);
app.get('/brokers/language/:lang', handleLanguageSwitch);
app.get('/companies/language/:lang', handleLanguageSwitch);

// Dashboard (Single SQL Covering Query + In-Memory Cache, properly excluding deleted rows)
app.get('/dashboard', async (req, res) => {
  try {
    const stats = await getDashboardStats();

    res.setHeader('Cache-Control', 'private, no-cache');
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

    const { queryString: qs, exportQueryString } = buildListQueryStrings(req.query);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('traders/index', {
      currentPath: '/traders',
      traders,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      exportQueryString,
      isAdvancedSearch,
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + escapeHtml(err.message));
  }
});

function buildNormalizedMemberFields(body = {}, resolvedType = 'trader', existing = {}) {
  const pick = (key, fallback = '') =>
    body[key] !== undefined && body[key] !== null ? String(body[key]).trim() : String(fallback ?? '');

  const isCompany = resolvedType === 'company';
  const resolvedGender = normalizeGender(body.gender !== undefined ? body.gender : existing.gender);
  const resolvedCompanyRole = isCompany
    ? normalizeCompanyRole(body.company_role !== undefined ? body.company_role : existing.company_role)
    : 'ceo';

  const companyName = isCompany
    ? (body.company_name !== undefined
        ? pick('company_name')
        : pick('commercial_name', existing.company_name ?? existing.commercial_name ?? ''))
    : pick('company_name', existing.company_name ?? '');
  const englishCompanyName = pick('english_company_name', existing.english_company_name ?? '');
  const ceoName = isCompany
    ? (body.ceo_name !== undefined
        ? pick('ceo_name')
        : pick('name', existing.ceo_name ?? existing.name ?? ''))
    : pick('ceo_name', existing.ceo_name ?? '');
  const englishCeoName = isCompany
    ? (body.english_ceo_name !== undefined
        ? pick('english_ceo_name')
        : pick('english_name', existing.english_ceo_name ?? existing.english_name ?? ''))
    : pick('english_ceo_name', existing.english_ceo_name ?? '');

  const commercialName = isCompany
    ? (companyName || pick('commercial_name', existing.commercial_name ?? ''))
    : pick('commercial_name', existing.commercial_name ?? '');
  const name = isCompany
    ? (ceoName || companyName || '')
    : pick('name', existing.name ?? '');
  const englishName = isCompany
    ? (englishCeoName || englishCompanyName || '')
    : pick('english_name', existing.english_name ?? '');

  const cardClassRaw =
    body.card_class !== undefined && body.card_class !== null && String(body.card_class).trim() !== ''
      ? String(body.card_class).trim()
      : String(existing.card_class ?? '4');

  return {
    name,
    english_name: englishName,
    commercial_name: commercialName,
    activity: pick('activity', existing.activity ?? ''),
    english_activity: pick('english_activity', existing.english_activity ?? ''),
    card_no: pick('card_no', existing.card_no ?? ''),
    stamp_no: pick('stamp_no', existing.stamp_no ?? ''),
    renewal_no: pick('renewal_no', existing.renewal_no ?? ''),
    card_class: cardClassRaw || '4',
    gender: resolvedGender,
    commercial_name_no: pick('commercial_name_no', existing.commercial_name_no ?? ''),
    speciality: pick('speciality', existing.speciality ?? ''),
    phone_number: pick('phone_number', existing.phone_number ?? ''),
    address: pick('address', existing.address ?? ''),
    affiliation_date: pick('affiliation_date', existing.affiliation_date ?? ''),
    expire_date: pick('expire_date', existing.expire_date ?? ''),
    company_name: companyName,
    english_company_name: englishCompanyName,
    ceo_name: ceoName,
    english_ceo_name: englishCeoName,
    incorporation_certificate_no: pick('incorporation_certificate_no', existing.incorporation_certificate_no ?? ''),
    incorporation_certificate_symbol: pick('incorporation_certificate_symbol', existing.incorporation_certificate_symbol ?? ''),
    company_role: resolvedCompanyRole,
  };
}

function renderCompanyForm(req, res, { isEdit, trader }) {
  const isDeleted = Boolean(isEdit && trader?.deleted_at && String(trader.deleted_at).trim() !== '');
  const returnUrl = resolveListReturnUrl(req, '/companies', isDeleted);
  res.setHeader('Cache-Control', 'private, no-cache');
  return res.render('companies/form', {
    currentPath: '/companies',
    isEdit,
    trader,
    returnUrl,
    saved: req.query?.saved === '1',
    created: req.query?.created === '1',
  });
}

// Create Trader / Broker / Company Page
app.get('/traders/create', (req, res) => {
  const memberType = req.query.type || 'trader';
  if (memberType === 'company') {
    return renderCompanyForm(req, res, {
      isEdit: false,
      trader: { member_type: 'company', card_class: '4', gender: 'ذكر', company_role: 'ceo' },
    });
  }
  const currentPath = memberType === 'broker' ? '/brokers' : '/traders';
  const returnUrl = resolveListReturnUrl(req, currentPath, false);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.render('traders/create', {
    currentPath,
    member_type: memberType,
    returnUrl,
    saved: false,
    created: false,
  });
});

app.get('/companies/create', (req, res) => {
  return renderCompanyForm(req, res, {
    isEdit: false,
    trader: { member_type: 'company', card_class: '4', gender: 'ذكر', company_role: 'ceo' },
  });
});

// Store New Trader / Broker / Company
async function handleCreateMember(req, res, forcedType = null) {
  try {
    const rawType = forcedType || req.body?.member_type;
    const resolvedType = rawType === 'broker' ? 'broker' : (rawType === 'company' ? 'company' : 'trader');
    const fields = buildNormalizedMemberFields(req.body || {}, resolvedType);

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const photoPath = req.file ? '/uploads/' + req.file.filename : null;

    const runRes = await db.prepare(`
      INSERT INTO traders (
        uuid, name, english_name, commercial_name, activity, english_activity,
        card_no, stamp_no, renewal_no, card_class, gender, commercial_name_no, speciality,
        phone_number, address, affiliation_date, expire_date, photo_path,
        company_name, english_company_name, ceo_name, english_ceo_name,
        incorporation_certificate_no, incorporation_certificate_symbol,
        member_type, company_role, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Site Admin', ?, ?)
    `).run(
      uuid, fields.name, fields.english_name, fields.commercial_name, fields.activity, fields.english_activity,
      fields.card_no, fields.stamp_no, fields.renewal_no, fields.card_class, fields.gender, fields.commercial_name_no, fields.speciality,
      fields.phone_number, fields.address, fields.affiliation_date, fields.expire_date, photoPath,
      fields.company_name, fields.english_company_name, fields.ceo_name, fields.english_ceo_name,
      fields.incorporation_certificate_no, fields.incorporation_certificate_symbol,
      resolvedType, fields.company_role, now, now
    );

    const insertedId = runRes?.lastInsertRowid != null ? Number(runRes.lastInsertRowid) : null;

    invalidateTradersCache();

    const createdRow = {
      id: insertedId,
      uuid,
      ...fields,
      photo_path: photoPath,
      member_type: resolvedType,
    };

    await accessSyncAdd(db, uuid, createdRow);

    const editUrl = memberEditPath(resolvedType, uuid);
    const updateActionUrl = resolvedType === 'company'
      ? `/companies/${encodeURIComponent(uuid)}`
      : `/traders/${encodeURIComponent(uuid)}`;
    const t = res.locals.t || createTranslator(req.lang || 'ar');
    const editTitleKey = resolvedType === 'company'
      ? 'companies.edit'
      : (resolvedType === 'broker' ? 'brokers.edit' : 'traders.edit');

    if (wantsJsonRequest(req)) {
      return res.json({
        success: true,
        created: true,
        editUrl,
        updateActionUrl,
        pageTitle: t(editTitleKey),
        backLabel: t('action.back'),
        message: t('status.created_success'),
        trader: {
          id: insertedId,
          uuid,
          member_type: resolvedType,
          photo_path: photoPath,
          company_role: fields.company_role,
        },
      });
    }

    return res.redirect(`${editUrl}?created=1`);
  } catch (err) {
    if (wantsJsonRequest(req)) {
      return res.status(500).json({ success: false, error: 'Error saving trader: ' + err.message });
    }
    res.status(500).send('Error saving trader: ' + escapeHtml(err.message));
  }
}

app.post('/traders', upload.single('person_pic'), (req, res) => handleCreateMember(req, res));
app.post('/companies', upload.single('person_pic'), (req, res) => handleCreateMember(req, res, 'company'));

// Edit Trader / Broker / Company Page
app.get('/traders/:uuid/edit', async (req, res) => {
  try {
    const trader = await findTraderByIdentifier(req.params.uuid, false);
    if (!trader) {
      return res.status(404).send('Trader not found');
    }
    if (trader.member_type === 'company') {
      return renderCompanyForm(req, res, { isEdit: true, trader });
    }
    const currentPath = trader.member_type === 'broker' ? '/brokers' : '/traders';
    const isDeleted = Boolean(trader.deleted_at && String(trader.deleted_at).trim() !== '');
    const returnUrl = resolveListReturnUrl(req, currentPath, isDeleted);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('traders/edit', {
      currentPath,
      trader,
      returnUrl,
      saved: req.query?.saved === '1',
      created: req.query?.created === '1',
    });
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

  if (wantsJsonRequest(req)) {
    return res.json({
      success: true,
      uuid: trader?.uuid || req.params.uuid,
      member_type: trader?.member_type || 'trader',
    });
  }

  return res.redirect(memberBasePath(trader?.member_type));
}

// Shared Restore Execution (Clears deleted_at + Cache Invalidation + Share Sync + AJAX support)
async function executeRestore(req, res) {
  const trader = await findTraderByIdentifier(req.params.uuid, false);
  if (!trader) {
    if (wantsJsonRequest(req)) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    return res.status(404).send('Record not found');
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const { clause, param } = buildKeyWhereClause(trader.uuid || req.params.uuid);

  await db.prepare(`UPDATE traders SET deleted_at = '', updated_at = ? WHERE ${clause}`).run(now, param);
  invalidateTradersCache();

  const restoredRow = {
    ...trader,
    deleted_at: '',
    updated_at: now,
  };
  await accessSyncNotify(db, trader.uuid || req.params.uuid, trader, restoredRow);

  if (wantsJsonRequest(req)) {
    return res.json({
      success: true,
      uuid: trader.uuid || req.params.uuid,
      member_type: trader.member_type || 'trader',
    });
  }

  if (req.body?.return_to === 'edit') {
    const editBase = trader.member_type === 'company' ? '/companies' : '/traders';
    return res.redirect(`${editBase}/${encodeURIComponent(trader.uuid || req.params.uuid)}/edit`);
  }

  return res.redirect(`${memberBasePath(trader.member_type)}?status=deleted`);
}

// Shared Permanent Delete Execution (Deleted records only: DB delete + photo cleanup + Share sync)
async function executePermanentDelete(req, res) {
  const trader = await findTraderByIdentifier(req.params.uuid, false);
  if (!trader) {
    if (wantsJsonRequest(req)) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    return res.status(404).send('Record not found');
  }

  if (!trader.deleted_at || String(trader.deleted_at).trim() === '') {
    const msg = 'يجب شطب السجل أولاً قبل حذفه نهائياً';
    if (wantsJsonRequest(req)) {
      return res.status(400).json({ success: false, error: msg });
    }
    return res.status(400).send(msg);
  }

  const targetKey = trader.uuid || req.params.uuid;
  const { clause, param } = buildKeyWhereClause(targetKey);

  await db.prepare(`DELETE FROM traders WHERE ${clause}`).run(param);
  invalidateTradersCache();
  qrCache.delete(targetKey);

  await removeUnreferencedUploadFile(trader.photo_path, uploadDir);
  await accessSyncDelete(db, targetKey, trader);

  const redirectUrl = `${memberBasePath(trader.member_type)}?status=deleted`;
  if (wantsJsonRequest(req)) {
    return res.json({
      success: true,
      uuid: targetKey,
      member_type: trader.member_type || 'trader',
      permanent: true,
      redirectUrl,
    });
  }

  return res.redirect(redirectUrl);
}

// Update or Delete Trader / Broker / Company (supports POST with multipart _method=patch/delete as well as PATCH/PUT)
async function handleUpdateOrDeleteTrader(req, res) {
  try {
    if (req.body && String(req.body._method || '').toUpperCase() === 'DELETE') {
      return await executeSoftDelete(req, res);
    }

    const traderBefore = await findTraderByIdentifier(req.params.uuid, false);
    if (!traderBefore) {
      if (wantsJsonRequest(req)) {
        return res.status(404).json({ success: false, error: 'Record not found' });
      }
      return res.status(404).send('Record not found');
    }

    const resolvedType =
      traderBefore.member_type === 'broker'
        ? 'broker'
        : (traderBefore.member_type === 'company' ? 'company' : 'trader');
    const fields = buildNormalizedMemberFields(req.body || {}, resolvedType, traderBefore);

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const shouldRemovePhoto = !req.file && String(req.body?.remove_photo || '').trim() === '1';
    let photoPath = traderBefore.photo_path;

    if (req.file) {
      photoPath = '/uploads/' + req.file.filename;
    } else if (shouldRemovePhoto) {
      photoPath = null;
    }

    await db.prepare(`
      UPDATE traders SET
        name = ?, english_name = ?, commercial_name = ?, activity = ?, english_activity = ?,
        card_no = ?, stamp_no = ?, renewal_no = ?, card_class = ?, gender = ?, company_role = ?, commercial_name_no = ?, speciality = ?,
        phone_number = ?, address = ?, affiliation_date = ?, expire_date = ?, photo_path = ?,
        company_name = ?, english_company_name = ?, ceo_name = ?, english_ceo_name = ?,
        incorporation_certificate_no = ?, incorporation_certificate_symbol = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      fields.name, fields.english_name, fields.commercial_name, fields.activity, fields.english_activity,
      fields.card_no, fields.stamp_no, fields.renewal_no, fields.card_class, fields.gender, fields.company_role, fields.commercial_name_no, fields.speciality,
      fields.phone_number, fields.address, fields.affiliation_date, fields.expire_date, photoPath,
      fields.company_name, fields.english_company_name, fields.ceo_name, fields.english_ceo_name,
      fields.incorporation_certificate_no, fields.incorporation_certificate_symbol,
      now, traderBefore.id
    );

    if (shouldRemovePhoto && traderBefore.photo_path) {
      await removeUnreferencedUploadFile(traderBefore.photo_path, uploadDir);
    }

    invalidateTradersCache();

    const updatedRow = {
      ...traderBefore,
      ...fields,
      photo_path: photoPath,
      updated_at: now,
    };

    const targetUuid = traderBefore.uuid || req.params.uuid;
    await accessSyncNotify(db, targetUuid, traderBefore, updatedRow);

    const editUrl = memberEditPath(resolvedType, targetUuid);
    const t = res.locals.t || createTranslator(req.lang || 'ar');

    if (wantsJsonRequest(req)) {
      return res.json({
        success: true,
        created: false,
        editUrl,
        backLabel: t('action.back'),
        message: t('status.saved_success'),
        trader: {
          id: traderBefore.id,
          uuid: targetUuid,
          member_type: resolvedType,
          photo_path: photoPath,
          company_role: fields.company_role,
        },
      });
    }

    return res.redirect(`${editUrl}?saved=1`);
  } catch (err) {
    if (wantsJsonRequest(req)) {
      return res.status(500).json({ success: false, error: 'Error updating trader: ' + err.message });
    }
    res.status(500).send('Error updating trader: ' + escapeHtml(err.message));
  }
}

app.patch('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.post('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.put('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);

// Restore Soft-Deleted Trader / Broker / Company
app.post(['/traders/:uuid/restore', '/companies/:uuid/restore'], async (req, res) => {
  try {
    await executeRestore(req, res);
  } catch (err) {
    if (wantsJsonRequest(req)) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.status(500).send('Error restoring record: ' + escapeHtml(err.message));
  }
});

// Permanently Delete Soft-Deleted Trader / Broker / Company
async function handlePermanentDeleteRoute(req, res) {
  try {
    await executePermanentDelete(req, res);
  } catch (err) {
    if (wantsJsonRequest(req)) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.status(500).send('Error permanently deleting record: ' + escapeHtml(err.message));
  }
}

app.post(['/traders/:uuid/permanent-delete', '/companies/:uuid/permanent-delete'], handlePermanentDeleteRoute);
app.delete(['/traders/:uuid/permanent-delete', '/companies/:uuid/permanent-delete'], handlePermanentDeleteRoute);

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

    const headers = getCsvHeaders('trader', req.lang);
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

    const { queryString: qs, exportQueryString } = buildListQueryStrings(req.query);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('brokers/index', {
      currentPath: '/brokers',
      brokers,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      exportQueryString,
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

    const headers = getCsvHeaders('broker', req.lang);
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
  const qsIdx = req.originalUrl.indexOf('?');
  const qs = qsIdx !== -1 ? req.originalUrl.slice(qsIdx) : '';
  res.redirect(`/traders/${encodeURIComponent(req.params.uuid)}/edit${qs}`);
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

    const { queryString: qs, exportQueryString } = buildListQueryStrings(req.query);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('companies/index', {
      currentPath: '/companies',
      companies,
      totalCount,
      totalPages,
      currentPage: page,
      limit,
      query: req.query,
      queryString: qs,
      exportQueryString,
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

    const headers = getCsvHeaders('company', req.lang);
    res.write(headers.map((h) => `"${h}"`).join(',') + '\n');

    const { whereSql, params } = buildCompaniesFilter(req.query);
    const rows = await db.prepare(`SELECT * FROM traders WHERE ${whereSql} ORDER BY created_at DESC, id DESC`).all(...params);

    for (const r of rows) {
      const line = [
        r.company_name || r.commercial_name || '', r.english_company_name || '',
        r.ceo_name || r.name || '', r.english_ceo_name || r.english_name || '',
        r.activity || '', r.english_activity || '',
        r.card_no || '', r.renewal_no || '', r.card_class || '',
        normalizeGender(r.gender), normalizeCompanyRole(r.company_role), r.commercial_name_no || '',
        r.incorporation_certificate_no || '', r.incorporation_certificate_symbol || '', r.speciality || '',
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

// Company Edit / Update / Delete Routes
app.get('/companies/:uuid/edit', async (req, res) => {
  try {
    const trader = await findTraderByIdentifier(req.params.uuid, false);
    if (!trader) {
      return res.status(404).send('Company not found');
    }
    if (trader.member_type !== 'company') {
      const qsIdx = req.originalUrl.indexOf('?');
      const qs = qsIdx !== -1 ? req.originalUrl.slice(qsIdx) : '';
      return res.redirect('/traders/' + encodeURIComponent(req.params.uuid) + '/edit' + qs);
    }
    return renderCompanyForm(req, res, { isEdit: true, trader });
  } catch (err) {
    res.status(500).send('Error loading company edit page: ' + escapeHtml(err.message));
  }
});

app.patch('/companies/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.post('/companies/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.put('/companies/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.delete('/companies/:uuid', async (req, res) => {
  try {
    await executeSoftDelete(req, res);
  } catch (err) {
    res.status(500).send('Error deleting company: ' + escapeHtml(err.message));
  }
});

// ==========================================
// API & Validation Endpoints
// ==========================================

const DEFAULT_CARD_TYPOGRAPHY = {
  front: {
    name_size: 38, name_x: 907, name_y: 309,
    class_size: 38, class_x: 898, class_y: 367,
    comm_size: 33, comm_x: 801, comm_y: 429,
    activity_size: 33, activity_x: 896, activity_y: 487,
    card_no_size: 36, card_no_x: 849, card_no_y: 552,
    aff_date_size: 28, aff_date_x: 910, aff_date_y: 614,
    exp_date_size: 28, exp_date_x: 473, exp_date_y: 614
  },
  back: {
    name_size: 36, name_x: 14, name_y: 305,
    class_size: 36, class_x: 118, class_y: 375,
    comm_no_size: 36, comm_no_x: 396, comm_no_y: 432,
    activity_size: 34, activity_x: 163, activity_y: 484,
    card_no_size: 34, card_no_x: 124, card_no_y: 570,
    aff_date_size: 27, aff_date_x: 168, aff_date_y: 630,
    exp_date_size: 27, exp_date_x: 732, exp_date_y: 630,
    qr_x: 758, qr_y: 210, qr_size: 238
  }
};

const DEFAULT_COMPANY_CARD_TYPOGRAPHY = {
  front: {
    comp_size: 38, comp_x: 898, comp_y: 282,
    ceo_size: 36, ceo_x: 850, ceo_y: 332,
    class_act_size: 33, class_act_x: 777, class_act_y: 378,
    cert_size: 31, cert_x: 727, cert_y: 425,
    comm_date_size: 33, comm_date_x: 803, comm_date_y: 474,
    card_no_size: 35, card_no_x: 851, card_no_y: 564,
    aff_date_size: 27, aff_date_x: 896, aff_date_y: 620,
    exp_date_size: 28, exp_date_x: 473, exp_date_y: 620
  },
  back: {
    comp_en_size: 36, comp_en_x: 192, comp_en_y: 322,
    ceo_en_size: 33, ceo_en_x: 105, ceo_en_y: 363,
    class_act_en_size: 33, class_act_en_x: 275, class_act_en_y: 410,
    license_en_size: 33, license_en_x: 214, license_en_y: 459,
    comm_no_size: 33, comm_no_x: 396, comm_no_y: 503,
    card_no_size: 32, card_no_x: 127, card_no_y: 573,
    aff_date_size: 27, aff_date_x: 174, aff_date_y: 627,
    exp_date_size: 27, exp_date_x: 636, exp_date_y: 627,
    qr_x: 753, qr_y: 216, qr_size: 237
  }
};

const DEFAULT_COMPANY_BM_CARD_TYPOGRAPHY = {
  front: {
    comp_size: 38, comp_x: 898, comp_y: 282,
    ceo_size: 36, ceo_x: 842, ceo_y: 332,
    class_act_size: 33, class_act_x: 778, class_act_y: 378,
    cert_size: 31, cert_x: 728, cert_y: 425,
    comm_date_size: 33, comm_date_x: 804, comm_date_y: 474,
    card_no_size: 35, card_no_x: 850, card_no_y: 563,
    aff_date_size: 27, aff_date_x: 896, aff_date_y: 619,
    exp_date_size: 28, exp_date_x: 474, exp_date_y: 619
  },
  back: {
    comp_en_size: 36, comp_en_x: 192, comp_en_y: 322,
    ceo_en_size: 33, ceo_en_x: 88, ceo_en_y: 363,
    class_act_en_size: 33, class_act_en_x: 275, class_act_en_y: 410,
    license_en_size: 33, license_en_x: 214, license_en_y: 459,
    comm_no_size: 33, comm_no_x: 396, comm_no_y: 503,
    card_no_size: 32, card_no_x: 127, card_no_y: 573,
    aff_date_size: 27, aff_date_x: 174, aff_date_y: 627,
    exp_date_size: 27, exp_date_x: 636, exp_date_y: 627,
    qr_x: 753, qr_y: 216, qr_size: 237
  }
};

const DEFAULT_BROKER_CARD_TYPOGRAPHY = {
  front: {
    name_size: 36, name_x: 905, name_y: 309,
    class_size: 36, class_x: 892, class_y: 370,
    comm_size: 32, comm_x: 796, comm_y: 432,
    activity_size: 32, activity_x: 891, activity_y: 493,
    card_no_size: 35, card_no_x: 844, card_no_y: 558,
    aff_date_size: 27, aff_date_x: 890, aff_date_y: 624,
    exp_date_size: 27, exp_date_x: 470, exp_date_y: 624
  },
  back: {
    name_size: 36, name_x: 13, name_y: 301,
    class_size: 34, class_x: 116, class_y: 371,
    comm_no_size: 34, comm_no_x: 394, comm_no_y: 430,
    activity_size: 34, activity_x: 160, activity_y: 479,
    card_no_size: 34, card_no_x: 122, card_no_y: 565,
    aff_date_size: 27, aff_date_x: 168, aff_date_y: 624,
    exp_date_size: 27, exp_date_x: 733, exp_date_y: 624,
    qr_x: 758, qr_y: 207, qr_size: 238
  }
};

function getSettingDefaultsForKey(key) {
  if (key === 'company_card_typography') return DEFAULT_COMPANY_CARD_TYPOGRAPHY;
  if (key === 'company_bm_card_typography') return DEFAULT_COMPANY_BM_CARD_TYPOGRAPHY;
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
      width: 900,
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
    let settings, companySettings, companyBmSettings, brokerSettings, sampleTrader, sampleCompany, sampleBroker;

    const hasCachedSettings =
      settingsCache.get('card_typography')?.expiresAt > now &&
      settingsCache.get('company_card_typography')?.expiresAt > now &&
      settingsCache.get('company_bm_card_typography')?.expiresAt > now &&
      settingsCache.get('broker_card_typography')?.expiresAt > now;

    if (hasCachedSettings && profileSamplesCache && profileSamplesCache.expiresAt > now) {
      settings = settingsCache.get('card_typography').value;
      companySettings = settingsCache.get('company_card_typography').value;
      companyBmSettings = settingsCache.get('company_bm_card_typography').value;
      brokerSettings = settingsCache.get('broker_card_typography').value;
      ({ sampleTrader, sampleCompany, sampleBroker } = profileSamplesCache);
    } else {
      const [sRes, tSampleRes, cSampleRes, bSampleRes] = await db.batch(
        [
          {
            sql: `SELECT key, value FROM settings WHERE key IN ('card_typography', 'company_card_typography', 'company_bm_card_typography', 'broker_card_typography')`,
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
      companyBmSettings = parseOr('company_bm_card_typography', DEFAULT_COMPANY_BM_CARD_TYPOGRAPHY);
      brokerSettings = parseOr('broker_card_typography', DEFAULT_BROKER_CARD_TYPOGRAPHY);

      settingsCache.set('card_typography', { value: settings, expiresAt: now + SETTINGS_TTL_MS });
      settingsCache.set('company_card_typography', { value: companySettings, expiresAt: now + SETTINGS_TTL_MS });
      settingsCache.set('company_bm_card_typography', { value: companyBmSettings, expiresAt: now + SETTINGS_TTL_MS });
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

    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('profile/index', {
      currentPath: '/profile',
      user: { name: 'Site Admin', email: 'admin@k-coc.org' },
      settings,
      companySettings,
      companyBmSettings,
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

// Get Company BM Card Typography Settings API (Cached)
app.get('/api/settings/company-bm-card-typography', async (req, res) => {
  const settings = await getTypographySettingCached('company_bm_card_typography');
  res.json({ success: true, settings });
});

// Save Company BM Card Typography Settings API
app.post('/api/settings/company-bm-card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_bm_card_typography', ?)").run(JSON.stringify(newSettings));
    settingsCache.set('company_bm_card_typography', { value: newSettings, expiresAt: Date.now() + SETTINGS_TTL_MS });
    res.json({ success: true, message: 'Company BM settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Company BM Card Typography Settings API
app.post('/api/settings/company-bm-card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_bm_card_typography', ?)").run(JSON.stringify(DEFAULT_COMPANY_BM_CARD_TYPOGRAPHY));
    invalidateSettingsCache('company_bm_card_typography');
    res.json({ success: true, settings: DEFAULT_COMPANY_BM_CARD_TYPOGRAPHY, message: 'Company BM settings reset to defaults' });
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

/**
 * Build trader + typography + QR payload shared between the JSON bundle API and standalone print page.
 * @param {import('express').Request} req
 * @param {object} trader
 */
async function buildCardBundlePayload(req, trader) {
  if (trader.member_type === 'company') {
    trader.company_role = normalizeCompanyRole(trader.company_role);
    const [ceoTypo, bmTypo, qrData] = await Promise.all([
      getTypographySettingCached('company_card_typography'),
      getTypographySettingCached('company_bm_card_typography'),
      getQrBundleForUuid(req, trader.uuid),
    ]);
    const globalTypography = trader.company_role === 'bm' ? bmTypo : ceoTypo;

    return {
      success: true,
      trader,
      globalTypography,
      companyTypographyByRole: { ceo: ceoTypo, bm: bmTypo },
      qr_url: qrData.qr_url,
      validate_url: qrData.validate_url,
    };
  }

  const settingKey =
    trader.member_type === 'broker'
      ? 'broker_card_typography'
      : 'card_typography';

  const [globalTypography, qrData] = await Promise.all([
    getTypographySettingCached(settingKey),
    getQrBundleForUuid(req, trader.uuid),
  ]);

  return {
    success: true,
    trader,
    globalTypography,
    qr_url: qrData.qr_url,
    validate_url: qrData.validate_url,
  };
}

// Single Trader JSON API (Supports ?bundle=1 to return trader + globalTypography + QR in ONE single fast request!)
app.get('/api/traders/:id', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-cache');
    const trader = await findTraderByIdentifier(req.params.id, true);
    if (!trader) return res.status(404).json({ success: false, error: 'Not found' });

    if (trader.member_type === 'company') {
      trader.company_role = normalizeCompanyRole(trader.company_role);
    }

    if (req.query.bundle === '1') {
      const bundle = await buildCardBundlePayload(req, trader);
      return res.json(bundle);
    }

    res.json({ success: true, trader });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Standalone CR80 Dual-Sided Print Window (0deg both sides, no forced @page size to match original site)
async function renderStandaloneCardPrint(req, res) {
  try {
    const trader = await findTraderByIdentifier(req.params.id, true);
    if (!trader) {
      return res.status(404).send('Card not found');
    }

    const bundle = await buildCardBundlePayload(req, trader);
    const reqRole = String(req.query.role || '').trim().toLowerCase();
    if (bundle.trader.member_type === 'company' && (reqRole === 'bm' || reqRole === 'ceo')) {
      bundle.trader.company_role = reqRole;
      if (bundle.companyTypographyByRole && bundle.companyTypographyByRole[reqRole]) {
        bundle.globalTypography = bundle.companyTypographyByRole[reqRole];
      }
    }

    const displayName =
      bundle.trader.member_type === 'company'
        ? (bundle.trader.company_name || bundle.trader.commercial_name || bundle.trader.name || '')
        : (bundle.trader.commercial_name || bundle.trader.name || '');

    res.setHeader('Cache-Control', 'private, no-cache');
    res.render('cards/print', {
      displayName,
      printPayloadJson: JSON.stringify(bundle).replace(/</g, '\\u003c'),
      assetVersion: APP_ASSET_REV,
    });
  } catch (err) {
    res.status(500).send('Error preparing card print page: ' + escapeHtml(err.message));
  }
}

app.get(
  ['/cards/:id/print', '/traders/:id/print', '/brokers/:id/print', '/companies/:id/print'],
  renderStandaloneCardPrint
);

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
    const isBm = isComp && normalizeCompanyRole(trader.company_role) === 'bm';
    const isBroker = trader.member_type === 'broker';
    const arTitleLabel = isComp ? 'الشركة' : (isBroker ? 'الدلال' : 'التاجر');
    const arDisplayName = isComp ? (trader.company_name || trader.commercial_name || trader.name) : trader.name;
    const enDisplayName = isComp ? (trader.english_company_name || trader.english_name || trader.company_name) : trader.english_name;

    const formatArDateForRtl = (d) => {
      const s = String(d || '').trim();
      const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || '-');
    };

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
                ${isComp && (trader.ceo_name || trader.name) ? `<p class="ArText">${isBm ? 'مدير الفرع' : 'المدير المفوض'}: ${escapeHtml(trader.ceo_name || trader.name)}</p>` : ''}
                <p id="ArClass" class="ArText">الصنف: ${escapeHtml(isBroker ? 'دلالية' : formatClassName(trader.card_class, 'ar'))}</p>
                <p id="ArCommercialName" class="ArText">الاسم التجاري: ${escapeHtml(trader.commercial_name || '-')} / <span id="ArCommercialNameNo">${escapeHtml(trader.commercial_name_no || '')}</span></p>
                <p id="ArActivity" class="ArText">النشاط: ${escapeHtml(trader.activity || '-')}</p>
                <p id="CardNo" class="ArText font-bold text-blue-700">رقم الهوية: ${escapeHtml(trader.card_no || '')} ${trader.renewal_no ? '/ ' + escapeHtml(trader.renewal_no) : ''}</p>
                <p id="ArAffiliationDate" class="ArText">الانتماء: ${escapeHtml(formatArDateForRtl(trader.affiliation_date))}</p>
                <p id="ArExpireDate" class="ArText ${isExpired ? 'text-red-600' : 'text-green-700'}">النفاذ: ${escapeHtml(formatArDateForRtl(trader.expire_date))}</p>
            </div>
            <div id="background">
                <p id="EnName" class="EnText font-bold">${escapeHtml(enDisplayName || '-')}</p>
                ${isComp ? `<p id="EnManager" class="EnText">${isBm ? 'BM' : 'CEO'}: ${escapeHtml(trader.english_ceo_name || trader.english_name || trader.ceo_name || trader.name || '-')}</p>` : ''}
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
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'حجم الصورة يتجاوز الحد الأقصى المسموح به (5 ميجابايت).'
      : 'Upload error: ' + err.message;
    if (wantsJsonRequest(req)) {
      return res.status(400).json({ success: false, error: msg });
    }
    return res.status(400).send(escapeHtml(msg));
  }
  if (err) {
    const msg = err.message || 'Unexpected error';
    if (wantsJsonRequest(req)) {
      return res.status(400).json({ success: false, error: msg });
    }
    return res.status(400).send(escapeHtml(msg));
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

async function warmStartupCaches() {
  try {
    await dbReady;
    const traderFilter = buildTradersFilter({});
    const brokerFilter = buildBrokersFilter({});
    const companyFilter = buildCompaniesFilter({});
    await Promise.all([
      getDashboardStats(),
      runCachedPaginatedQuery(LIST_SELECT_COLS, traderFilter.whereSql, traderFilter.params, 15, 0),
      runCachedPaginatedQuery(LIST_SELECT_COLS, brokerFilter.whereSql, brokerFilter.params, 15, 0),
      runCachedPaginatedQuery(LIST_SELECT_COLS, companyFilter.whereSql, companyFilter.params, 15, 0),
    ]);
  } catch (_) {}
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
  warmStartupCaches();
});

export default app;
