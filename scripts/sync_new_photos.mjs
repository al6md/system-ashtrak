import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { ensureIsolatedFolder, getAccessToken, uploadPhotoToIsolatedDrive } from '../gdrivePhotos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'public', 'uploads');
const LOCAL_DB_PATH = path.join(ROOT_DIR, 'data', 'cardval.db');
const ACCESS_LEDGER_PATH = path.join(ROOT_DIR, 'data', 'access_sync_live.json');

const BASE_URL = (process.env.CARDVAL_BASE_URL || 'https://membership.k-coc.org').replace(/\/+$/, '');

const SECTIONS = {
  trader: {
    key: 'trader',
    label: 'التجار',
    listPath: '/traders',
    editRegex: /\/traders\/([a-f0-9-]{36})/gi,
    prefix: 'trader',
  },
  broker: {
    key: 'broker',
    label: 'الدلالين',
    listPath: '/brokers',
    editRegex: /\/brokers\/([a-f0-9-]{36})/gi,
    prefix: 'broker',
  },
  company: {
    key: 'company',
    label: 'الشركات',
    listPath: '/companies',
    editRegex: /\/companies\/([a-f0-9-]{36})/gi,
    prefix: 'company',
  },
};

function loadDotEnvCredentials() {
  const creds = {
    email: process.env.CARDVAL_EMAIL || '',
    password: process.env.CARDVAL_PASSWORD || '',
  };
  for (const envFile of ['.env', '.env.cardval']) {
    const p = path.join(ROOT_DIR, envFile);
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (k === 'CARDVAL_EMAIL' && !creds.email) creds.email = v;
        if (k === 'CARDVAL_PASSWORD' && !creds.password) creds.password = v;
      }
    } catch (_) {}
  }
  if (!creds.email || !creds.password) {
    throw new Error('بيانات الدخول غير مضبوطة. يرجى تعريف CARDVAL_EMAIL و CARDVAL_PASSWORD في .env أو .env.cardval');
  }
  return creds;
}

class HttpSession {
  constructor() {
    this.cookies = new Map();
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }

  storeSetCookies(headers) {
    const rawList = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const raw of rawList) {
      if (!raw) continue;
      const firstPart = raw.split(';')[0];
      const eq = firstPart.indexOf('=');
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const val = firstPart.slice(eq + 1).trim();
      if (val === '' || raw.toLowerCase().includes('max-age=0')) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, val);
      }
    }
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(url, options = {}, maxRedirects = 6) {
    let currentUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
    let currentMethod = options.method || 'GET';
    let currentBody = options.body;
    let currentHeaders = { ...(options.headers || {}) };

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const headers = {
        'User-Agent': this.userAgent,
        ...currentHeaders,
      };
      const cookieStr = this.cookieHeader();
      if (cookieStr) headers.Cookie = cookieStr;

      const res = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
      this.storeSetCookies(res.headers);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return res;
        currentUrl = new URL(loc, currentUrl).toString();
        if (res.status === 303 || (res.status === 302 && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
          delete currentHeaders['Content-Type'];
        }
        continue;
      }
      return res;
    }
    throw new Error(`Too many redirects fetching ${url}`);
  }
}

function hasBotGate(html) {
  const lower = String(html || '').toLowerCase();
  return (
    lower.includes('cf-turnstile') ||
    lower.includes('g-recaptcha') ||
    lower.includes('hcaptcha') ||
    lower.includes('challenge-platform')
  );
}

