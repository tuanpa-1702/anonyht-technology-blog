const db = require('./db');

// "Bài viết liên quan" under an article - one scorer for both the server
// render (ssr-content.js) and the client refresh (GET /api/posts/:id/related),
// so the cards a crawler reads are the cards a reader sees.
//
// Matching only on an identical tag missed most real neighbours: tags here are
// typed by hand ("Network" vs "NETWORK/MONITORING", "System/Server" with one
// post in it), while hashtags and title words carry the actual subject
// (proxmox, cloudflared tunnel, ...). Each candidate is scored:
//
//   shared hashtag                 +4 each
//   same tag (case-insensitive)    +3
//   tag shares a segment           +1   ("network" in "NETWORK/MONITORING")
//   shared title keyword           +1 each, at most 3
//
// Highest score first, newest first among equals; anything scoring 0 is only
// used to top the list up, newest first, and is not counted as "related".

const CANDIDATES_SQL = `SELECT id, title, slug, cover_image, tag, hashtags, views, created_at FROM posts
  WHERE status = 'published' AND deleted_at IS NULL AND id <> ? ORDER BY created_at DESC, id DESC LIMIT 300`;

// Words that say nothing about a post's subject - common Vietnamese function
// words and the "how to" phrasing that half the titles open with.
const STOP = new Set(
  ('cach huong dan chi tiet cai dat cau hinh trien khai toi uu them mot lop tren duoi trong ngoai cho voi '
    + 'cua cac nhung la gi nao the nay khi neu bang nho vao len ra den tu ve qua sang luu dung dua chi '
    + 'khong con hay hoac va thi ma de duoc bi rat nhieu it moi cung lai van nhanh dam bao gui that '
    + 'setup the and for with your how what').split(' ')
);

const fold = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');

function keywords(title) {
  return new Set(fold(title).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

function hashtagSet(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw || '[]');
    } catch (e) {
      list = [];
    }
  }
  return new Set((Array.isArray(list) ? list : []).map((h) => fold(h).replace(/^#/, '').trim()).filter(Boolean));
}

const tagParts = (tag) => new Set(fold(tag).split(/[^a-z0-9]+/).filter(Boolean));

// -> [{ post, score }], at most `want`, score > 0 first.
function relatedPosts(post, want = 3) {
  const rows = db.prepare(CANDIDATES_SQL).all(post.id);
  const tags = hashtagSet(post.hashtags);
  const words = keywords(post.title);
  const tag = fold(post.tag).trim();
  const parts = tagParts(post.tag);

  const scored = rows.map((p, order) => {
    let score = 0;
    for (const h of hashtagSet(p.hashtags)) if (tags.has(h)) score += 4;
    const t = fold(p.tag).trim();
    if (tag && t === tag) score += 3;
    else if (tag && [...tagParts(p.tag)].some((x) => parts.has(x))) score += 1;
    let kw = 0;
    for (const w of keywords(p.title)) if (words.has(w)) kw += 1;
    score += Math.min(kw, 3);
    return { post: p, score, order };
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, want).map(({ post: p, score }) => {
    const { hashtags, ...rest } = p;
    return { post: rest, score };
  });
}

module.exports = { relatedPosts };
