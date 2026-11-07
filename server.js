import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import multer from 'multer';
import { notifyAdded as accessSyncAdd, notifySaved as accessSyncNotify, notifyDeleted as accessSyncDelete } from './accessHubSync.js';
import { uploadPhotoToIsolatedDrive, downloadPhotoFromIsolatedDrive } from './gdrivePhotos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Uploads Directory (supports Vercel serverless /tmp and local)
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const uploadDir = isServerless ? path.join(os.tmpdir(), 'uploads') : path.join(__dirname, 'public', 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (_) {}

// Helper: Upload photo exclusively to isolated Google Drive folder (outside ShareExchange) and save Drive File ID
async function saveUploadedPhotoToCloud(file, traderInfo = null) {
  if (!file || !file.path) return;
  try {
    const buf = fs.readFileSync(file.path);
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

    if (fs.existsSync(primaryPath)) {
      return res.sendFile(primaryPath);
    }
    if (fs.existsSync(fallbackPath)) {
      return res.sendFile(fallbackPath);
    }

    // Fetch photo from isolated Google Drive folder (via mapped drive_file_id or filename search)
    try {
      const photoRow = await db.prepare("SELECT mime_type, drive_file_id FROM uploaded_photos WHERE filename = ?").get(filename);
      const dRes = await downloadPhotoFromIsolatedDrive(photoRow?.drive_file_id || null, filename, db);
      if (dRes && dRes.buffer && dRes.buffer.length > 50) {
        const ext = path.extname(filename).toLowerCase();
        const mimeType = photoRow?.mime_type || (ext === '.png' ? 'image/png' : 'image/jpeg');
        if (!photoRow?.drive_file_id && dRes.driveFileId) {
          await db.prepare(`
            INSERT OR REPLACE INTO uploaded_photos (filename, mime_type, data_base64, drive_file_id, created_at)
            VALUES (?, ?, NULL, ?, ?)
          `).run(filename, mimeType, dRes.driveFileId, new Date().toISOString());
        }
        try {
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          fs.writeFileSync(primaryPath, dRes.buffer);
        } catch (_) {}
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(dRes.buffer);
      }
    } catch (_) {}

    return res.redirect('/templates/avatar_placeholder.png');
  } catch (err) {
    return res.redirect('/templates/avatar_placeholder.png');
  }
});

// Method override middleware for Laravel _method compatibility
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && '_method' in req.body) {
    req.method = req.body._method.toUpperCase();
  }
  next();
});

// Database setup (Turso Cloud Database with persistent multi-user support)
// db is imported from ./db.js

// File uploads configuration for person_pic
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
    } catch (_) {}
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, 'trader_' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage });

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

// ==========================================
// Cardval Original Web Routes
// ==========================================

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/traders');
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  const totalTraders = (await db.prepare("SELECT COUNT(*) as count FROM traders WHERE member_type = 'trader'").get())?.count || 0;
  const totalBrokers = (await db.prepare("SELECT COUNT(*) as count FROM traders WHERE member_type = 'broker'").get())?.count || 0;
  const totalCompanies = (await db.prepare("SELECT COUNT(*) as count FROM traders WHERE member_type = 'company'").get())?.count || 0;
  const today = new Date().toISOString().split('T')[0];
  const activeMembers = (await db.prepare("SELECT COUNT(*) as count FROM traders WHERE expire_date >= ?").get(today))?.count || 0;
  const withPhotos = (await db.prepare("SELECT COUNT(*) as count FROM traders WHERE photo_path IS NOT NULL AND photo_path != ''").get())?.count || 0;

  res.render('dashboard', {
    currentPath: '/dashboard',
    stats: {
      totalTraders,
      totalBrokers,
      totalCompanies,
      activeMembers,
      withPhotos
    }
  });
});

