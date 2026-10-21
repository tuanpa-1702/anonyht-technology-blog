const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { parseSocialLinks } = require('../social-links');
const db = require('../db');
const { verifyUnsubscribeToken } = require('../unsubscribe-token');
const { rateLimit } = require('../middleware/rate-limit');
// A profile card whose post has no excerpt shows the opening of the body
// instead of an empty preview line; computed in server/excerpt.js.
const { attachExcerptFallback } = require('../excerpt');

const router = express.Router();

// ---- One-click unsubscribe ---------------------------------------------------
// The exit door a new-post notification points at, in both shapes mail clients
// ask for: Gmail's one-click button POSTs the List-Unsubscribe URL, and a reader
// who clicks the same link in the body GETs it and gets a page back saying it
// worked. No login - the whole point is that it works for someone who is done
// with us, and the signed token is the only authority it needs. Defined ABOVE
// the /:id/posts route further down, which would otherwise swallow
// /unsubscribe/<token> as user "unsubscribe" asking for their posts.
const unsubLimit = rateLimit({ name: 'unsubscribe', windowMs: 60_000, max: 10 });

function applyUnsubscribe(token) {
  const uid = verifyUnsubscribeToken(token);
  if (!uid) return false;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
  if (!user) return false;
  db.prepare('UPDATE users SET email_notifications = 0 WHERE id = ?').run(uid);
  return true;
}

router.post('/unsubscribe/:token', unsubLimit, (req, res) => {
  if (!applyUnsubscribe(req.params.token)) {
    return res.status(400).json({ error: 'Liên kết tắt thông báo không hợp lệ.' });
  }
  res.json({ ok: true });
});

router.get('/unsubscribe/:token', unsubLimit, (req, res) => {
  const ok = applyUnsubscribe(req.params.token);
  res.type('html').send(
    ok
      ? '<!doctype html><meta charset="utf-8"><title>Đã tắt thông báo</title><div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center"><h2>Đã tắt thông báo bài viết mới</h2><p>Bạn sẽ không nhận email thông báo bài viết mới nữa. Bật lại bất cứ lúc nào trong trang cá nhân.</p></div>'
      : '<!doctype html><meta charset="utf-8"><title>Liên kết không hợp lệ</title><div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center"><h2>Liên kết không hợp lệ</h2><p>Liên kết tắt thông báo này không đúng hoặc không còn hiệu lực. Bạn có thể tắt thông báo trong trang cá nhân.</p></div>'
  );
});

// The public profile is addressed by users.public_id (random, see db.js), never
// by the sequential row id: a numeric ?user=1 no longer resolves, so profiles
// cannot be enumerated by counting. Anything that is not 16 hex characters is
// refused before it reaches the database.
const PUBLIC_ID_RE = /^[0-9a-f]{16}$/;
function userIdFromPublicId(publicId) {
  if (!PUBLIC_ID_RE.test(String(publicId || ''))) return null;
  const row = db.prepare('SELECT id FROM users WHERE public_id = ? AND deleted_at IS NULL').get(publicId);
  return row ? row.id : null;
}

// GET /api/users/:publicId - public profile info (name, avatar, bio - no email,
// role or row id exposed). Shown when a reader clicks a commenter's name/avatar.
// Profiles are for signed-in members only (user's choice, 2026-10-05) - name,
// bio, location, phone and social links alike; a guest gets 401 and
// profile.html shows its sign-in card.
router.get('/:id', requireAuth, (req, res) => {
  const id = userIdFromPublicId(req.params.id);
  const user = id
    ? db
        .prepare(
          'SELECT public_id, name, avatar_url, cover_image, bio, status_text, location, phone, social_links, created_at, deleted_at FROM users WHERE id = ?'
        )
        .get(id)
    : null;
  // A trashed account has no public profile: their posts stay up under their
  // name, but the card a reader opens from a comment must not lead to a person
  // the site has put in the bin.
  if (!user || user.deleted_at) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });

  const postCount = db
    .prepare("SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND status = 'published' AND deleted_at IS NULL")
    .get(id).c;

  const { social_links: socialJson, deleted_at: _deleted, ...pub } = user;
  const out = { ...pub, postCount };
  out.social_links = parseSocialLinks(socialJson);
  res.set('Cache-Control', 'private, no-store');
  res.json({ user: out });
});

// GET /api/users/:id/posts - that user's published posts (for the public
// profile view page)
router.get('/:id/posts', requireAuth, (req, res) => {
  const id = userIdFromPublicId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const posts = db
    .prepare(
      `SELECT id, title, slug, excerpt, cover_image, tag, views, created_at
       FROM posts WHERE author_id = ? AND status = 'published' AND deleted_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(id);
  attachExcerptFallback(posts);
  res.json({ posts });
});

module.exports = router;
