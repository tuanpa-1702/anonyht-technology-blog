// "Tài nguyên" - downloadable files in a tree of folders, shown on the "Lưu
// trữ" page (public/archive.html, js/archive.js).
//
//   Who        reading the tree and downloading: signed-in users only.
//              Folders and files are managed by admins only.
//   Storage    public/uploads/.anonyht-resources/files/<random name> on the
//              100 GB disk; never served statically (see ROOT below), so nothing
//              uploaded here can be opened as a page. Downloads always go out as an attachment with a generic
//              content type (no inline HTML/SVG from an upload, ever).
//   Size       no per-file limit (the user's call), but uploads are CHUNKED -
//              Cloudflare refuses any single request body over 100 MB on this
//              plan - and a file is refused when it would leave the disk with
//              less than DISK_RESERVE free, so a big upload can never fill the
//              disk the database and the site run from.
//   Download   the page asks POST /files/:id/link (signed in) for a short-lived
//              signed URL and navigates to it: a plain link cannot carry the
//              Bearer token the rest of the API uses.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../env');
const { requireAuth, requireAdmin, requireWriter } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

// On the 100 GB disk mounted at public/uploads (the root disk has ~3 GB free),
// in a DOT-directory: express.static ignores dotfiles, and server.js also
// refuses any /uploads/.anonyht-resources request outright, so these files are
// reachable only through the signed download route below.
const ROOT = path.join(__dirname, '..', '..', 'public', 'uploads', '.anonyht-resources');
const FILES_DIR = path.join(ROOT, 'files');
const TMP_DIR = path.join(ROOT, 'tmp');
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per request, under Cloudflare's 100 MB
const DISK_RESERVE = 500 * 1024 * 1024; // keep at least this much free
const LINK_TTL = '10m';
const NAME_MAX = 120;

db.exec(`
  CREATE TABLE IF NOT EXISTS resource_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES resource_folders(id) ON DELETE CASCADE,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS resource_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL REFERENCES resource_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL,
    uploader_id INTEGER,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_resource_folders_parent ON resource_folders (parent_id);
  CREATE INDEX IF NOT EXISTS idx_resource_files_folder ON resource_files (folder_id);
`);
// The two starting folders the user named, created once on an empty table.
if (!db.prepare('SELECT COUNT(*) AS c FROM resource_folders').get().c) {
  const add = db.prepare('INSERT INTO resource_folders (name, parent_id) VALUES (?, NULL)');
  add.run('Media');
  add.run('Software');
}