// Traders Feed List (Exact original layout)
app.get('/traders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const {
      search, name, english_name, commercial_name, activity,
      card_no, renewal_no, commercial_name_no, speciality,
      card_class, affiliation_date_from, affiliation_date_to,
      expire_date_from, expire_date_to, status
    } = req.query;

    const isAdvancedSearch = Boolean(
      name || english_name || commercial_name || activity ||
      card_no || renewal_no || commercial_name_no || speciality ||
      card_class || affiliation_date_from || affiliation_date_to ||
      expire_date_from || expire_date_to || (status && status !== 'active')
    );

    let where = ["member_type = 'trader'"];
    let params = [];

    // Quick search
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where.push("(name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ?)");
      params.push(term, term, term, term);
    }

    // Advanced search fields
    if (name && name.trim()) {
      where.push("name LIKE ?");
      params.push(`%${name.trim()}%`);
    }
    if (english_name && english_name.trim()) {
      where.push("english_name LIKE ?");
      params.push(`%${english_name.trim()}%`);
    }
    if (commercial_name && commercial_name.trim()) {
      where.push("commercial_name LIKE ?");
      params.push(`%${commercial_name.trim()}%`);
    }
    if (activity && activity.trim()) {
      where.push("activity LIKE ?");
      params.push(`%${activity.trim()}%`);
    }
    if (card_no && card_no.trim()) {
      where.push("card_no = ?");
      params.push(card_no.trim());
    }
    if (renewal_no && renewal_no.trim()) {
      where.push("renewal_no = ?");
      params.push(renewal_no.trim());
    }
    if (commercial_name_no && commercial_name_no.trim()) {
      where.push("commercial_name_no = ?");
      params.push(commercial_name_no.trim());
    }
    if (speciality && speciality.trim()) {
      where.push("speciality LIKE ?");
      params.push(`%${speciality.trim()}%`);
    }
    if (card_class && card_class !== '') {
      where.push("card_class = ?");
      params.push(card_class);
    }
    if (affiliation_date_from) {
      where.push("affiliation_date >= ?");
      params.push(affiliation_date_from);
    }
    if (affiliation_date_to) {
      where.push("affiliation_date <= ?");
      params.push(affiliation_date_to);
    }
    if (expire_date_from) {
      where.push("expire_date >= ?");
      params.push(expire_date_from);
    }
    if (expire_date_to) {
      where.push("expire_date <= ?");
      params.push(expire_date_to);
    }

    // Status filter
    if (status === 'deleted') {
      where.push("deleted_at IS NOT NULL AND deleted_at != ''");
    } else if (status === 'all') {
      // no filter on deleted_at
    } else {
      // Default: active / not deleted
      where.push("(deleted_at IS NULL OR deleted_at = '')");
    }

    const whereSql = where.join(' AND ');

    const countRow = (await db.prepare(`SELECT COUNT(*) as count FROM traders WHERE ${whereSql}`).get(...params)) || { count: 0 };
    const totalCount = countRow.count;
    const totalPages = Math.ceil(totalCount / limit);

    const traders = await db.prepare(`
      SELECT * FROM traders 
      WHERE ${whereSql} 
      ORDER BY created_at DESC, id DESC 
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Build query string for pagination links
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
      isAdvancedSearch
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

// Create Trader / Broker Page
app.get('/traders/create', (req, res) => {
  const memberType = req.query.type || 'trader';
  const currentPath = memberType === 'broker' ? '/brokers' : (memberType === 'company' ? '/companies' : '/traders');
  res.render('traders/create', { currentPath, member_type: memberType });
});

// Store New Trader / Broker
app.post('/traders', upload.single('person_pic'), async (req, res) => {
  try {
    const {
      name, english_name, commercial_name, activity, english_activity,
      card_no, stamp_no, renewal_no, card_class, commercial_name_no, speciality,
      phone_number, address, affiliation_date, expire_date, member_type
    } = req.body;

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const photoPath = req.file ? '/uploads/' + req.file.filename : null;
    const resolvedType = member_type === 'broker' ? 'broker' : (member_type === 'company' ? 'company' : 'trader');
    if (req.file) {
      await saveUploadedPhotoToCloud(req.file, { name, card_no, commercial_name, member_type: resolvedType });
    }

    await db.prepare(`
      INSERT INTO traders (
        uuid, name, english_name, commercial_name, activity, english_activity,
        card_no, stamp_no, renewal_no, card_class, commercial_name_no, speciality,
        phone_number, address, affiliation_date, expire_date, photo_path,
        member_type, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Site Admin', ?, ?)
    `).run(
      uuid, name, english_name || '', commercial_name || '', activity || '', english_activity || '',
      card_no, stamp_no || '', renewal_no || '', card_class || '4', commercial_name_no || '', speciality || '',
      phone_number || '', address || '', affiliation_date || '', expire_date || '', photoPath,
      resolvedType, now, now
    );

    await accessSyncAdd(db, uuid); // مزامنة فورية مع نظام الشير (Access Hub) ليظهر في أول سطر (#1)

    const redirectPath = resolvedType === 'broker' ? '/brokers' : (resolvedType === 'company' ? '/companies' : '/traders');
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Error saving trader: ' + err.message);
  }
});

// Edit Trader / Broker Page
app.get('/traders/:uuid/edit', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ? OR id = ?").get(req.params.uuid, req.params.uuid);
    if (!trader) {
      return res.status(404).send('Trader not found');
    }
    const currentPath = trader.member_type === 'broker' ? '/brokers' : (trader.member_type === 'company' ? '/companies' : '/traders');
    res.render('traders/edit', { currentPath, trader });
  } catch (err) {
    res.status(500).send('Error loading edit page: ' + err.message);
  }
});

// Update or Delete Trader / Broker (supports POST with multipart _method=patch/delete as well as PATCH/PUT)
async function handleUpdateOrDeleteTrader(req, res) {
  try {
    if (req.body && String(req.body._method || '').toUpperCase() === 'DELETE') {
      const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ? OR id = ?").get(req.params.uuid, req.params.uuid);
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await db.prepare("UPDATE traders SET deleted_at = ? WHERE uuid = ? OR id = ?").run(now, req.params.uuid, req.params.uuid);
      await accessSyncDelete(db, req.params.uuid, trader);
      const redirectPath = trader?.member_type === 'broker' ? '/brokers' : (trader?.member_type === 'company' ? '/companies' : '/traders');
      return res.redirect(redirectPath);
    }

    const traderBefore = await db.prepare("SELECT * FROM traders WHERE uuid = ? OR id = ?").get(req.params.uuid, req.params.uuid);

    const {
      name, english_name, commercial_name, activity, english_activity,
      card_no, stamp_no, renewal_no, card_class, commercial_name_no, speciality,
      phone_number, address, affiliation_date, expire_date
    } = req.body;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    if (req.file) {
      await saveUploadedPhotoToCloud(req.file, {
        name: name || traderBefore?.name,
        card_no: card_no || traderBefore?.card_no,
        commercial_name: commercial_name || traderBefore?.commercial_name,
        member_type: traderBefore?.member_type || 'trader'
      });
      const photoPath = '/uploads/' + req.file.filename;
      await db.prepare(`
        UPDATE traders SET
          name = ?, english_name = ?, commercial_name = ?, activity = ?, english_activity = ?,
          card_no = ?, stamp_no = ?, renewal_no = ?, card_class = ?, commercial_name_no = ?, speciality = ?,
          phone_number = ?, address = ?, affiliation_date = ?, expire_date = ?, photo_path = ?,
          updated_at = ?
        WHERE uuid = ? OR id = ?
      `).run(
        name, english_name || '', commercial_name || '', activity || '', english_activity || '',
        card_no, stamp_no || '', renewal_no || '', card_class || '4', commercial_name_no || '', speciality || '',
        phone_number || '', address || '', affiliation_date || '', expire_date || '', photoPath,
        now, req.params.uuid, req.params.uuid
      );
    } else {
      await db.prepare(`
        UPDATE traders SET
          name = ?, english_name = ?, commercial_name = ?, activity = ?, english_activity = ?,
          card_no = ?, stamp_no = ?, renewal_no = ?, card_class = ?, commercial_name_no = ?, speciality = ?,
          phone_number = ?, address = ?, affiliation_date = ?, expire_date = ?,
          updated_at = ?
        WHERE uuid = ? OR id = ?
      `).run(
        name, english_name || '', commercial_name || '', activity || '', english_activity || '',
        card_no, stamp_no || '', renewal_no || '', card_class || '4', commercial_name_no || '', speciality || '',
        phone_number || '', address || '', affiliation_date || '', expire_date || '',
        now, req.params.uuid, req.params.uuid
      );
    }

    await accessSyncNotify(db, req.params.uuid, traderBefore); // مزامنة التعديل مع Share فورياً

    const redirectPath = traderBefore?.member_type === 'broker' ? '/brokers' : (traderBefore?.member_type === 'company' ? '/companies' : '/traders');
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Error updating trader: ' + err.message);
  }
}

app.patch('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.post('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);
app.put('/traders/:uuid', upload.single('person_pic'), handleUpdateOrDeleteTrader);

// Delete Trader / Broker
app.delete('/traders/:uuid', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ? OR id = ?").get(req.params.uuid, req.params.uuid);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    // Soft delete like original Laravel
    await db.prepare("UPDATE traders SET deleted_at = ? WHERE uuid = ? OR id = ?").run(now, req.params.uuid, req.params.uuid);
    
    await accessSyncDelete(db, req.params.uuid, trader); // مزامنة الحذف مع نظام الشير (Access Hub) فورياً
    const redirectPath = trader?.member_type === 'broker' ? '/brokers' : (trader?.member_type === 'company' ? '/companies' : '/traders');
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Error deleting trader: ' + err.message);
  }
});

// Export CSV (Identical to original format)
app.get('/traders/export/csv', async (req, res) => {
  try {
    const today = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const filename = `traders-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Write UTF-8 BOM
    res.write('\uFEFF');

    const headers = [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Renewal No', 'Card Class', 'Commercial Name No', 'Speciality',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map(h => `"${h}"`).join(',') + '\n');

    const rows = await db.prepare("SELECT * FROM traders WHERE member_type = 'trader' ORDER BY created_at DESC, id DESC").all();

    for (const r of rows) {
      const line = [
        r.name || '', r.english_name || '', r.commercial_name || '', r.activity || '', r.english_activity || '',
        r.card_no || '', r.renewal_no || '', r.card_class || '', r.commercial_name_no || '', r.speciality || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + err.message);
  }
});

// Brokers View
app.get('/brokers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const {
      search,
      name,
      english_name,
      commercial_name,
      card_no,
      stamp_no,
      renewal_no,
      activity,
      phone_number,
      card_class,
      affiliation_date_from,
      affiliation_date_to,
      status
    } = req.query;

    let isAdvancedSearch = Boolean(
      (name && name.trim()) ||
      (english_name && english_name.trim()) ||
      (commercial_name && commercial_name.trim()) ||
      (card_no && card_no.trim()) ||
      (stamp_no && stamp_no.trim()) ||
      (renewal_no && renewal_no.trim()) ||
      (activity && activity.trim()) ||
      (phone_number && phone_number.trim()) ||
      (card_class && card_class !== '') ||
      affiliation_date_from ||
      affiliation_date_to ||
      (status && status !== 'active')
    );

    let where = ["member_type = 'broker'"];
    let params = [];

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where.push("(name LIKE ? OR english_name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR stamp_no LIKE ? OR phone_number LIKE ?)");
      params.push(term, term, term, term, term, term, term);
    }

    if (name && name.trim()) {
      where.push("name LIKE ?");
      params.push(`%${name.trim()}%`);
    }

    if (english_name && english_name.trim()) {
      where.push("english_name LIKE ?");
      params.push(`%${english_name.trim()}%`);
    }

    if (commercial_name && commercial_name.trim()) {
      where.push("commercial_name LIKE ?");
      params.push(`%${commercial_name.trim()}%`);
    }

    if (card_no && card_no.trim()) {
      where.push("card_no = ?");
      params.push(card_no.trim());
    }

    if (stamp_no && stamp_no.trim()) {
      where.push("stamp_no = ?");
      params.push(stamp_no.trim());
    }

    if (renewal_no && renewal_no.trim()) {
      where.push("renewal_no = ?");
      params.push(renewal_no.trim());
    }

    if (activity && activity.trim()) {
      where.push("activity LIKE ?");
      params.push(`%${activity.trim()}%`);
    }

    if (phone_number && phone_number.trim()) {
      where.push("phone_number LIKE ?");
      params.push(`%${phone_number.trim()}%`);
    }

    if (card_class && card_class !== '') {
      where.push("card_class = ?");
      params.push(card_class);
    }

    if (affiliation_date_from) {
      where.push("affiliation_date >= ?");
      params.push(affiliation_date_from);
    }
    if (affiliation_date_to) {
      where.push("affiliation_date <= ?");
      params.push(affiliation_date_to);
    }

    // Status filter
    if (status === 'deleted') {
      where.push("deleted_at IS NOT NULL AND deleted_at != ''");
    } else if (status === 'all') {
      // no filter on deleted_at
    } else {
      where.push("(deleted_at IS NULL OR deleted_at = '')");
    }

    const whereSql = where.join(' AND ');
    const countRow = (await db.prepare(`SELECT COUNT(*) as count FROM traders WHERE ${whereSql}`).get(...params)) || { count: 0 };
    const totalCount = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(totalCount / limit);

    const brokers = await db.prepare(`
      SELECT * FROM traders 
      WHERE ${whereSql} 
      ORDER BY created_at DESC, id DESC 
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

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
      isAdvancedSearch
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

// Export Brokers CSV
app.get('/brokers/export/csv', async (req, res) => {
  try {
    const today = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const filename = `brokers-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Write UTF-8 BOM
    res.write('\uFEFF');

    const headers = [
      'Name', 'English Name', 'Commercial Name', 'Activity', 'English Activity',
      'Card No', 'Stamp No', 'Renewal No', 'Card Class', 'Commercial Name No',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map(h => `"${h}"`).join(',') + '\n');

    let where = ["member_type = 'broker'"];
    let params = [];
    const {
      search, name, english_name, commercial_name, card_no, stamp_no, renewal_no, activity, phone_number, card_class, affiliation_date_from, affiliation_date_to, status
    } = req.query;

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where.push("(name LIKE ? OR english_name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR stamp_no LIKE ? OR phone_number LIKE ?)");
      params.push(term, term, term, term, term, term, term);
    }
    if (name && name.trim()) {
      where.push("name LIKE ?");
      params.push(`%${name.trim()}%`);
    }
    if (english_name && english_name.trim()) {
      where.push("english_name LIKE ?");
      params.push(`%${english_name.trim()}%`);
    }
    if (commercial_name && commercial_name.trim()) {
      where.push("commercial_name LIKE ?");
      params.push(`%${commercial_name.trim()}%`);
    }
    if (card_no && card_no.trim()) {
      where.push("card_no = ?");
      params.push(card_no.trim());
    }
    if (stamp_no && stamp_no.trim()) {
      where.push("stamp_no = ?");
      params.push(stamp_no.trim());
    }
    if (renewal_no && renewal_no.trim()) {
      where.push("renewal_no = ?");
      params.push(renewal_no.trim());
    }
    if (activity && activity.trim()) {
      where.push("activity LIKE ?");
      params.push(`%${activity.trim()}%`);
    }
    if (phone_number && phone_number.trim()) {
      where.push("phone_number LIKE ?");
      params.push(`%${phone_number.trim()}%`);
    }
    if (card_class && card_class !== '') {
      where.push("card_class = ?");
      params.push(card_class);
    }
    if (affiliation_date_from) {
      where.push("affiliation_date >= ?");
      params.push(affiliation_date_from);
    }
    if (affiliation_date_to) {
      where.push("affiliation_date <= ?");
      params.push(affiliation_date_to);
    }
    if (status === 'deleted') {
      where.push("deleted_at IS NOT NULL AND deleted_at != ''");
    } else if (status === 'all') {
      // no filter
    } else {
      where.push("(deleted_at IS NULL OR deleted_at = '')");
    }

    const rows = await db.prepare(`SELECT * FROM traders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`).all(...params);

    for (const r of rows) {
      const line = [
        r.name || '', r.english_name || '', r.commercial_name || '', r.activity || '', r.english_activity || '',
        r.card_no || '', r.stamp_no || '', r.renewal_no || '', r.card_class || '', r.commercial_name_no || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + err.message);
  }
});

