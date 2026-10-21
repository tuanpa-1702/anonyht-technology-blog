document.getElementById('footer-year').textContent = new Date().getFullYear();

// Surface a clear message if the Google / GitHub OAuth callback failed
(function showAuthErrorIfAny() {
  const params = new URLSearchParams(window.location.search);
  const AUTH_ERRORS = {
    google: 'Đăng nhập bằng Google thất bại. Vui lòng thử lại hoặc dùng email/mật khẩu.',
    github: 'Đăng nhập bằng GitHub thất bại. Vui lòng thử lại hoặc dùng email/mật khẩu.',
    github_email: 'Tài khoản GitHub của bạn chưa có email đã xác minh. Hãy xác minh email trong GitHub (Settings → Emails) rồi thử lại.',
    github_disabled: 'Tài khoản này đã bị vô hiệu hoá.',
    github_deleted: 'Tài khoản này đã bị xoá.',
  };
  const code = params.get('auth_error');
  if (code && AUTH_ERRORS[code]) {
    alert(AUTH_ERRORS[code]);
    params.delete('auth_error');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
  }
})();

// The homepage shows the newest post as the feature, then "Mới nhất" as a
// dated list beside "Chủ đề" and "Đọc nhiều" - see loadHome(). Browsing, filtering by
// tag and searching all live on /viewall.html, so a ?tag= / ?q= link that
// still points here (older bookmarks, tag chips on post pages) is forwarded
// there instead of being rendered on the homepage.
(function forwardFiltersToViewAll() {
  const params = new URLSearchParams(window.location.search);
  const tag = params.get('tag');
  const q = params.get('q');
  if (!tag && !q) return;
  const target = new URLSearchParams();
  if (tag) target.set('tag', tag);
  if (q) target.set('q', q);
  window.location.replace(`/viewall.html?${target}`);
})();

// Homepage rows (2026-10-05 layout, css/theme-pro.css). server/ssr-content.js
// renders the SAME markup for the first paint (homeRow / rankRow / topicRow) -
// change one, change the other.
// p.excerpt is plain text from the API (attachExcerptFallback, server/excerpt.js),
// escaped like everything else here.
const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2h-4.5v6L12 21l-.5-1v-6H7v-2l3-3-1-5z"/></svg>';
const postHref = (slug) => `/post.html?slug=${encodeURIComponent(slug)}`;
const tagHref = (tag) => `/viewall.html?tag=${encodeURIComponent(tag)}`;
// 'YYYY-MM-DD HH:MM:SS' -> 'dd.mm.yyyy' (the list's date column, monospaced).
const shortDate = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

function homeRow(p) {
  return `<li class="pro-row${p.pinned_at ? ' is-pinned' : ''}">
  <time class="pro-row-date" datetime="${escapeHtml(String(p.created_at || '').slice(0, 10))}">${shortDate(p.created_at)}</time>
  <div class="pro-row-main">
    ${p.pinned_at ? `<span class="pro-pin">${PIN_SVG}Đã ghim</span>` : ''}<h3 class="pro-row-title"><a class="ed-card-link" href="${postHref(p.slug)}">${escapeHtml(p.title)}</a></h3>
    <p class="pro-row-dek">${escapeHtml(p.excerpt || '')}</p>
  </div>
  <a class="pro-row-tag" href="${tagHref(p.tag)}">${escapeHtml(p.tag)}</a>
</li>`;
}

function rankRow(p, i) {
  return `<li class="pro-rank-item"><span class="pro-rank-n">${i + 1}</span><div class="min-w-0"><a class="ed-card-link" href="${postHref(p.slug)}">${escapeHtml(p.title)}</a><span class="pro-rank-meta">${(Number(p.views) || 0).toLocaleString('vi-VN')} lượt đọc</span></div></li>`;
}

function topicRow(t) {
  return `<li><a href="${tagHref(t.tag)}"><span>${escapeHtml(t.tag)}</span><span class="pro-count">${Number(t.count) || 0}</span></a></li>`;
}

async function loadHome() {
  const loading = document.getElementById('latest-loading');
  const errorEl = document.getElementById('latest-error');
  const gridEl = document.getElementById('latest-grid');
  const emptyEl = document.getElementById('posts-empty');

  try {
    // Three independent lists fetched together: newest (feature + "Mới nhất"),
    // most viewed ("Đọc nhiều") and the topic counts ("Chủ đề").
    const [{ posts: newest }, { posts: mostRead }, tagsRes] = await Promise.all([
      API.listPosts({ limit: 7, sort: 'home' }),
      API.listPosts({ limit: 5, sort: 'views' }),
      API.listTags().catch(() => ({ tags: [] })),
    ]);
    loading.classList.add('hidden');

    if (!newest.length) {
      emptyEl.classList.remove('hidden');
      return;
    }

    const [lead, ...rest] = newest;
    gridEl.classList.remove('hidden');
    // No default cover any more: a lead without its own image shows text only.
    const media = document.getElementById('latest-media');
    if (lead.cover_image) {
      document.getElementById('latest-image').src = derivUrl(lead.cover_image, 'w1280');
      media.classList.remove('hidden');
      media.href = postHref(lead.slug);
    } else {
      media.classList.add('hidden');
    }
    gridEl.classList.toggle('pro-feature--text', !lead.cover_image);
    document.getElementById('latest-pin').classList.toggle('hidden', !lead.pinned_at);
    const tagEl = document.getElementById('latest-tag');
    tagEl.textContent = lead.tag;
    tagEl.href = tagHref(lead.tag);
    // A real link: crawlers follow <a href> only.
    document.getElementById('latest-title').innerHTML = `<a class="ed-card-link" href="${postHref(lead.slug)}">${escapeHtml(lead.title)}</a>`;
    document.getElementById('latest-excerpt').textContent = lead.excerpt || '';
    document.getElementById('latest-date').textContent = shortDate(lead.created_at);
    document.getElementById('latest-more').href = postHref(lead.slug);

    document.getElementById('more-grid').innerHTML = rest.map(homeRow).join('');
    document.getElementById('more-section').classList.toggle('hidden', !rest.length);

    // "Đọc nhiều" earns its place only once there is a real second ranking.
    const mostReadBlock = document.getElementById('most-read-block');
    if (mostRead.length >= 2) {
      document.getElementById('latest-secondary').innerHTML = mostRead.map(rankRow).join('');
      mostReadBlock.classList.remove('hidden');
    } else {
      mostReadBlock.classList.add('hidden');
    }

    // Only the five busiest topics on the homepage - /api/posts/tags already
    // returns them sorted by post count, newest spelling first. The full list
    // is on "Tất cả bài viết". Mirrored in server/ssr-content.js (TOPIC_MAX).
    const tags = ((tagsRes && tagsRes.tags) || []).slice(0, 5);
    const topicsBlock = document.getElementById('topics-block');
    if (tags.length) {
      document.getElementById('topic-list').innerHTML = tags.map(topicRow).join('');
      topicsBlock.classList.remove('hidden');
    } else {
      topicsBlock.classList.add('hidden');
    }
  } catch (e) {
    loading.classList.add('hidden');
    errorEl.textContent = `Không thể tải bài viết: ${e.message}`;
    errorEl.classList.remove('hidden');
  }
}

loadHome();