async function loginToCardval(session, email, password) {
  const loginUrl = `${BASE_URL}/login`;
  const getRes = await session.request(loginUrl);
  const loginHtml = await getRes.text();
  if (hasBotGate(loginHtml)) {
    throw new Error('الموقع الأصلي يطلب تحقق أمني/CAPTCHA عند صفحة الدخول — لا يمكن المتابعة تلقائياً.');
  }

  const tokenMatch =
    loginHtml.match(/name="_token"[^>]*value="([^"]+)"/i) ||
    loginHtml.match(/value="([^"]+)"[^>]*name="_token"/i) ||
    loginHtml.match(/meta name="csrf-token" content="([^"]+)"/i);

  if (!tokenMatch) {
    throw new Error(`تعذر استخراج CSRF token من ${loginUrl} (HTTP ${getRes.status}).`);
  }

  const form = new URLSearchParams({
    _token: tokenMatch[1],
    email,
    password,
    remember: 'on',
  });

  const postRes = await session.request(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: loginUrl,
      Origin: BASE_URL,
    },
    body: form.toString(),
  });

  const postHtml = await postRes.text();
  if (hasBotGate(postHtml)) {
    throw new Error('الموقع الأصلي عرض تحدي CAPTCHA بعد محاولة الدخول — يرجى التحقق يدوياً.');
  }
  if (postRes.url.toLowerCase().includes('/login') || postHtml.includes('name="password"')) {
    throw new Error('فشل تسجيل الدخول إلى Cardval. تحقق من البريد وكلمة المرور.');
  }
  return postRes;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extractInputValue(html, fieldName) {
  const r1 = new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, 'i');
  const r2 = new RegExp(`value="([^"]*)"[^>]*name="${fieldName}"`, 'i');
  const m = html.match(r1) || html.match(r2);
  return m ? decodeHtmlEntities(m[1]) : '';
}

function extractStorageImageUrl(html) {
  const escapedBase = BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absRegex = new RegExp(`${escapedBase}/storage/(?:traders|companies|brokers)/[a-zA-Z0-9_\\-\\.]+\\.(?:jpg|jpeg|png|webp)`, 'gi');
  const absMatches = html.match(absRegex);
  if (absMatches && absMatches.length > 0) return absMatches[0];

  const relRegex = /["'](\/storage\/(?:traders|companies|brokers)\/[a-zA-Z0-9_\-\.]+\.(?:jpg|jpeg|png|webp))["']/gi;
  const relMatch = relRegex.exec(html);
  if (relMatch) return `${BASE_URL}${relMatch[1]}`;
  return null;
}

function norm(val) {
  return String(val ?? '').trim().replace(/\s+/g, ' ');
}

function normNum(val) {
  const v = norm(val);
  return v === '0' ? '' : v;
}

function sanitizePart(val) {
  return String(val || '').replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 40);
}