// Redirect /brokers/:uuid/edit to /traders/:uuid/edit
app.get('/brokers/:uuid/edit', async (req, res) => {
  res.redirect(`/traders/${req.params.uuid}/edit`);
});

// Companies View
app.get('/companies', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;

    const {
      search,
      name,
      company_name,
      english_name,
      english_company_name,
      commercial_name,
      ceo_name,
      activity,
      card_no,
      renewal_no,
      commercial_name_no,
      incorporation_certificate_no,
      card_class,
      affiliation_date_from,
      affiliation_date_to,
      expire_date_from,
      expire_date_to,
      status
    } = req.query;

    let isAdvancedSearch = Boolean(
      (company_name && company_name.trim()) ||
      (english_company_name && english_company_name.trim()) ||
      (name && name.trim()) ||
      (english_name && english_name.trim()) ||
      (commercial_name && commercial_name.trim()) ||
      (ceo_name && ceo_name.trim()) ||
      (activity && activity.trim()) ||
      (card_no && card_no.trim()) ||
      (renewal_no && renewal_no.trim()) ||
      (commercial_name_no && commercial_name_no.trim()) ||
      (incorporation_certificate_no && incorporation_certificate_no.trim()) ||
      (card_class && card_class !== '') ||
      affiliation_date_from ||
      affiliation_date_to ||
      expire_date_from ||
      expire_date_to ||
      (status && status !== 'active')
    );

    let where = ["member_type = 'company'"];
    let params = [];

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where.push("(company_name LIKE ? OR english_company_name LIKE ? OR ceo_name LIKE ? OR name LIKE ? OR commercial_name LIKE ? OR activity LIKE ? OR card_no LIKE ? OR incorporation_certificate_no LIKE ? OR phone_number LIKE ?)");
      params.push(term, term, term, term, term, term, term, term, term);
    }

    const cName = company_name || name;
    if (cName && cName.trim()) {
      where.push("(company_name LIKE ? OR commercial_name LIKE ? OR name LIKE ?)");
      params.push(`%${cName.trim()}%`, `%${cName.trim()}%`, `%${cName.trim()}%`);
    }

    const cEnName = english_company_name || english_name;
    if (cEnName && cEnName.trim()) {
      where.push("(english_company_name LIKE ? OR english_name LIKE ?)");
      params.push(`%${cEnName.trim()}%`, `%${cEnName.trim()}%`);
    }

    if (commercial_name && commercial_name.trim()) {
      where.push("commercial_name LIKE ?");
      params.push(`%${commercial_name.trim()}%`);
    }

    if (ceo_name && ceo_name.trim()) {
      where.push("(ceo_name LIKE ? OR name LIKE ?)");
      params.push(`%${ceo_name.trim()}%`, `%${ceo_name.trim()}%`);
    }

    if (activity && activity.trim()) {
      where.push("activity LIKE ?");
      params.push(`%${activity.trim()}%`);
    }

    if (card_no && card_no.trim()) {
      where.push("card_no = ?");
      params.push(card_no.trim());
    }

    if (renewal_no && renewal_no.trim()) {
      where.push("renewal_no = ?");
      params.push(renewal_no.trim());
    }

    if (commercial_name_no && commercial_name_no.trim()) {
      where.push("commercial_name_no = ?");
      params.push(commercial_name_no.trim());
    }

    if (incorporation_certificate_no && incorporation_certificate_no.trim()) {
      where.push("incorporation_certificate_no LIKE ?");
      params.push(`%${incorporation_certificate_no.trim()}%`);
    }

    if (card_class && card_class !== '') {
      where.push("card_class = ?");
      params.push(card_class);
    }

    if (affiliation_date_from) {
      where.push("affiliation_date >= ?");
      params.push(affiliation_date_from);
    }
    if (affiliation_date_to) {
      where.push("affiliation_date <= ?");
      params.push(affiliation_date_to);
    }
    if (expire_date_from) {
      where.push("expire_date >= ?");
      params.push(expire_date_from);
    }
    if (expire_date_to) {
      where.push("expire_date <= ?");
      params.push(expire_date_to);
    }

    // Status filter
    if (status === 'deleted') {
      where.push("deleted_at IS NOT NULL AND deleted_at != ''");
    } else if (status === 'all') {
      // no filter on deleted_at
    } else {
      where.push("(deleted_at IS NULL OR deleted_at = '')");
    }

    const whereSql = where.join(' AND ');
    const countRow = (await db.prepare(`SELECT COUNT(*) as count FROM traders WHERE ${whereSql}`).get(...params)) || { count: 0 };
    const totalCount = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(totalCount / limit);

    const companies = await db.prepare(`
      SELECT * FROM traders 
      WHERE ${whereSql} 
      ORDER BY created_at DESC, id DESC 
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

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
      isAdvancedSearch
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

// Export Companies CSV
app.get('/companies/export/csv', async (req, res) => {
  try {
    const filename = `companies-export-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const headers = [
      'Company Name', 'English Company Name', 'CEO Name', 'English CEO Name', 'Activity',
      'Card No', 'Renewal No', 'Card Class', 'Incorporation Certificate No', 'Incorporation Symbol',
      'Phone Number', 'Address', 'Affiliation Date', 'Expire Date', 'Created By',
      'Created At', 'Updated At', 'Deleted At'
    ];
    res.write(headers.map(h => `"${h}"`).join(',') + '\n');

    const rows = await db.prepare("SELECT * FROM traders WHERE member_type = 'company' ORDER BY created_at DESC, id DESC").all();

    for (const r of rows) {
      const line = [
        r.company_name || r.commercial_name || '', r.english_company_name || '', r.ceo_name || r.name || '', r.english_ceo_name || r.english_name || '', r.activity || '',
        r.card_no || '', r.renewal_no || '', r.card_class || '', r.incorporation_certificate_no || '', r.incorporation_certificate_symbol || '',
        r.phone_number || '', r.address || '', r.affiliation_date || '', r.expire_date || '', r.created_by || 'Site Admin',
        r.created_at || '', r.updated_at || '', r.deleted_at || ''
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      res.write(line + '\n');
    }

    res.end();
  } catch (err) {
    res.status(500).send('Export error: ' + err.message);
  }
});

