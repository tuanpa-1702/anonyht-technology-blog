// Admin > Gửi thông báo: an announcement email from the admin to the members
// (all of them, only those who opted into email, or a hand-picked list).
//
// The body is written in a small Markdown subset and rendered here, escape-first,
// for both the preview in the admin page and the mail itself, so what the admin
// previews is exactly what is sent:
//   blank line        new paragraph          - item      bullet list
//   ## Tiêu đề        heading                **đậm**  *nghiêng*
//   [chữ](https://…)  link                   https://… bare links become links
//   {ten}             the recipient's name
//
// Sending runs in the background, one message at a time, so the request returns
// at once and a slow relay cannot time the admin's browser out; the history row
// in `broadcasts` is updated as it goes and is what the page polls.
const db = require('./db');
const { getEmailConfig } = require('./email-config');
const { sendBroadcastMessage } = require('./mailer');

db.exec(`
  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL,              -- 'all' | 'opted_in' | 'selected'
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sending', -- 'sending' | 'done'
    failures TEXT NOT NULL DEFAULT '[]', -- JSON [{email, error}]
    created_by INTEGER,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )
`);
// A restart mid-send leaves a row 'sending' forever; it is finished as far as
// it got.
db.prepare("UPDATE broadcasts SET status = 'done', finished_at = datetime('now') WHERE status = 'sending'").run();

const AUDIENCES = ['all', 'opted_in', 'selected'];
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline marks on ALREADY-ESCAPED text. Links only http(s)/mailto.
function inline(escaped) {
  const links = [];
  const keep = (html) => `\u0000${links.push(html) - 1}\u0000`;
  let s = escaped.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (m, label, href) =>
    keep(`<a href="${href}" style="color:#14171c;text-decoration:underline;">${label}</a>`)
  );
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + keep(`<a href="${url}" style="color:#14171c;text-decoration:underline;">${url}</a>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => links[Number(i)]);
}

// Markdown subset -> { html, text }. `name` fills {ten}.
function renderBody(body, name = '') {
  const filled = String(body || '').replace(/\r\n?/g, '\n').replace(/\{ten\}/g, name || 'bạn');
  const blocks = filled.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const html = blocks
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul style="margin:0 0 14px;padding-left:20px;">${lines
          .map((l) => `<li style="margin:4px 0;">${inline(escapeHtml(l.replace(/^\s*[-*]\s+/, '')))}</li>`)
          .join('')}</ul>`;
      }
      const h = /^#{1,3}\s+(.+)$/.exec(lines[0]);
      if (h && lines.length === 1) {
        return `<h3 style="margin:20px 0 8px;font-size:16px;font-weight:700;color:#14171c;">${inline(escapeHtml(h[1]))}</h3>`;
      }
      return `<p style="margin:0 0 14px;line-height:1.65;">${lines.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`;
    })
    .join('\n');
  const text = filled.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  return { html, text };
}

// Who an audience reaches: active, verified, not deleted accounts.
function recipientsFor(audience, userIds) {
  const base = `SELECT id, name, email FROM users
                 WHERE deleted_at IS NULL AND is_active = 1 AND email_verified = 1 AND email <> ''`;
  if (audience === 'opted_in') return db.prepare(`${base} AND email_notifications = 1 ORDER BY id`).all();
  if (audience === 'selected') {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return [];
    return db.prepare(`${base} AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  }
  return db.prepare(`${base} ORDER BY id`).all();
}

function validate({ subject, body, audience }) {
  const s = String(subject || '').trim();
  const b = String(body || '').trim();
  if (!s) return 'Vui lòng nhập tiêu đề email.';
  if (s.length > MAX_SUBJECT) return 'Tiêu đề quá dài (tối đa 200 ký tự).';
  if (!b) return 'Vui lòng nhập nội dung thông báo.';
  if (b.length > MAX_BODY) return 'Nội dung quá dài.';
  if (audience !== undefined && !AUDIENCES.includes(audience)) return 'Nhóm người nhận không hợp lệ.';
  return '';
}

function emailReady() {
  return !!getEmailConfig().configured;
}

const updateProgress = db.prepare('UPDATE broadcasts SET sent = ?, failed = ?, failures = ? WHERE id = ?');
const finish = db.prepare("UPDATE broadcasts SET status = 'done', finished_at = datetime('now') WHERE id = ?");

// Creates the history row and sends in the background; returns the row id.
function start({ subject, body, audience, recipients, actor, brandName }) {
  const info = db
    .prepare(
      'INSERT INTO broadcasts (subject, body, audience, total, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(subject, body, audience, recipients.length, actor?.id ?? null, actor?.name || '');
  const id = Number(info.lastInsertRowid);
  (async () => {
    let sent = 0;
    const failures = [];
    for (const r of recipients) {
      try {
        const { html, text } = renderBody(body, r.name);
        await sendBroadcastMessage(r, { subject, html, text }, brandName);
        sent += 1;
      } catch (e) {
        failures.push({ email: r.email, error: String(e && e.message ? e.message : e).slice(0, 200) });
      }
      updateProgress.run(sent, failures.length, JSON.stringify(failures), id);
      // A small gap keeps a burst under the relay's rate limits.
      await new Promise((res) => setTimeout(res, 300));
    }
    finish.run(id);
  })().catch((e) => {
    console.error('[broadcast] job failed:', e);
    finish.run(id);
  });
  return id;
}

function get(id) {
  const row = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(Number(id));
  if (row) row.failures = JSON.parse(row.failures || '[]');
  return row;
}

function history(limit = 20) {
  return db
    .prepare(
      `SELECT id, subject, audience, total, sent, failed, status, created_by_name, created_at, finished_at
         FROM broadcasts ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

module.exports = { AUDIENCES, renderBody, recipientsFor, validate, emailReady, start, get, history };