function buildSectionIndex(rows, memberType, uploadedSet) {
  const byUuid = new Map();
  const byCardName = new Map();
  const byCommNoName = new Map();
  const byCertName = new Map();
  const byCardUnique = new Map();
  const cardCounts = new Map();
  const byNameUnique = new Map();
  const nameCounts = new Map();

  for (const r of rows) {
    if (r.uuid) byUuid.set(r.uuid, r);
    const nm = memberType === 'company' ? norm(r.company_name || r.commercial_name || r.name) : norm(r.name);
    const ceo = norm(r.ceo_name);
    const card = normNum(r.card_no);
    const commNo = normNum(r.commercial_name_no);
    const cert = normNum(r.incorporation_certificate_no);

    if (card && nm) byCardName.set(`${card}|||${nm}`, r);
    if (card && ceo && memberType === 'company') byCardName.set(`${card}|||${ceo}`, r);
    if (commNo && nm) byCommNoName.set(`${commNo}|||${nm}`, r);
    if (cert && nm && memberType === 'company') byCertName.set(`${cert}|||${nm}`, r);

    if (card) {
      cardCounts.set(card, (cardCounts.get(card) || 0) + 1);
      byCardUnique.set(card, r);
    }
    if (nm) {
      nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1);
      byNameUnique.set(nm, r);
    }
  }

  for (const [k, count] of cardCounts) {
    if (count > 1) byCardUnique.delete(k);
  }
  for (const [k, count] of nameCounts) {
    if (count > 1) byNameUnique.delete(k);
  }

  const hasValidPhoto = (row) => {
    if (!row || !row.photo_path) return false;
    if (row.photo_path === '__DRY_RUN__') return true;
    const fn = path.basename(row.photo_path.trim());
    const onDisk = fs.existsSync(path.join(UPLOADS_DIR, fn)) && fs.statSync(path.join(UPLOADS_DIR, fn)).size > 200;
    const onDrive = uploadedSet.has(fn);
    return onDisk || onDrive;
  };

  const matchRemote = (remote) => {
    if (remote.uuid && byUuid.has(remote.uuid)) return byUuid.get(remote.uuid);
    const nm = norm(remote.company_name || remote.name);
    const ceo = norm(remote.ceo_name);
    const card = normNum(remote.card_no);
    const commNo = normNum(remote.commercial_name_no);
    const cert = normNum(remote.incorporation_certificate_no);

    if (card && nm && byCardName.has(`${card}|||${nm}`)) return byCardName.get(`${card}|||${nm}`);
    if (card && ceo && byCardName.has(`${card}|||${ceo}`)) return byCardName.get(`${card}|||${ceo}`);
    if (commNo && nm && byCommNoName.has(`${commNo}|||${nm}`)) return byCommNoName.get(`${commNo}|||${nm}`);
    if (cert && nm && byCertName.has(`${cert}|||${nm}`)) return byCertName.get(`${cert}|||${nm}`);
    if (card && byCardUnique.has(card)) return byCardUnique.get(card);
    if (nm && byNameUnique.has(nm)) return byNameUnique.get(nm);
    return null;
  };

  return { byUuid, hasValidPhoto, matchRemote };
}

async function fetchRemoteEditDetails(session, sectionCfg, uuid) {
  const editUrl = `${BASE_URL}${sectionCfg.listPath}/${uuid}/edit`;
  const res = await session.request(editUrl);
  if (res.status !== 200) return null;
  const html = await res.text();
  if (hasBotGate(html)) throw new Error('تم إيقاف الجلسة بسبب تحقق CAPTCHA.');

  const imgUrl = extractStorageImageUrl(html);
  return {
    uuid,
    imgUrl,
    card_no: extractInputValue(html, 'card_no'),
    name: extractInputValue(html, 'name'),
    company_name: extractInputValue(html, 'company_name'),
    ceo_name: extractInputValue(html, 'ceo_name'),
    commercial_name: extractInputValue(html, 'commercial_name'),
    commercial_name_no: extractInputValue(html, 'commercial_name_no'),
    incorporation_certificate_no: extractInputValue(html, 'incorporation_certificate_no'),
    stamp_no: extractInputValue(html, 'stamp_no'),
  };
}

function migrateLiveAccessLedgerUuid(oldUuid, newUuid) {
  if (!oldUuid || !newUuid || oldUuid === newUuid || !fs.existsSync(ACCESS_LEDGER_PATH)) return;
  try {
    const ledger = JSON.parse(fs.readFileSync(ACCESS_LEDGER_PATH, 'utf-8'));
    if (ledger[oldUuid] && !ledger[newUuid]) {
      ledger[newUuid] = ledger[oldUuid];
      delete ledger[oldUuid];
      fs.writeFileSync(ACCESS_LEDGER_PATH, JSON.stringify(ledger, null, 1), 'utf-8');
    }
  } catch (_) {}
}