// Company Edit / Actions redirect to trader unified handler
app.get('/companies/:uuid/edit', async (req, res) => {
  res.redirect('/traders/' + req.params.uuid + '/edit');
});

// ==========================================
// API & Validation Endpoints
// ==========================================

const DEFAULT_CARD_TYPOGRAPHY = {
  front: {
    name_size: 28,
    name_x: 900,
    name_y: 308,
    class_size: 26,
    class_x: 890,
    class_y: 366,
    comm_size: 24,
    comm_x: 795,
    comm_y: 432,
    activity_size: 24,
    activity_x: 885,
    activity_y: 490,
    card_no_size: 30,
    card_no_x: 845,
    card_no_y: 560,
    aff_date_size: 23,
    aff_date_x: 885,
    aff_date_y: 626,
    exp_date_size: 23,
    exp_date_x: 465,
    exp_date_y: 626
  },
  back: {
    name_size: 26,
    name_x: 14,
    name_y: 305,
    class_size: 24,
    class_x: 118,
    class_y: 368,
    comm_no_size: 24,
    comm_no_x: 390,
    comm_no_y: 423,
    activity_size: 22,
    activity_x: 165,
    activity_y: 474,
    card_no_size: 30,
    card_no_x: 125,
    card_no_y: 560,
    aff_date_size: 22,
    aff_date_x: 170,
    aff_date_y: 620,
    exp_date_size: 22,
    exp_date_x: 735,
    exp_date_y: 620,
    qr_x: 757,
    qr_y: 210,
    qr_size: 238
  }
};

