const crypto = require('crypto');
const db = require('./db');
const { getSiteName } = require('./site');
const { attachExcerptFallback } = require('./excerpt');
const { publicOrigin, escapeXml } = require('./sitemap');

// GET /rss.xml (and /feed.xml) - RSS 2.0 of the newest published posts.
//
// Built from the same visibility rule as the sitemap (published, not in the
// bin), so a draft never leaks into a reader app. Each item carries the
// excerpt and the cover, not the full article: the feed announces a post and
// sends the reader to the page, where the comments, TOC and related links are.
// Cached by the same kind of fingerprint as sitemap.js - no timer, an edit or
// a publish is in the next response.

const LIMIT = 20;
const CACHE_MAX_AGE = 1800;

const ITEMS_SQL = `
  SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags, p.created_at, p.updated_at,
         u.name AS author_name
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
   WHERE p.status = 'published' AND p.deleted_at IS NULL
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT ${LIMIT}`;

const STATS_SQL = `SELECT COUNT(*) AS n, MAX(updated_at) AS u, MAX(created_at) AS c
  FROM posts WHERE status = 'published' AND deleted_at IS NULL`;

const setting = (key) => {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '').trim();
  } catch (e) {
    return '';
  }
};

// DB rows are UTC "YYYY-MM-DD HH:MM:SS"; RSS wants RFC 822.
function rfc822(value) {
  const d = new Date(String(value || '').replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : d.toUTCString();
}

const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

function buildRss() {
  const origin = publicOrigin();
  const site = getSiteName();
  const about = setting('home_intro_text').replace(/\s+/g, ' ') || `Bài viết mới nhất từ ${site}`;
  const posts = attachExcerptFallback(db.prepare(ITEMS_SQL).all());

  const items = posts
    .filter((p) => String(p.slug || '').trim())
    .map((p) => {
      const link = `${origin}/post.html?slug=${encodeURIComponent(p.slug)}`;
      const cover = /^\/uploads\/[^/?#]+$/.test(p.cover_image || '')
        ? `${origin}/uploads/w1280/${p.cover_image.slice('/uploads/'.length)}`
        : /^https?:\/\//.test(p.cover_image || '') ? p.cover_image : '';
      let tags = [];
      try {
        tags = JSON.parse(p.hashtags || '[]');
      } catch (e) {}
      const cats = [p.tag, ...(Array.isArray(tags) ? tags : [])].filter(Boolean);
      const html = `${cover ? `<p><img src="${escapeXml(cover)}" alt="${escapeXml(p.title)}"></p>` : ''}<p>${escapeXml(p.excerpt || '')}</p><p><a href="${escapeXml(link)}">Đọc tiếp trên ${escapeXml(site)}</a></p>`;
      return [
        '    <item>',
        `      <title>${escapeXml(p.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <pubDate>${rfc822(p.created_at)}</pubDate>`,
        p.author_name ? `      <dc:creator>${escapeXml(p.author_name)}</dc:creator>` : '',
        ...cats.map((c) => `      <category>${escapeXml(c)}</category>`),
        `      <description>${escapeXml(p.excerpt || '')}</description>`,
        `      <content:encoded>${cdata(html)}</content:encoded>`,
        cover ? `      <media:content url="${escapeXml(cover)}" medium="image"/>` : '',
        '    </item>',
      ].filter(Boolean).join('\n');
    });

  const latest = posts[0] ? rfc822(posts[0].updated_at || posts[0].created_at) : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
    '  <channel>',
    `    <title>${escapeXml(site)}</title>`,
    `    <link>${escapeXml(origin)}/</link>`,
    `    <atom:link href="${escapeXml(origin)}/rss.xml" rel="self" type="application/rss+xml"/>`,
    `    <description>${escapeXml(about)}</description>`,
    '    <language>vi</language>',
    latest ? `    <lastBuildDate>${latest}</lastBuildDate>` : '',
    items.join('\n'),
    '  </channel>',
    '</rss>',
    '',
  ].filter(Boolean).join('\n');
}

let cache = null; // { key, xml, etag }

function rssHandler(req, res) {
  try {
    const s = db.prepare(STATS_SQL).get();
    const key = [s.n, s.u, s.c, getSiteName(), setting('home_intro_text')].join('|');
    if (!cache || cache.key !== key) {
      const xml = buildRss();
      cache = { key, xml, etag: 'W/"rss-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '"' };
    }
  } catch (e) {
    console.error('[rss] Không tạo được RSS:', e.message);
    if (!cache) return res.status(503).set('Cache-Control', 'no-store').send('');
  }
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('ETag', cache.etag);
  res.setHeader('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);
  res.send(cache.xml);
}

module.exports = { rssHandler, buildRss };
