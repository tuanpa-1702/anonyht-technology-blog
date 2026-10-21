// "Lưu trữ" page (public/archive.html): every published post as a tree,
// year > month > post, newest first. Built from GET /api/posts/archive.
//
// The tree is native <details>/<summary>, so it opens and closes without any
// script of its own and works with the keyboard. The newest year (and its
// newest month) start open; "Mở tất cả" / "Thu gọn" act on every node.

document.getElementById('footer-year')?.replaceChildren(String(new Date().getFullYear()));

const MONTH_NAMES = [
  'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

// created_at is stored as UTC "YYYY-MM-DD HH:MM:SS"; read it as such and group
// by the reader's own calendar (a post written at 23:30 on the 31st in Hà Nội
// belongs to that month, not the next).
function archiveDate(value) {
  const d = new Date(String(value || '').replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function groupPosts(posts) {
  const years = new Map(); // year -> Map(month -> posts[])
  for (const p of posts) {
    const d = archiveDate(p.created_at);
    if (!d) continue;
    const y = d.getFullYear();
    const m = d.getMonth();
    if (!years.has(y)) years.set(y, new Map());
    const months = years.get(y);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push({ ...p, _date: d });
  }
  return years;
}

function postRowHtml(p) {
  const day = String(p._date.getDate()).padStart(2, '0');
  const month = String(p._date.getMonth() + 1).padStart(2, '0');
  return `<li class="archive-post" role="treeitem">
    <span class="archive-post-date">${day}/${month}</span>
    <a class="archive-post-title" href="/post.html?slug=${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a>
    ${p.tag ? `<a class="archive-post-tag" href="/viewall.html?tag=${encodeURIComponent(p.tag)}">${escapeHtml(p.tag)}</a>` : ''}
  </li>`;
}

function renderArchive(posts) {
  const tree = document.getElementById('archive-tree');
  const summary = document.getElementById('archive-summary');
  const tools = document.getElementById('archive-tools');
  const years = groupPosts(posts);
  if (!years.size) {
    summary.textContent = 'Chưa có bài viết nào.';
    summary.classList.remove('hidden');
    tree.innerHTML = '';
    return;
  }
  const yearKeys = [...years.keys()].sort((a, b) => b - a);
  tools.classList.remove('hidden');

  tree.innerHTML = yearKeys
    .map((y, yi) => {
      const months = years.get(y);
      const monthKeys = [...months.keys()].sort((a, b) => b - a);
      const yearCount = monthKeys.reduce((n, m) => n + months.get(m).length, 0);
      const monthsHtml = monthKeys
        .map((m, mi) => {
          const list = months.get(m);
          const open = yi === 0 && mi === 0 ? ' open' : '';
          return `<details class="archive-month" role="treeitem"${open}>
            <summary><span class="material-symbols-outlined archive-icon" aria-hidden="true">folder</span><span class="archive-label">${MONTH_NAMES[m]}</span><span class="archive-count">${list.length}</span></summary>
            <ul class="archive-posts" role="group">${list.map(postRowHtml).join('')}</ul>
          </details>`;
        })
        .join('');
      return `<details class="archive-year" role="treeitem"${yi === 0 ? ' open' : ''}>
        <summary><span class="material-symbols-outlined archive-icon" aria-hidden="true">folder</span><span class="archive-label">Năm ${y}</span><span class="archive-count">${yearCount} bài</span></summary>
        <div class="archive-months" role="group">${monthsHtml}</div>
      </details>`;
    })
    .join('');
}

document.getElementById('archive-tools')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-archive]');
  if (!btn) return;
  const open = btn.dataset.archive === 'expand';
  const visible = document.querySelector('.archive-panel:not([hidden]) .archive-tree');
  visible?.querySelectorAll('details').forEach((d) => {
    d.open = open;
  });
});