// Leftover partial uploads (a browser closed mid-upload, a restart) older than a
// day are removed at start-up.
for (const f of fs.readdirSync(TMP_DIR)) {
  try {
    const p = path.join(TMP_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

function freeBytes() {
  try {
    const s = fs.statfsSync(ROOT);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

function folderExists(id) {
  return !!db.prepare('SELECT 1 FROM resource_folders WHERE id = ?').get(id);
}

// Every folder id under `id`, itself included - for deleting a whole branch's
// files from disk (the rows go by ON DELETE CASCADE).
function branchIds(id) {
  return db
    .prepare(
      `WITH RECURSIVE b(id) AS (SELECT ? UNION ALL SELECT f.id FROM resource_folders f JOIN b ON f.parent_id = b.id)
       SELECT id FROM b`
    )
    .all(id)
    .map((r) => r.id);
}

const writeLimit = rateLimit({ name: 'resources-write', windowMs: 60_000, max: 120 });
const linkLimit = rateLimit({ name: 'resources-link', windowMs: 60_000, max: 30 });

// ---- Reading ---------------------------------------------------------------

// GET /api/resources/tree - every folder and file (no paths, no stored names).
// Signed-in users only: a visitor sees neither the folders nor the files.
router.get('/tree', requireAuth, (req, res) => {
  const folders = db.prepare('SELECT id, name, parent_id, created_at FROM resource_folders ORDER BY name COLLATE NOCASE').all();
  const files = db
    .prepare('SELECT id, folder_id, name, bytes, downloads, created_at, uploader_id FROM resource_files ORDER BY name COLLATE NOCASE')
    .all()
    // can_edit: who may rename / delete this file - an admin any file, an
    // editor the files they uploaded. uploader_id itself is not sent.
    .map(({ uploader_id: uploaderId, ...f }) => ({
      ...f,
      can_edit: req.user.role === 'admin' || (req.user.role === 'editor' && uploaderId === req.user.id),
    }));
  res.json({ folders, files });
});

// ---- Folders (admin) ---------------------------------------------------------

router.post('/folders', requireAuth, requireAdmin, writeLimit, express.json(), (req, res) => {
  const name = cleanName(req.body?.name);
  const parentId = req.body?.parent_id == null || req.body.parent_id === '' ? null : Number(req.body.parent_id);
  if (!name) return res.status(400).json({ error: 'Tên thư mục không được để trống.' });
  if (parentId !== null && !folderExists(parentId)) return res.status(404).json({ error: 'Không tìm thấy thư mục cha.' });
  const dup = db
    .prepare('SELECT 1 FROM resource_folders WHERE name = ? COLLATE NOCASE AND parent_id IS ?')
    .get(name, parentId);
  if (dup) return res.status(409).json({ error: 'Đã có thư mục cùng tên ở đây.' });
  const r = db
    .prepare('INSERT INTO resource_folders (name, parent_id, created_by) VALUES (?, ?, ?)')
    .run(name, parentId, req.user.id);
  res.status(201).json({ folder: { id: Number(r.lastInsertRowid), name, parent_id: parentId } });
});

router.patch('/folders/:id', requireAuth, requireAdmin, writeLimit, express.json(), (req, res) => {
  const id = Number(req.params.id);
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Tên thư mục không được để trống.' });
  const row = db.prepare('SELECT parent_id FROM resource_folders WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy thư mục.' });
  const dup = db
    .prepare('SELECT 1 FROM resource_folders WHERE name = ? COLLATE NOCASE AND parent_id IS ? AND id != ?')
    .get(name, row.parent_id, id);
  if (dup) return res.status(409).json({ error: 'Đã có thư mục cùng tên ở đây.' });
  db.prepare('UPDATE resource_folders SET name = ? WHERE id = ?').run(name, id);
  res.json({ ok: true });
});

// Deletes the folder, every folder under it, and all their files (disk too).
router.delete('/folders/:id', requireAuth, requireAdmin, writeLimit, (req, res) => {
  const id = Number(req.params.id);
  if (!folderExists(id)) return res.status(404).json({ error: 'Không tìm thấy thư mục.' });
  const ids = branchIds(id);
  const placeholders = ids.map(() => '?').join(',');
  const stored = db.prepare(`SELECT stored_name FROM resource_files WHERE folder_id IN (${placeholders})`).all(...ids);
  db.transaction(() => {
    db.prepare(`DELETE FROM resource_files WHERE folder_id IN (${placeholders})`).run(...ids);
    // Children first, deepest last in the list -> delete in reverse.
    const del = db.prepare('DELETE FROM resource_folders WHERE id = ?');
    for (const fid of [...ids].reverse()) del.run(fid);
  })();
  for (const s of stored) fs.rm(path.join(FILES_DIR, s.stored_name), { force: true }, () => {});
  res.json({ ok: true, removed_files: stored.length });
});

// ---- Chunked upload (admin) --------------------------------------------------
// POST /uploads {folder_id, name, size} -> {upload_id, chunk_size}
// PUT  /uploads/:uid/:index  (raw body, in order)
// POST /uploads/:uid/complete -> {file}
// DELETE /uploads/:uid  (abort)

const uploads = new Map(); // upload_id -> { folderId, name, size, received, nextIndex, tmp, userId, touched }

// An abandoned upload's temp file is removed after an hour without a chunk.
setInterval(() => {
  for (const [uid, u] of uploads) {
    if (Date.now() - u.touched > 3600 * 1000) {
      fs.rm(u.tmp, { force: true }, () => {});
      uploads.delete(uid);
    }
  }
}, 10 * 60 * 1000).unref();

router.post('/uploads', requireAuth, requireWriter, writeLimit, express.json(), (req, res) => {
  const folderId = Number(req.body?.folder_id);
  const name = cleanName(req.body?.name);
  const size = Number(req.body?.size);
  if (!folderExists(folderId)) return res.status(404).json({ error: 'Không tìm thấy thư mục.' });
  if (!name) return res.status(400).json({ error: 'Tên file không hợp lệ.' });
  if (!Number.isSafeInteger(size) || size < 0) return res.status(400).json({ error: 'Dung lượng file không hợp lệ.' });
  const reserved = [...uploads.values()].reduce((n, u) => n + (u.size - u.received), 0);
  if (size + reserved + DISK_RESERVE > freeBytes()) {
    const freeMb = Math.max(0, Math.floor((freeBytes() - DISK_RESERVE) / 1024 / 1024));
    return res.status(507).json({ error: `Không đủ dung lượng trên máy chủ (còn trống khoảng ${freeMb} MB có thể dùng).` });
  }
  const uid = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(TMP_DIR, uid);
  fs.writeFileSync(tmp, '');
  uploads.set(uid, { folderId, name, size, received: 0, nextIndex: 0, tmp, userId: req.user.id, touched: Date.now() });
  res.status(201).json({ upload_id: uid, chunk_size: CHUNK_SIZE });
});

router.put(
  '/uploads/:uid/:index',
  requireAuth,
  requireWriter,
  express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 * 1024 }),
  (req, res) => {
    const u = uploads.get(req.params.uid);
    if (!u || u.userId !== req.user.id) return res.status(404).json({ error: 'Phiên tải lên không tồn tại hoặc đã hết hạn.' });
    const index = Number(req.params.index);
    if (index !== u.nextIndex) return res.status(409).json({ error: 'Sai thứ tự phần dữ liệu.', expected: u.nextIndex });
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (u.received + chunk.length > u.size) return res.status(400).json({ error: 'Dữ liệu vượt quá dung lượng đã khai báo.' });
    fs.appendFileSync(u.tmp, chunk);
    u.received += chunk.length;
    u.nextIndex += 1;
    u.touched = Date.now();
    res.json({ received: u.received });
  }
);

router.post('/uploads/:uid/complete', requireAuth, requireWriter, (req, res) => {
  const u = uploads.get(req.params.uid);
  if (!u || u.userId !== req.user.id) return res.status(404).json({ error: 'Phiên tải lên không tồn tại hoặc đã hết hạn.' });
  if (u.received !== u.size) return res.status(400).json({ error: 'File chưa tải lên đủ.' });
  uploads.delete(req.params.uid);
  if (!folderExists(u.folderId)) {
    fs.rm(u.tmp, { force: true }, () => {});
    return res.status(404).json({ error: 'Thư mục đã bị xoá trong lúc tải lên.' });
  }
  const stored = crypto.randomBytes(16).toString('hex');
  fs.renameSync(u.tmp, path.join(FILES_DIR, stored));
  const r = db
    .prepare('INSERT INTO resource_files (folder_id, name, stored_name, bytes, uploader_id) VALUES (?, ?, ?, ?, ?)')
    .run(u.folderId, u.name, stored, u.size, req.user.id);
  res.status(201).json({ file: { id: Number(r.lastInsertRowid), folder_id: u.folderId, name: u.name, bytes: u.size } });
});

router.delete('/uploads/:uid', requireAuth, requireWriter, (req, res) => {
  const u = uploads.get(req.params.uid);
  if (u && u.userId === req.user.id) {
    fs.rm(u.tmp, { force: true }, () => {});
    uploads.delete(req.params.uid);
  }
  res.json({ ok: true });
});

// ---- Files (admin: any file; editor: the files they uploaded) ----------------

// The file row if the caller may change it; otherwise sends the error and
// returns null.
function editableFile(req, res, columns) {
  const row = db.prepare(`SELECT ${columns}, uploader_id FROM resource_files WHERE id = ?`).get(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Không tìm thấy file.' });
    return null;
  }
  if (req.user.role !== 'admin' && row.uploader_id !== req.user.id) {
    res.status(403).json({ error: 'Bạn chỉ có thể sửa hoặc xoá file do chính mình tải lên.' });
    return null;
  }
  return row;
}

router.patch('/files/:id', requireAuth, requireWriter, writeLimit, express.json(), (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Tên file không được để trống.' });
  if (!editableFile(req, res, 'id')) return;
  db.prepare('UPDATE resource_files SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/files/:id', requireAuth, requireWriter, writeLimit, (req, res) => {
  const row = editableFile(req, res, 'stored_name');
  if (!row) return;
  db.prepare('DELETE FROM resource_files WHERE id = ?').run(Number(req.params.id));
  fs.rm(path.join(FILES_DIR, row.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// ---- Download (signed-in users) ----------------------------------------------

router.post('/files/:id/link', requireAuth, linkLimit, (req, res) => {
  const row = db.prepare('SELECT id FROM resource_files WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Không tìm thấy file.' });
  const token = jwt.sign({ fid: row.id, uid: req.user.id, purpose: 'resource-download' }, JWT_SECRET, { expiresIn: LINK_TTL });
  res.json({ url: `/api/resources/download/${encodeURIComponent(token)}` });
});

router.get('/download/:token', (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.params.token), JWT_SECRET);
  } catch {
    return res.status(403).type('text/plain; charset=utf-8').send('Liên kết tải đã hết hạn. Hãy quay lại trang Lưu trữ và bấm tải lại.');
  }
  if (!payload || payload.purpose !== 'resource-download') return res.status(403).end();
  const row = db.prepare('SELECT id, name, stored_name, bytes FROM resource_files WHERE id = ?').get(payload.fid);
  if (!row) return res.status(404).type('text/plain; charset=utf-8').send('File không còn tồn tại.');
  const file = path.join(FILES_DIR, row.stored_name);
  if (!fs.existsSync(file)) return res.status(404).type('text/plain; charset=utf-8').send('File không còn tồn tại.');
  db.prepare('UPDATE resource_files SET downloads = downloads + 1 WHERE id = ?').run(row.id);
  const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(row.bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(file).pipe(res);
});

module.exports = router;
