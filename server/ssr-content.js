// Server-side first paint of the CONTENT a search engine indexes.
//
// Every list and every article on this site used to be drawn by JavaScript
// after load: the raw HTML of index.html and viewall.html carried zero links to
// a post, and post.html carried "Đang tải bài viết..." instead of the article.
// Google does run JavaScript, but in a separate, much later rendering queue, so
// for a young site the posts were reachable only through sitemap.xml - orphan
// URLs with nothing linking to them - and sat in Search Console as "Discovered -
// currently not indexed" with no crawl at all.
//
// This module writes the same content into the HTML before it leaves the
// server, in the SAME markup the page scripts render (home.js moreCard(),
// viewall.js postCard(), api.js renderContentBlocksHtml()), so the scripts'
// own re-render a moment later lands on an identical page:
//   - index.html   the newest posts in #more-grid (section left hidden - home.js
//                  decides which of them it shows) and the lead title as a link
//   - viewall.html the requested page of the list in #viewall-grid, plus the
//                  pager as real <a href="?page=N"> links, so every post is two
//                  plain links away from the homepage
//   - post.html    title, tag, author, date, standfirst, cover and the body
//
// Every value is escaped here; the only markup passed through is rich-text
// paragraph HTML, re-run through sanitizeRichHtml() on the way out even though
// routes/posts.js already sanitized it on save.
const db = require('./db');
const { relatedPosts } = require('./related');
const { attachExcerptFallback } = require('./excerpt');
const { sanitizeRichHtml } = require('./sanitize-html');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const postUrl = (slug) => `/post.html?slug=${encodeURIComponent(slug)}`;