(async function loadArchive() {
  try {
    const res = await fetch('/api/posts/archive', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { posts } = await res.json();
    renderArchive(Array.isArray(posts) ? posts : []);
  } catch (e) {
    const s = document.getElementById('archive-summary');
    s.textContent = `Không thể tải lưu trữ: ${e.message}`;
    s.classList.remove('hidden');
  }
})();


// ---- Tabs: Bài viết | Tài nguyên ---------------------------------------------
// The open tab is kept in the hash (#tai-nguyen) so it survives a reload and can
// be linked to. Tài nguyên is fetched the first time it is shown.
let resourcesLoaded = false;
function showArchiveTab(name) {
  document.querySelectorAll('.archive-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.getElementById('archive-panel-posts').hidden = name !== 'posts';
  document.getElementById('archive-panel-resources').hidden = name !== 'resources';
  history.replaceState(null, '', name === 'resources' ? '#tai-nguyen' : location.pathname + location.search);
  if (name === 'resources' && !resourcesLoaded) {
    resourcesLoaded = true;
    loadResources();
  }
}
document.querySelector('.archive-tabs')?.addEventListener('click', (e) => {
  const t = e.target.closest('.archive-tab');
  if (t) showArchiveTab(t.dataset.tab);
});

// ---- Tài nguyên ----------------------------------------------------------------
let resData = { folders: [], files: [] };
const openFolders = new Set(); // folder ids kept open across re-renders

function isAdminViewer() {
  const u = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  return !!(u && u.role === 'admin' && Auth.isLoggedIn());
}

// Editors may upload files (and rename / delete the ones they uploaded - the
// server marks those with can_edit); folders stay admin-only.
function isWriterViewer() {
  const u = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  return !!(u && (u.role === 'admin' || u.role === 'editor') && Auth.isLoggedIn());
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fileIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a'].includes(ext)) return 'play_circle';
  if (['exe', 'msi', 'sh', 'bat', 'ps1', 'deb', 'rpm', 'apk', 'dmg', 'pkg', 'appimage', 'iso', 'img'].includes(ext)) return 'terminal';
  return 'draft';
}

function resFolderHtml(folder, admin) {
  const subs = resData.folders.filter((f) => f.parent_id === folder.id);
  const files = resData.files.filter((f) => f.folder_id === folder.id);
  const count = countInBranch(folder.id);
  // An editor's only tool, so it carries a label: a lone cloud icon was easy
  // to miss (user, 2026-10-05).
  const uploadOnly = !admin && isWriterViewer()
    ? `<span class="res-actions" data-folder="${folder.id}">
        <button type="button" class="res-act res-act--labeled" data-res="upload" title="Tải file lên thư mục ${escapeHtml(folder.name)}"><span class="material-symbols-outlined" aria-hidden="true">cloud_upload</span><span>Tải lên</span></button>
      </span>`
    : '';
  const tools = admin
    ? `<span class="res-actions" data-folder="${folder.id}">
        <button type="button" class="res-act" data-res="upload" title="Tải file lên thư mục này" aria-label="Tải file lên"><span class="material-symbols-outlined" aria-hidden="true">cloud_upload</span></button>
        <button type="button" class="res-act" data-res="new-sub" title="Tạo thư mục con" aria-label="Tạo thư mục con"><span class="material-symbols-outlined" aria-hidden="true">create_new_folder</span></button>
        <button type="button" class="res-act" data-res="rename-folder" title="Đổi tên" aria-label="Đổi tên thư mục"><span class="material-symbols-outlined" aria-hidden="true">edit</span></button>
        <button type="button" class="res-act res-act--danger" data-res="delete-folder" title="Xoá thư mục" aria-label="Xoá thư mục"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button>
      </span>`
    : uploadOnly;
  const body =
    subs.map((f) => resFolderHtml(f, admin)).join('') +
    files.map((f) => resFileHtml(f, admin)).join('') +
    (!subs.length && !files.length ? '<p class="res-empty">Thư mục trống.</p>' : '');
  const isRoot = folder.parent_id == null;
  return `<details class="${isRoot ? 'archive-year' : 'archive-month'} res-folder" role="treeitem" data-folder-id="${folder.id}"${openFolders.has(folder.id) ? ' open' : ''}>
    <summary><span class="material-symbols-outlined archive-icon" aria-hidden="true">folder</span><span class="archive-label">${escapeHtml(folder.name)}</span>${tools}<span class="archive-count">${count}</span></summary>
    <div class="${isRoot ? 'archive-months' : 'res-children'}" role="group">${body}</div>
  </details>`;
}

function countInBranch(id) {
  let n = resData.files.filter((f) => f.folder_id === id).length;
  for (const sub of resData.folders.filter((f) => f.parent_id === id)) n += countInBranch(sub.id);
  return n;
}

function resFileHtml(f, admin) {
  const d = archiveDate(f.created_at);
  const date = d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
  return `<div class="res-file" role="treeitem" data-file-id="${f.id}">
    <span class="material-symbols-outlined res-file-icon" aria-hidden="true">${fileIcon(f.name)}</span>
    <span class="res-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
    <span class="res-file-meta">${humanSize(f.bytes)} · ${date}${f.downloads ? ` · ${f.downloads} lượt tải` : ''}</span>
    <span class="res-file-actions">
      <button type="button" class="res-download" data-res="download" title="Tải xuống" aria-label="Tải xuống ${escapeHtml(f.name)}"><span class="material-symbols-outlined" aria-hidden="true">arrow_downward</span><span class="res-download-label">Tải</span></button>
      ${
        f.can_edit
          ? `<button type="button" class="res-act" data-res="rename-file" title="Đổi tên" aria-label="Đổi tên file"><span class="material-symbols-outlined" aria-hidden="true">edit</span></button>
             <button type="button" class="res-act res-act--danger" data-res="delete-file" title="Xoá file" aria-label="Xoá file"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button>`
          : ''
      }
    </span>
  </div>`;
}

function renderResources() {
  const tree = document.getElementById('res-tree');
  const admin = isAdminViewer();
  document.querySelectorAll('.res-admin').forEach((el) => el.classList.toggle('hidden', !admin));
  document.getElementById('res-note').innerHTML = '';
  // Remember which folders are open before replacing the tree.
  tree.querySelectorAll('details[open][data-folder-id]').forEach((d) => openFolders.add(Number(d.dataset.folderId)));
  tree.querySelectorAll('details:not([open])[data-folder-id]').forEach((d) => openFolders.delete(Number(d.dataset.folderId)));
  const roots = resData.folders.filter((f) => f.parent_id == null);
  tree.innerHTML = roots.length
    ? roots.map((f) => resFolderHtml(f, admin)).join('')
    : '<p class="res-empty">Chưa có thư mục tài nguyên nào.</p>';
}

async function resApi(path, opts = {}) {
  const token = Auth.getToken && Auth.getToken();
  const res = await fetch(`/api/resources${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const jsonBody = (obj) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Signed out: no tree at all, just the card asking to sign in (the server
// refuses /tree without a session too).
function renderResourcesLocked() {
  document.querySelectorAll('.res-admin').forEach((el) => el.classList.add('hidden'));
  document.getElementById('res-note').innerHTML = '';
  document.getElementById('res-tree').innerHTML = `<div class="res-locked">
      <span class="res-locked-icon material-symbols-outlined" aria-hidden="true">lock</span>
      <p class="res-locked-title">Bạn cần đăng nhập để xem và tải tài nguyên</p>
      <button type="button" class="res-locked-btn" data-action="auth-open">Đăng nhập</button>
    </div>`;
}

async function loadResources() {
  if (!Auth.isLoggedIn()) {
    renderResourcesLocked();
    return;
  }
  try {
    resData = await resApi('/tree');
    renderResources();
  } catch (e) {
    if (/đăng nhập|401/i.test(e.message)) {
      renderResourcesLocked();
      return;
    }
    document.getElementById('res-tree').innerHTML = `<p class="res-empty">Không thể tải tài nguyên: ${escapeHtml(e.message)}</p>`;
  }
}

// ---- Upload (admin): chunked, with a progress row per file -------------------
let uploadTargetFolder = null;
async function uploadOne(file, folderId) {
  const box = document.getElementById('res-uploads');
  box.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = 'res-upload';
  row.innerHTML = `<span class="res-upload-name">${escapeHtml(file.name)}</span><span class="res-upload-pct">0%</span><span class="res-upload-bar"><span></span></span>`;
  box.appendChild(row);
  const bar = row.querySelector('.res-upload-bar > span');
  const pct = row.querySelector('.res-upload-pct');
  const setPct = (p) => {
    bar.style.width = `${p}%`;
    pct.textContent = `${Math.round(p)}%`;
  };
  let uid = null;
  try {
    const init = await resApi('/uploads', { method: 'POST', ...jsonBody({ folder_id: folderId, name: file.name, size: file.size }) });
    uid = init.upload_id;
    const size = init.chunk_size;
    for (let i = 0, off = 0; off < file.size || (i === 0 && file.size === 0); i += 1, off += size) {
      await resApi(`/uploads/${uid}/${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(off, off + size),
      });
      setPct(file.size ? (Math.min(off + size, file.size) / file.size) * 100 : 100);
      if (file.size === 0) break;
    }
    await resApi(`/uploads/${uid}/complete`, { method: 'POST' });
    row.classList.add('is-done');
    pct.textContent = 'Xong';
  } catch (e) {
    row.classList.add('is-error');
    pct.textContent = 'Lỗi';
    row.title = e.message;
    if (uid) resApi(`/uploads/${uid}`, { method: 'DELETE' }).catch(() => {});
    uiAlert(`Không tải lên được "${file.name}": ${e.message}`);
  }
  setTimeout(() => {
    row.remove();
    if (!box.children.length) box.classList.add('hidden');
  }, 4000);
}