async function downloadAndSavePhoto({
  session,
  remote,
  matchedRow,
  sectionCfg,
  driveEnabled,
  dryRun,
  usedUuids,
  uploadedSet,
  localDb,
}) {
  const label = matchedRow.company_name || matchedRow.name || remote.company_name || remote.name || matchedRow.card_no;
  if (dryRun) {
    matchedRow.photo_path = '__DRY_RUN__';
    console.log(`    [معاينة] سيتم سحب صورة (${sectionCfg.key}): ${label} <- ${remote.imgUrl}`);
    return true;
  }

  const imgRes = await session.request(remote.imgUrl);
  if (imgRes.status !== 200) {
    console.warn(`    ⚠️ تعذر تحميل صورة ${label} (HTTP ${imgRes.status})`);
    return false;
  }
  const ctype = (imgRes.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.length < 200 || ctype.includes('text/html')) {
    console.warn(`    ⚠️ الملف المحمّل غير صالح كصورة لـ ${label}`);
    return false;
  }

  const cPrefix = sanitizePart(normNum(remote.card_no || matchedRow.card_no) || normNum(remote.commercial_name_no || matchedRow.commercial_name_no) || remote.uuid.slice(0, 8));
  const remoteBase = path.basename(new URL(remote.imgUrl).pathname);
  const filename = `${sectionCfg.prefix}_${cPrefix}_${remoteBase}`;
  const localPath = path.join(UPLOADS_DIR, filename);
  const dbPhotoPath = `/uploads/${filename}`;
  const mimeType = filename.toLowerCase().endsWith('.png') ? 'image/png' : (ctype.includes('webp') ? 'image/webp' : 'image/jpeg');

  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  await fsp.writeFile(localPath, buf);

  if (driveEnabled) {
    try {
      const driveRes = await uploadPhotoToIsolatedDrive(buf, filename, mimeType, db, matchedRow);
      if (driveRes?.id) {
        await db.prepare(`
          INSERT OR REPLACE INTO uploaded_photos (filename, mime_type, data_base64, drive_file_id, created_at)
          VALUES (?, ?, NULL, ?, ?)
        `).run(filename, mimeType, driveRes.id, new Date().toISOString());
        uploadedSet.add(filename);
      }
    } catch (err) {
      console.warn(`    ⚠️ حُفظت الصورة محلياً لكن تعذر رفعها لـ Google Drive (${filename}): ${err.message}`);
    }
  }

  const prevUuid = matchedRow.uuid;
  const canAdoptUuid = remote.uuid && remote.uuid !== prevUuid && !usedUuids.has(remote.uuid);
  if (canAdoptUuid) {
    await db.prepare('UPDATE traders SET photo_path = ?, uuid = ? WHERE id = ?').run(dbPhotoPath, remote.uuid, matchedRow.id);
    migrateLiveAccessLedgerUuid(prevUuid, remote.uuid);
    usedUuids.add(remote.uuid);
    matchedRow.uuid = remote.uuid;
  } else {
    await db.prepare('UPDATE traders SET photo_path = ? WHERE id = ?').run(dbPhotoPath, matchedRow.id);
  }
  matchedRow.photo_path = dbPhotoPath;

  if (localDb) {
    try {
      const localTarget = (prevUuid ? localDb.prepare('SELECT id FROM traders WHERE uuid = ?').get(prevUuid) : null)
        || localDb.prepare('SELECT id FROM traders WHERE uuid = ?').get(matchedRow.uuid)
        || (matchedRow.created_at ? localDb.prepare('SELECT id FROM traders WHERE member_type = ? AND created_at = ? AND (name = ? OR company_name = ?) LIMIT 1').get(sectionCfg.key, matchedRow.created_at, matchedRow.name || '', matchedRow.company_name || '') : null);
      if (localTarget) {
        if (canAdoptUuid) {
          localDb.prepare('UPDATE traders SET photo_path = ?, uuid = ? WHERE id = ?').run(dbPhotoPath, remote.uuid, localTarget.id);
        } else {
          localDb.prepare('UPDATE traders SET photo_path = ? WHERE id = ?').run(dbPhotoPath, localTarget.id);
        }
      }
    } catch (_) {}
  }

  console.log(`    📸 تم سحب وحفظ صورة (${sectionCfg.key}): ${label} -> ${filename}`);
  return true;
}