const DEFAULT_COMPANY_CARD_TYPOGRAPHY = {
  front: {
    comp_size: 26, comp_x: 900, comp_y: 285,
    ceo_size: 24, ceo_x: 815, ceo_y: 338,
    class_act_size: 24, class_act_x: 775, class_act_y: 385,
    cert_size: 24, cert_x: 725, cert_y: 435,
    comm_date_size: 24, comm_date_x: 695, comm_date_y: 485,
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

// Profile Page
app.get('/profile', async (req, res) => {
  try {
    let settings = DEFAULT_CARD_TYPOGRAPHY;
    try {
      const row = await db.prepare("SELECT value FROM settings WHERE key = 'card_typography'").get();
      if (row && row.value) {
        settings = JSON.parse(row.value);
      }
    } catch (e) {
      // fallback to default
    }

    let companySettings = DEFAULT_COMPANY_CARD_TYPOGRAPHY;
    try {
      const cRow = await db.prepare("SELECT value FROM settings WHERE key = 'company_card_typography'").get();
      if (cRow && cRow.value) {
        companySettings = JSON.parse(cRow.value);
      }
    } catch (e) {
      // fallback
    }

    let brokerSettings = DEFAULT_BROKER_CARD_TYPOGRAPHY;
    try {
      const bRow = await db.prepare("SELECT value FROM settings WHERE key = 'broker_card_typography'").get();
      if (bRow && bRow.value) {
        brokerSettings = JSON.parse(bRow.value);
      }
    } catch (e) {
      // fallback
    }

    // Sample trader for live preview
    const sampleTrader = (await db.prepare("SELECT * FROM traders WHERE member_type = 'trader' AND photo_path IS NOT NULL LIMIT 1").get()) || {
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

    // Sample company for live preview
    const sampleCompany = (await db.prepare("SELECT * FROM traders WHERE member_type = 'company' AND photo_path IS NOT NULL LIMIT 1").get()) || {
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

    // Sample broker for live preview
    const sampleBroker = (await db.prepare("SELECT * FROM traders WHERE member_type = 'broker' AND photo_path IS NOT NULL LIMIT 1").get()) || {
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

    res.render('profile/index', {
      currentPath: '/profile',
      user: { name: 'Site Admin', email: 'admin@k-coc.org' },
      settings,
      companySettings,
      brokerSettings,
      sampleTrader,
      sampleCompany,
      sampleBroker,
      successMsg: req.query.saved ? 'تم حفظ إعدادات الخطوط والتصميم بنجاح!' : null
    });
  } catch (err) {
    res.status(500).send('Error loading profile: ' + err.message);
  }
});

// Profile Update (Mock)
app.patch('/profile', async (req, res) => {
  res.redirect('/profile?saved=1');
});

// Get Card Typography Settings API
app.get('/api/settings/card-typography', async (req, res) => {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'card_typography'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed.back) {
        if (parsed.back.name_size === undefined) parsed.back.name_size = DEFAULT_CARD_TYPOGRAPHY.back.name_size;
        if (parsed.back.name_x === undefined) parsed.back.name_x = DEFAULT_CARD_TYPOGRAPHY.back.name_x;
        if (parsed.back.name_y === undefined) parsed.back.name_y = DEFAULT_CARD_TYPOGRAPHY.back.name_y;
      }
      return res.json({ success: true, settings: parsed });
    }
    res.json({ success: true, settings: DEFAULT_CARD_TYPOGRAPHY });
  } catch (err) {
    res.json({ success: true, settings: DEFAULT_CARD_TYPOGRAPHY });
  }
});

// Save Card Typography Settings API
app.post('/api/settings/card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('card_typography', ?)").run(JSON.stringify(newSettings));
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Card Typography Settings API
app.post('/api/settings/card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('card_typography', ?)").run(JSON.stringify(DEFAULT_CARD_TYPOGRAPHY));
    res.json({ success: true, settings: DEFAULT_CARD_TYPOGRAPHY, message: 'Settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Company Card Typography Settings API
app.get('/api/settings/company-card-typography', async (req, res) => {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'company_card_typography'").get();
    if (row && row.value) {
      return res.json({ success: true, settings: JSON.parse(row.value) });
    }
    res.json({ success: true, settings: DEFAULT_COMPANY_CARD_TYPOGRAPHY });
  } catch (err) {
    res.json({ success: true, settings: DEFAULT_COMPANY_CARD_TYPOGRAPHY });
  }
});

// Save Company Card Typography Settings API
app.post('/api/settings/company-card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_card_typography', ?)").run(JSON.stringify(newSettings));
    res.json({ success: true, message: 'Company settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Company Card Typography Settings API
app.post('/api/settings/company-card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_card_typography', ?)").run(JSON.stringify(DEFAULT_COMPANY_CARD_TYPOGRAPHY));
    res.json({ success: true, settings: DEFAULT_COMPANY_CARD_TYPOGRAPHY, message: 'Company settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Broker Card Typography Settings API
app.get('/api/settings/broker-card-typography', async (req, res) => {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'broker_card_typography'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return res.json({ success: true, settings: parsed });
    }
    res.json({ success: true, settings: DEFAULT_BROKER_CARD_TYPOGRAPHY });
  } catch (err) {
    res.json({ success: true, settings: DEFAULT_BROKER_CARD_TYPOGRAPHY });
  }
});

// Save Broker Card Typography Settings API
app.post('/api/settings/broker-card-typography', async (req, res) => {
  try {
    const newSettings = req.body.settings || req.body;
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('broker_card_typography', ?)").run(JSON.stringify(newSettings));
    res.json({ success: true, message: 'Broker settings saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Broker Card Typography Settings API
app.post('/api/settings/broker-card-typography/reset', async (req, res) => {
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('broker_card_typography', ?)").run(JSON.stringify(DEFAULT_BROKER_CARD_TYPOGRAPHY));
    res.json({ success: true, settings: DEFAULT_BROKER_CARD_TYPOGRAPHY, message: 'Broker settings reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Trader JSON API
app.get('/api/traders/:id', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ? OR id = ? OR card_no = ?").get(req.params.id, req.params.id, req.params.id);
    if (!trader) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, trader });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save Custom Typography for Single Trader
app.post('/api/traders/:id/typography', async (req, res) => {
  try {
    const typoJson = JSON.stringify(req.body.typography || req.body);
    await db.prepare("UPDATE traders SET custom_typography = ? WHERE id = ? OR uuid = ?").run(typoJson, req.params.id, req.params.id);
    res.json({ success: true, message: 'Custom typography saved for this trader' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Custom Typography for Single Trader
app.post('/api/traders/:id/typography/reset', async (req, res) => {
  try {
    await db.prepare("UPDATE traders SET custom_typography = NULL WHERE id = ? OR uuid = ?").run(req.params.id, req.params.id);
    res.json({ success: true, message: 'Reset to global settings for this trader' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trader QR Code Data URL
app.get('/api/traders/:id/qr', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE id = ? OR uuid = ?").get(req.params.id, req.params.id);
    if (!trader) return res.status(404).json({ success: false, error: 'Not found' });

    const host = req.get('host');
    const protocol = req.protocol;
    const validateUrl = `${protocol}://${host}/traders/validate/${trader.uuid}`;

    const qrDataUrl = await QRCode.toDataURL(validateUrl, {
      margin: 0,
      width: 300,
      color: { dark: '#000000', light: '#00000000' }
    });

    res.json({ success: true, qr_url: qrDataUrl, validate_url: validateUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Official Public Validation Page
app.get('/traders/validate/:uuid', async (req, res) => {
  try {
    const trader = await db.prepare("SELECT * FROM traders WHERE uuid = ?").get(req.params.uuid);
    if (!trader) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="utf-8">
          <title>صحة الصدور - غير موجود</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
          <div class="bg-white p-8 rounded-xl shadow max-w-md w-full text-center">
            <h1 class="text-2xl font-bold text-red-600 mb-2">الهوية غير صالحة</h1>
            <p class="text-gray-600">لم يتم العثور على سجل لهذه الهوية في غرفة تجارة كربلاء المقدسة.</p>
          </div>
        </body>
        </html>
      `);
    }

    const isExpired = trader.expire_date && new Date(trader.expire_date) < new Date();
    const photoUrl = trader.photo_path || '/templates/avatar_placeholder.png';

    res.send(`
<!DOCTYPE html>
<html lang="en" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Karbala Chamber of Commerce</title>
    <link rel="preconnect" href="https://fonts.bunny.net">
    <link href="https://fonts.bunny.net/css?family=figtree:400,600&display=swap" rel="stylesheet"/>
    <link rel="stylesheet" href="/build/assets/app-514d3f3f.css" />
    <style>
      @font-face {
        font-family: 'PT Bold Heading';
        src: url('/templates/PTBoldHeading.woff2') format('woff2');
        font-weight: bold;
      }
      @font-face {
        font-family: 'Myriad Pro';
        src: url('/templates/MyriadPro-Bold.woff2') format('woff2');
        font-weight: bold;
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
                <img id="ArPersonPic" src="${photoUrl}" alt="Photo"/>
                <p id="ArName" class="ArText">${trader.member_type === 'broker' ? 'الدلال' : 'التاجر'}: ${trader.name}</p>
                <p id="ArClass" class="ArText">الصنف: ${trader.member_type === 'broker' ? 'دلالية' : formatClassName(trader.card_class, 'ar')}</p>
                <p id="ArCommercialName" class="ArText">الاسم التجاري: ${trader.commercial_name || '-'} / <span id="ArCommercialNameNo">${trader.commercial_name_no || ''}</span></p>
                <p id="ArActivity" class="ArText">النشاط: ${trader.activity || '-'}</p>
                <p id="CardNo" class="ArText font-bold text-blue-700">رقم الهوية: ${trader.card_no} ${trader.renewal_no ? '/ ' + trader.renewal_no : ''}</p>
                <p id="ArAffiliationDate" class="ArText">الانتماء: ${trader.affiliation_date || '-'}</p>
                <p id="ArExpireDate" class="ArText ${isExpired ? 'text-red-600' : 'text-green-700'}">النفاذ: ${trader.expire_date || '-'}</p>
            </div>
            <div id="background">
                <p id="EnName" class="EnText font-bold">${trader.english_name || '-'}</p>
                <p id="EnClass" class="EnText">Class: ${formatClassName(trader.card_class, 'en')}</p>
                <p id="EnCommercialNameNo" class="EnText">Commercial Name No: ${trader.commercial_name_no || '-'}</p>
                <p id="EnActivity" class="EnText">Activity: ${trader.english_activity || trader.activity || '-'}</p>
                <p id="EnCardNo" class="EnText font-bold">ID No: ${trader.card_no} ${trader.renewal_no ? '/ ' + trader.renewal_no : ''}</p>
                <p id="EnAffiliationDate" class="EnText">Affiliation: ${trader.affiliation_date || '-'}</p>
                <p id="EnExpireDate" class="EnText">Expire: ${trader.expire_date || '-'}</p>
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
    res.status(500).send('Error: ' + err.message);
  }
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
  console.log(`🚀 خادم نظام Cardval المتطابق 100% يعمل الآن بنجاح!`);
  console.log(`💻 من هذا الكمبيوتر:        http://localhost:${PORT}/traders`);
  const ips = getNetworkIps();
  ips.forEach(ip => {
    console.log(`📱 من الأجهزة الأخرى (${ip.name}): http://${ip.address}:${PORT}/traders`);
  });
  console.log(`======================================================\n`);
});