document.getElementById('res-file-input')?.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || uploadTargetFolder == null) return;
  openFolders.add(uploadTargetFolder);
  for (const f of files) await uploadOne(f, uploadTargetFolder);
  loadResources();
});

// ---- Actions ---------------------------------------------------------------------
document.getElementById('archive-panel-resources')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-res]');
  if (!btn) return;
  // Buttons inside a <summary> must not also open/close the folder.
  if (btn.closest('summary')) e.preventDefault();
  const action = btn.dataset.res;
  const folderId = Number(btn.closest('[data-folder]')?.dataset.folder || btn.closest('[data-folder-id]')?.dataset.folderId) || null;
  const fileId = Number(btn.closest('[data-file-id]')?.dataset.fileId) || null;
  const folder = resData.folders.find((f) => f.id === folderId);
  const file = resData.files.find((f) => f.id === fileId);
  try {
    if (action === 'download') {
      if (!Auth.isLoggedIn()) {
        openAuthModal();
        return;
      }
      const { url } = await resApi(`/files/${fileId}/link`, { method: 'POST' });
      window.location.href = url;
      setTimeout(loadResources, 1500); // the download count
    } else if (action === 'new-root' || action === 'new-sub') {
      const name = await uiPrompt('', { title: action === 'new-root' ? 'Thư mục mới' : `Thư mục con trong "${folder?.name}"`, placeholder: 'Tên thư mục', confirmText: 'Tạo', icon: 'create_new_folder' });
      if (!name) return;
      await resApi('/folders', { method: 'POST', ...jsonBody({ name, parent_id: action === 'new-sub' ? folderId : null }) });
      if (folderId) openFolders.add(folderId);
      await loadResources();
    } else if (action === 'rename-folder') {
      const name = await uiPrompt('', { title: 'Đổi tên thư mục', value: folder?.name || '', placeholder: 'Tên thư mục' });
      if (!name || name === folder?.name) return;
      await resApi(`/folders/${folderId}`, { method: 'PATCH', ...jsonBody({ name }) });
      await loadResources();
    } else if (action === 'delete-folder') {
      const n = countInBranch(folderId);
      if (!(await uiConfirm(`Xoá thư mục "${folder?.name}"? Mọi thư mục con${n ? ` và ${n} file bên trong` : ''} sẽ bị xoá vĩnh viễn khỏi máy chủ.`))) return;
      await resApi(`/folders/${folderId}`, { method: 'DELETE' });
      await loadResources();
    } else if (action === 'upload') {
      uploadTargetFolder = folderId;
      document.getElementById('res-file-input').click();
    } else if (action === 'rename-file') {
      const name = await uiPrompt('', { title: 'Đổi tên file', value: file?.name || '', placeholder: 'Tên file' });
      if (!name || name === file?.name) return;
      await resApi(`/files/${fileId}`, { method: 'PATCH', ...jsonBody({ name }) });
      await loadResources();
    } else if (action === 'delete-file') {
      if (!(await uiConfirm(`Xoá file "${file?.name}"? File sẽ bị xoá vĩnh viễn khỏi máy chủ.`))) return;
      await resApi(`/files/${fileId}`, { method: 'DELETE' });
      await loadResources();
    }
  } catch (err) {
    uiAlert(err.message);
  }
});

// Opened at /archive.html#tai-nguyen: show that tab. Last in the file on
// purpose - it loads the resources, which reads resData/openFolders, and those
// `let`/`const` bindings must already be initialised (calling it from the tab
// section above threw "can't access lexical declaration 'resData' before
// initialization" in Firefox).
if (location.hash === '#tai-nguyen') showArchiveTab('resources');