async function runPool(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function extractUuidsInOrder(html, regex) {
  const seen = new Set();
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function getArgValue(args, flag, defaultVal = null) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const driveEnabled = !args.includes('--no-drive');
  const forceAllMissingSince = getArgValue(args, '--since', '2026-10-01');
  const maxPages = Number(getArgValue(args, '--max-pages', '12'));
  const stopPages = Number(getArgValue(args, '--stop-pages', '2'));
  const concurrency = Number(getArgValue(args, '--concurrency', '4'));
  const onlyArg = getArgValue(args, '--only', 'trader,broker,company');
  const selectedTypes = onlyArg
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/s$/, ''))
    .map((s) => (s === 'companie' ? 'company' : s))
    .filter((s) => SECTIONS[s]);

  const creds = loadDotEnvCredentials();
  console.log(`=================================================================`);
  console.log(`🚀 سحب الصور الجديدة فقط من الموقع الأصلي (${BASE_URL})`);
  console.log(`   الأقسام: ${selectedTypes.join(', ')} | حد الصفحات: ${maxPages} | أقدم تاريخ بحث مباشر: ${forceAllMissingSince}`);
  if (dryRun) console.log(`   [وضع المعاينة --dry-run لن يتم تعديل الملفات أو قاعدة البيانات]`);
  console.log(`=================================================================`);

  const [allRows, uploadedRows] = await Promise.all([
    db.all("SELECT * FROM traders WHERE deleted_at IS NULL OR deleted_at = ''"),
    db.all('SELECT filename FROM uploaded_photos WHERE drive_file_id IS NOT NULL'),
  ]);
  const usedUuids = new Set(allRows.map((r) => r.uuid).filter(Boolean));
  const uploadedSet = new Set(uploadedRows.map((r) => r.filename).filter(Boolean));

  const indicesByType = {};
  for (const typeKey of selectedTypes) {
    const rows = allRows.filter((r) => (r.member_type || 'trader') === typeKey);
    indicesByType[typeKey] = {
      rows,
      ...buildSectionIndex(rows, typeKey, uploadedSet),
    };
  }

  let effectiveDriveEnabled = driveEnabled && !dryRun;
  if (effectiveDriveEnabled) {
    try {
      await ensureIsolatedFolder(db);
      await getAccessToken(db);
      console.log('✓ الاتصال بمجلد Google Drive المعزول جاهز.');
    } catch (err) {
      console.warn(`⚠️ تعذر تجهيز Google Drive (${err.message}). سيتم الحفظ محلياً فقط.`);
      effectiveDriveEnabled = false;
    }
  }

  const session = new HttpSession();
  console.log('🔐 جاري تسجيل الدخول إلى الموقع الأصلي...');
  await loginToCardval(session, creds.email, creds.password);
  console.log('✓ تم تسجيل الدخول بنجاح.\n');

  const localDb = !dryRun && fs.existsSync(LOCAL_DB_PATH) ? new DatabaseSync(LOCAL_DB_PATH) : null;
  let totalSaved = 0;

  try {
    for (const typeKey of selectedTypes) {
      const cfg = SECTIONS[typeKey];
      const idxData = indicesByType[typeKey];
      console.log(`\n📂 قسم ${cfg.label} (${cfg.listPath}):`);

      let consecutiveCleanPages = 0;
      let sectionSaved = 0;

      // 1. Scan newest pages first; stop early once consecutive pages have no new/missing photos
      for (let page = 1; page <= maxPages; page++) {
        const pageRes = await session.request(`${BASE_URL}${cfg.listPath}?page=${page}`);
        if (pageRes.status !== 200) {
          console.warn(`  ⚠️ فشل جلب الصفحة ${page} (HTTP ${pageRes.status})`);
          break;
        }
        const html = await pageRes.text();
        if (hasBotGate(html)) throw new Error('توقف السحب لظهور تحقق أمني CAPTCHA.');
        const uuids = extractUuidsInOrder(html, cfg.editRegex);
        if (uuids.length === 0) break;

        // Only inspect /edit pages when UUID is unknown OR matched DB row lacks a valid photo
        const needCheck = uuids.filter((u) => {
          const known = idxData.byUuid.get(u);
          return !known || !idxData.hasValidPhoto(known);
        });

        console.log(`  📄 صفحة [${page}]: ${uuids.length} سجل (${needCheck.length} بحاجة لفحص الصورة)`);

        let savedOnPage = 0;
        if (needCheck.length > 0) {
          await runPool(needCheck, concurrency, async (uuid) => {
            const remote = await fetchRemoteEditDetails(session, cfg, uuid);
            if (!remote || !remote.imgUrl) return;
            const matchedRow = idxData.matchRemote(remote);
            if (!matchedRow) return;
            if (idxData.hasValidPhoto(matchedRow)) return;
            const ok = await downloadAndSavePhoto({
              session,
              remote,
              matchedRow,
              sectionCfg: cfg,
              driveEnabled: effectiveDriveEnabled,
              dryRun,
              usedUuids,
              uploadedSet,
              localDb,
            });
            if (ok) {
              savedOnPage++;
              sectionSaved++;
              totalSaved++;
            }
          });
        }

        if (savedOnPage === 0 && needCheck.length === 0) {
          consecutiveCleanPages++;
          if (consecutiveCleanPages >= stopPages) {
            console.log(`  ⏭️ توقف مبكر: ${stopPages} صفحات متتالية صورها مكتملة مسبقاً.`);
            break;
          }
        } else {
          consecutiveCleanPages = 0;
        }
      }

      // 2. Targeted direct search fallback for any recent rows still missing photo_path
      const recentMissing = idxData.rows.filter(
        (r) => !idxData.hasValidPhoto(r) && ((r.created_at || '') >= forceAllMissingSince || (r.updated_at || '') >= forceAllMissingSince)
      );
      if (recentMissing.length > 0) {
        console.log(`  🔎 بحث مباشر عن ${recentMissing.length} سجل حديث لا يزال بدون صورة...`);
        await runPool(recentMissing, concurrency, async (row) => {
          const searchParam = normNum(row.card_no)
            ? `card_no=${encodeURIComponent(row.card_no.trim())}`
            : `name=${encodeURIComponent((row.company_name || row.name || '').trim())}`;
          if (!searchParam || searchParam.endsWith('=')) return;

          const sRes = await session.request(`${BASE_URL}${cfg.listPath}?${searchParam}`);
          if (sRes.status !== 200) return;
          const sHtml = await sRes.text();
          const foundUuids = extractUuidsInOrder(sHtml, cfg.editRegex);
          for (const uuid of foundUuids.slice(0, 4)) {
            const remote = await fetchRemoteEditDetails(session, cfg, uuid);
            if (!remote || !remote.imgUrl) continue;
            const matchedRow = idxData.matchRemote(remote);
            if (!matchedRow || matchedRow.id !== row.id) continue;
            const ok = await downloadAndSavePhoto({
              session,
              remote,
              matchedRow,
              sectionCfg: cfg,
              driveEnabled: effectiveDriveEnabled,
              dryRun,
              usedUuids,
              uploadedSet,
              localDb,
            });
            if (ok) {
              sectionSaved++;
              totalSaved++;
            }
            break;
          }
        });
      }

      console.log(`  ✅ انتهى قسم ${cfg.label}: تم سحب ${sectionSaved} صورة جديدة.`);
    }
  } finally {
    if (localDb) localDb.close();
  }

  console.log(`\n=================================================================`);
  console.log(`🎉 اكتمل سحب الصور الجديدة! إجمالي الصور الجديدة المضافة: ${totalSaved}`);
  console.log(`=================================================================`);
}

main().catch((err) => {
  console.error('\n❌ خطأ أثناء سحب الصور:', err.message);
  process.exit(1);
});