// api.js derivUrl(): an original upload maps to its thumb/w1280 derivative,
// anything else (an external cover) passes through.
function derivUrl(url, kind) {
  const u = String(url ?? '').trim();
  const m = u.match(/^\/uploads\/([^/?#]+)$/);
  if (!m) return u;
  return `/uploads/${kind === 'thumb' ? 'thumb' : 'w1280'}/${m[1]}`;
}

// DB rows are "YYYY-MM-DD HH:MM:SS" UTC without a zone marker.
function parseDbDate(s) {
  const d = new Date(String(s || '').replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}
// viewall.js formatDateVi() / post.js formatPostDate(): "08 tháng 9, 2026".
function dateVi(s) {
  const d = parseDbDate(s);
  return d ? d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).replace(/\//g, '.') : '';
}
// api.js timeAgoVi().
function timeAgoVi(s) {
  const d = parseDbDate(s);
  if (!d) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return dateVi(s);
}

function parseHashtags(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((h) => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

const LIST_COLUMNS = `p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags,
         p.views, p.created_at, p.pinned_at, u.name AS author_name, u.avatar_url AS author_avatar`;

// ---- index.html ----------------------------------------------------------

// The homepage rows, the SAME markup public/js/home.js renders (homeRow /
// rankRow / topicRow there) - change one, change the other.
const tagUrl = (tag) => `/viewall.html?tag=${encodeURIComponent(tag)}`;
const shortDate = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};
const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2h-4.5v6L12 21l-.5-1v-6H7v-2l3-3-1-5z"/></svg>';
function homeRow(p) {
  return `<li class="pro-row${p.pinned_at ? ' is-pinned' : ''}">
  <time class="pro-row-date" datetime="${escapeHtml(String(p.created_at || '').slice(0, 10))}">${shortDate(p.created_at)}</time>
  <div class="pro-row-main">
    ${p.pinned_at ? `<span class="pro-pin">${PIN_SVG}Đã ghim</span>` : ''}<h3 class="pro-row-title"><a class="ed-card-link" href="${escapeHtml(postUrl(p.slug))}">${escapeHtml(p.title)}</a></h3>
    <p class="pro-row-dek">${escapeHtml(p.excerpt || '')}</p>
  </div>
  <a class="pro-row-tag" href="${escapeHtml(tagUrl(p.tag))}">${escapeHtml(p.tag)}</a>
</li>`;
}
function rankRow(p, i) {
  return `<li class="pro-rank-item"><span class="pro-rank-n">${i + 1}</span><div class="min-w-0"><a class="ed-card-link" href="${escapeHtml(postUrl(p.slug))}">${escapeHtml(p.title)}</a><span class="pro-rank-meta">${(Number(p.views) || 0).toLocaleString('vi-VN')} lượt đọc</span></div></li>`;
}
function topicRow(t) {
  return `<li><a href="${escapeHtml(tagUrl(t.tag))}"><span>${escapeHtml(t.tag)}</span><span class="pro-count">${t.count}</span></a></li>`;
}

function fillHomeLinks(html) {
  if (!html.includes('id="more-grid"')) return html;
  let rows, mostRead, tagRows;
  try {
    rows = db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
          WHERE p.status = 'published' AND p.deleted_at IS NULL
          ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.created_at DESC, p.id DESC LIMIT 7`
      )
      .all();
    mostRead = db
      .prepare(
        `SELECT p.title, p.slug, p.views FROM posts p
          WHERE p.status = 'published' AND p.deleted_at IS NULL
          ORDER BY p.views DESC, p.created_at DESC LIMIT 5`
      )
      .all();
    tagRows = db.prepare("SELECT tag FROM posts WHERE status = 'published' AND deleted_at IS NULL").all();
  } catch {
    return html;
  }

  if (!rows.length) return html;
  attachExcerptFallback(rows);
  const [lead, ...rest] = rows;

  // The feature's links (its text was filled by render-html.js fillLeadCard()).
  const leadUrl = escapeHtml(postUrl(lead.slug));
  html = html
    .replace(/(<h2 class="pro-feature-title" id="latest-title">)([^<]*)(<\/h2>)/, (m, open, text, close) =>
      text ? `${open}<a class="ed-card-link" href="${leadUrl}">${text}</a>${close}` : m
    )
    .replace('href="/viewall.html" id="latest-tag"', `href="${escapeHtml(tagUrl(lead.tag))}" id="latest-tag"`)
    .replace('href="/viewall.html" id="latest-more"', `href="${leadUrl}" id="latest-more"`)
    .replace('href="/viewall.html" tabindex="-1"', `href="${leadUrl}" tabindex="-1"`);

  html = html.replace('id="more-grid"></ol>', `id="more-grid">${rest.map(homeRow).join('')}</ol>`);

  if (mostRead.length >= 2) {
    html = html
      .replace('id="latest-secondary"></ol>', `id="latest-secondary">${mostRead.map(rankRow).join('')}</ol>`)
      .replace('<section id="most-read-block" class="hidden"', '<section id="most-read-block"');
  }

  // GET /api/posts/tags's folding: case variants count as one, first spelling wins.
  const counts = new Map();
  for (const r of tagRows) {
    const tag = String(r.tag ?? '').trim();
    if (!tag) continue;
    const hit = counts.get(tag.toLowerCase());
    if (hit) hit.count += 1;
    else counts.set(tag.toLowerCase(), { tag, count: 1 });
  }
  // Top five by post count (newest spelling wins ties) - the homepage shows a
  // short "Chủ đề" list, the full set is on viewall. Must match home.js's slice.
  const TOPIC_MAX = 5;
  const tags = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi'))
    .slice(0, TOPIC_MAX);
  if (tags.length) {
    html = html
      .replace('id="topic-list"></ul>', `id="topic-list">${tags.map(topicRow).join('')}</ul>`)
      .replace('<section id="topics-block" class="hidden"', '<section id="topics-block"');
  }
  return html;
}

// ---- viewall.html --------------------------------------------------------

const VIEWALL_PAGE_SIZE = 6; // viewall.js PAGE_SIZE
const VIEWALL_FALLBACK_COVER = 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=800';

// viewall.js postCard(), with the title as a real link.
function viewallCard(p, defaultCover) {
  const cover = p.cover_image || defaultCover;
  const coverThumb = derivUrl(cover, 'thumb');
  const coverMid = derivUrl(cover, 'w1280');
  const srcset =
    coverThumb === coverMid
      ? ''
      : ` srcset="${escapeHtml(coverThumb)} 480w, ${escapeHtml(coverMid)} 1280w" sizes="(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 92vw"`;
  const hashtags = parseHashtags(p.hashtags)
    .slice(0, 3)
    .map(
      (h) =>
        `<span class="inline-flex items-center py-1 ed-hashtag font-body-sm text-body-sm hover:underline cursor-pointer" data-tag="${escapeHtml(h)}">#${escapeHtml(h)}</span>`
    )
    .join('');
  return `
  <article class="reveal-on-scroll ed-panel rounded overflow-hidden group cursor-pointer flex flex-col" data-slug="${escapeHtml(p.slug)}">
    <div class="aspect-[16/9] sm:aspect-auto sm:h-48 overflow-hidden relative flex-shrink-0">
      <img alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" src="${escapeHtml(coverThumb)}"${srcset} loading="lazy" decoding="async">
      <div class="absolute top-sm left-sm ed-chip ed-chip--on-media cursor-pointer" data-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</div>
    </div>
    <div class="p-sm sm:p-md flex flex-col flex-grow">
      <div class="ed-icon-faint font-label-md text-label-md mb-xs">${escapeHtml(dateVi(p.created_at))} · ${Number(p.views) || 0} lượt xem</div>
      <h2 class="ed-story-title--sm mb-sm line-clamp-2"><a class="ed-card-link" href="${escapeHtml(postUrl(p.slug))}">${escapeHtml(p.title)}</a></h2>
      <p class="ed-excerpt line-clamp-3">${escapeHtml(p.excerpt || '')}</p>
      ${hashtags ? `<div class="mt-md flex flex-wrap gap-2">${hashtags}</div>` : ''}
    </div>
  </article>`;
}

// viewall.js pagerWindow().
function pagerWindow(current, total) {
  // At most five page numbers (user's rule, 2026-10-04): every page while there
  // are five or fewer; beyond that the first and last page always, the rest a
  // run around the current page, and '…' wherever pages are skipped.
  //   1 2 3 4 … 9   |   1 … 4 5 6 … 9   |   1 … 6 7 8 9
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  let pages;
  if (current <= 3) pages = [1, 2, 3, 4, total];
  else if (current >= total - 2) pages = [1, total - 3, total - 2, total - 1, total];
  else pages = [1, current - 1, current, current + 1, total];
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i && pages[i] - pages[i - 1] > 1) out.push('gap');
    out.push(pages[i]);
  }
  return out;
}

// viewall.js renderPager(), as links: the same classes and data-page (so the
// script's click handler still takes over once it runs), plus an href a
// crawler can follow to reach page 2, 3, ... and every post on them.
function pagerLinks(cur, pages, tag, sort) {
  const href = (n) => {
    const qs = new URLSearchParams();
    if (tag) qs.set('tag', tag);
    if (sort === 'views') qs.set('sort', 'views');
    if (n > 1) qs.set('page', String(n));
    const s = qs.toString();
    return `/viewall.html${s ? `?${s}` : ''}`;
  };
  const arrow = (target, label, icon, disabled) =>
    disabled
      ? `<button type="button" class="pager-btn" data-page="${target}" disabled aria-label="${label}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span></button>`
      : `<a class="pager-btn" href="${escapeHtml(href(target))}" data-page="${target}" aria-label="${label}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span></a>`;
  return (
    arrow(cur - 1, 'Trang trước', 'arrow_back', cur <= 1) +
    pagerWindow(cur, pages)
      .map((p) =>
        p === 'gap'
          ? '<span class="pager-gap" aria-hidden="true">…</span>'
          : p === cur
            ? `<a class="pager-btn is-current" href="${escapeHtml(href(p))}" data-page="${p}" aria-current="page">${p}</a>`
            : `<a class="pager-btn" href="${escapeHtml(href(p))}" data-page="${p}">${p}</a>`
      )
      .join('') +
    arrow(cur + 1, 'Trang sau', 'arrow_forward', cur >= pages)
  );
}

function fillViewallList(html, query, settings) {
  if (!html.includes('id="viewall-grid"')) return html;
  // A search result page is not something to index; leave it to the script.
  if (typeof query.q === 'string' && query.q.trim()) return html;
  const tag = typeof query.tag === 'string' ? query.tag : '';
  const sort = query.sort === 'views' ? 'views' : 'newest';
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  const where = [`p.status = 'published'`, 'p.deleted_at IS NULL'];
  const params = {};
  if (tag) {
    where.push('(p.tag = @tag OR p.hashtags LIKE @tagLike)');
    params.tag = tag;
    params.tagLike = `%"${tag}"%`;
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderBy = sort === 'views' ? 'p.views DESC, p.id DESC' : 'p.created_at DESC, p.id DESC';

  let total;
  let rows;
  try {
    total = db.prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`).get(params).n;
    const pages = Math.max(1, Math.ceil(total / VIEWALL_PAGE_SIZE));
    if (page > pages) return html; // stale ?page=: viewall.js steps back itself
    rows = db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
          ${whereSql} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: VIEWALL_PAGE_SIZE, offset: (page - 1) * VIEWALL_PAGE_SIZE });
  } catch {
    return html;
  }
  if (!rows.length) return html;
  attachExcerptFallback(rows);

  const defaultCover = String(settings.default_cover || '').trim() || VIEWALL_FALLBACK_COVER;
  const cards = rows.map((p) => viewallCard(p, defaultCover)).join('');
  // data-ssr tells viewall.js the first page is already on screen, so its first
  // load() does not blank it to "Đang tải bài viết..." and back.
  html = html.replace(
    /(<div class="[^"]*" id="viewall-grid")>[\s\S]*?<\/div>/,
    (m, open) => `${open} data-ssr="1">${cards}\n</div>`
  );

  const pages = Math.ceil(total / VIEWALL_PAGE_SIZE);
  if (pages > 1) {
    html = html.replace(
      '<nav aria-label="Chuyển trang" class="mt-lg hidden" id="viewall-pager"></nav>',
      `<nav aria-label="Chuyển trang" class="mt-lg" id="viewall-pager">${pagerLinks(page, pages, tag, sort)}</nav>`
    );
  }
  return html;
}

// ---- post.html -----------------------------------------------------------

// api.js renderContentBlocksHtml(), for the first paint. post.js replaces the
// body with its own full render (indent/quote normalisation, derivative image
// URLs) as soon as it runs; what matters here is that the TEXT, headings and
// images are in the HTML a crawler receives.
// post.js openArticleLinksInNewTab(), for the first paint: article links open
// in a new tab, except in-page jumps and mailto:/tel:.
function linksInNewTab(html) {
  return html.replace(/<a\b([^>]*)>/g, (tag, attrs) => {
    const href = (attrs.match(/\bhref="([^"]*)"/) || [])[1];
    if (!href || /^\s*(#|mailto:|tel:)/i.test(href) || /\btarget=/.test(attrs)) return tag;
    const rel = /\brel="/.test(attrs) ? '' : ' rel="noopener noreferrer"';
    return `<a${attrs} target="_blank"${rel}>`;
  });
}

function renderBodyHtml(content) {
  let blocks;
  try {
    const parsed = JSON.parse(content);
    blocks = Array.isArray(parsed) && parsed.every((b) => b && typeof b === 'object' && b.type) ? parsed : null;
  } catch {
    blocks = null;
  }
  if (!blocks) {
    blocks = String(content ?? '')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((text) => ({ type: 'paragraph', text }));
  }
  return blocks
    .map((b) => {
      if (b.type === 'heading') {
        const tag = b.level === 1 ? 'h1' : b.level === 3 ? 'h3' : 'h2';
        const sizeClass =
          b.level === 1 ? 'text-3xl sm:text-4xl md:text-5xl' : b.level === 3 ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl md:text-3xl';
        return `<${tag} class="font-headline-md ${sizeClass} text-on-background mt-10 mb-4">${escapeHtml(b.text || '')}</${tag}>`;
      }
      if (b.type === 'image' && b.url) {
        const caption = b.caption ? `<figcaption class="text-sm text-on-surface-variant mt-2">${escapeHtml(b.caption)}</figcaption>` : '';
        return `<figure class="my-8"><img src="${escapeHtml(derivUrl(b.url, 'w1280'))}" alt="${escapeHtml(b.caption || '')}" class="w-full rounded-xl" loading="lazy" decoding="async">${caption}</figure>`;
      }
      if (b.type === 'embed') return ''; // an iframe adds nothing to index; post.js draws it
      if (b.type === 'layout') return renderLayoutBlock(b);
      if (b.type === 'paragraph' && b.html !== undefined) {
        return `<div class="rich-text-block">${sanitizeRichHtml(String(b.html || ''))}</div>`;
      }
      if (b.numbered) {
        const items = String(b.text || '')
          .split('\n')
          .filter((line) => line.trim().length)
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('');
        return `<ol class="list-decimal pl-8 mb-6 space-y-2">${items}</ol>`;
      }
      return `<p>${escapeHtml(b.text || '')}</p>`;
    })
    .join('');
}

// "Bố cục ảnh" - public/js/api.js renderLayoutBlockHtml(), same markup.
const LAYOUTS = {
  side: { count: 1, text: true },
  'side-right': { count: 1, text: true },
  wide: { count: 1, text: false },
  split: { count: 1, text: true },
  'split-reverse': { count: 1, text: true },
  feature: { count: 3, text: false },
  pair: { count: 2, text: false },
  masonry: { count: 12, text: false },
};
function layoutImg(im, fallbackAlt = '') {
  const w = Number(im.width);
  const h = Number(im.height);
  const dims = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? ` width="${w}" height="${h}"` : '';
  return `<img src="${escapeHtml(im.url)}" alt="${escapeHtml(String(im.alt || '').trim() || fallbackAlt)}"${dims} loading="lazy" decoding="async">`;
}
function renderLayoutBlock(b) {
  const id = Object.prototype.hasOwnProperty.call(LAYOUTS, b.layout) ? b.layout : 'wide';
  const def = LAYOUTS[id];
  const imgs = (Array.isArray(b.images) ? b.images : []).filter((im) => im && im.url).slice(0, def.count);
  if (!imgs.length) return '';
  const caption = b.caption ? `<figcaption class="ilay-caption">${escapeHtml(b.caption)}</figcaption>` : '';
  const text = def.text ? `<div class="ilay-text rich-text-block">${sanitizeRichHtml(String(b.html || ''))}</div>` : '';
  const img = (im) => layoutImg(im, b.caption || '');
  const one = `<figure>${img(imgs[0])}${caption}</figure>`;
  if (id === 'side' || id === 'side-right') return `<div class="ilay img-side${id === 'side-right' ? ' img-side--right' : ''}">${one}${text}</div>`;
  if (id === 'split' || id === 'split-reverse') return `<div class="ilay split${id === 'split-reverse' ? ' split--reverse' : ''}">${one}${text}</div>`;
  if (id === 'wide') return `<figure class="ilay img-wide">${img(imgs[0])}${caption}</figure>`;
  return `<figure class="ilay gallery-${id}"><div class="ilay-grid">${imgs.map(img).join('')}</div>${caption}</figure>`;
}

const POST_BODY_SQL = `
  SELECT p.id, p.title, p.slug, p.excerpt, p.content, p.cover_image, p.tag, p.hashtags, p.created_at,
         u.name AS author_name
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
   WHERE p.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL`;

const POST_FALLBACK_COVER = 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1200';

// Returns { html, found }. found === false is the caller's cue to answer 404.
// Images with no alt (a picture pasted into a paragraph, an image block with
// no caption) get "<title> - ảnh N", so search engines and screen readers
// have something to go on. post.js fillMissingAlts() does the same.
function fillMissingAlts(html, title) {
  let n = 0;
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    n += 1;
    if (/\balt="[^"]*[^"\s][^"]*"/.test(tag)) return tag;
    const alt = escapeHtml(`${title} - ảnh ${n}`);
    return /\balt="/.test(tag) ? tag.replace(/\balt="[^"]*"/, `alt="${alt}"`) : tag.replace('<img', `<img alt="${alt}"`);
  });
}

// post.js loadRelated(), for the first paint: the three best-matching posts
// (server/related.js scores hashtags, tag and title words), topped up with the
// newest - real <a href> links in the HTML a crawler reads, rather than links
// that only exist once a script has run.
function relatedHtml(post, defaultCover) {
  const ranked = relatedPosts(post, 3);
  if (!ranked.length) return null;
  const picks = ranked.map((r) => r.post);
  const same = ranked.filter((r) => r.score > 0).length;
  const title = same === picks.length ? 'Bài viết cùng chủ đề' : same ? 'Bài viết liên quan' : 'Đọc tiếp';
  const cards = picks
    .map(
      (p) => `<a class="related-card glass-card" href="/post.html?slug=${encodeURIComponent(p.slug)}">
    <span class="related-thumb"><img src="${escapeHtml(derivUrl(p.cover_image || defaultCover, 'thumb'))}" alt="${escapeHtml(p.title)}" loading="lazy" decoding="async"></span>
    <span class="related-body">
      ${p.tag ? `<span class="related-tag">${escapeHtml(p.tag)}</span>` : ''}
      <span class="related-title">${escapeHtml(p.title)}</span>
      <span class="related-facts">${escapeHtml(dateVi(p.created_at))} · ${Number(p.views) || 0} lượt xem</span>
    </span>
  </a>`
    )
    .join('');
  return { title, cards };
}

function fillPostBody(html, slug, settings) {
  let post;
  try {
    post = db.prepare(POST_BODY_SQL).get(slug);
  } catch {
    return { html, found: true }; // a database hiccup is not a "not found"
  }
  if (!post) return { html, found: false };

  const fillText = (id, text) =>
    (html = html.replace(new RegExp(`(id="${id}"[^>]*>)(</)`), (m, open, close) => `${open}${escapeHtml(text)}${close}`));

  fillText('post-title', post.title || '');
  fillText('post-tag', post.tag || '');
  fillText('post-author-name', post.author_name || 'Ẩn danh');
  fillText('post-date', dateVi(post.created_at));

  // Standfirst: the author's own excerpt only (post.js shows nothing otherwise).
  const excerpt = sanitizeRichHtml(String(post.excerpt || '')).trim();
  if (excerpt) {
    html = html.replace(
      '<div class="hidden ed-standfirst" id="post-excerpt"></div>',
      `<div class="ed-standfirst" id="post-excerpt">${excerpt}</div>`
    );
  }

  const cover = derivUrl(post.cover_image || String(settings.default_cover || '').trim() || POST_FALLBACK_COVER, 'w1280');
  html = html.replace(/<img\b([^>]*)id="post-cover"([^>]*)>/, (tag) =>
    tag.includes('src=') ? tag : tag.replace('<img', `<img src="${escapeHtml(cover)}"`).replace('alt=""', `alt="${escapeHtml(post.title || '')}"`)
  );

  html = html.replace(
    /(<div class="prose-content[^"]*" id="post-body">)(<\/div>)/,
    (m, open, close) => `${open}${fillMissingAlts(linksInNewTab(renderBodyHtml(post.content)), post.title || '')}${close}`
  );

  try {
    const related = relatedHtml(post, String(settings.default_cover || '').trim() || POST_FALLBACK_COVER);
    if (related) {
      html = html
        .replace('<section class="related-section hidden" id="related-section"', '<section class="related-section" id="related-section"')
        .replace('<h3 class="font-headline-sm text-headline-sm text-on-surface" id="related-title">Bài viết liên quan</h3>', `<h3 class="font-headline-sm text-headline-sm text-on-surface" id="related-title">${related.title}</h3>`)
        .replace('<div class="related-grid" id="related-grid"></div>', `<div class="related-grid" id="related-grid">${related.cards}</div>`);
    }
  } catch {
    // suggestions are optional; post.js fills them anyway
  }

  // The article is real content now: show it and drop the loading line, the
  // same two toggles post.js makes once its fetch lands.
  html = html.replace('<p id="loading-msg" class="text-on-surface-variant text-center">', '<p id="loading-msg" class="hidden text-on-surface-variant text-center">');
  html = html.replace('<div id="post-content" class="hidden flex flex-col gap-lg">', '<div id="post-content" class="flex flex-col gap-lg">');
  return { html, found: true };
}

module.exports = { fillHomeLinks, fillViewallList, fillPostBody };
