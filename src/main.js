import { marked } from 'marked';

// ── Tauri integration ──────────────────────────────────────────────
// Config is persisted via custom Rust commands (load_config / save_config)
// which use the store plugin's Rust API directly.
// Falls back to sessionStorage when running outside Tauri.

function tauriInvoke(cmd, args) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

async function loadPersistedConfig() {
  if (!window.__TAURI_INTERNALS__) return null;
  try {
    const c = await tauriInvoke('load_config');
    console.log('loaded config:', c);
    return c;
  } catch (e) {
    console.warn('load_config failed:', e);
    return null;
  }
}

async function savePersistedConfig() {
  if (!window.__TAURI_INTERNALS__) {
    sessionStorage.setItem('cfg', JSON.stringify(cfg));
    return;
  }
  try {
    await tauriInvoke('save_config', {
      token:     cfg.token,
      repo:      cfg.repo,
      branch:    cfg.branch,
      postsPath: cfg.postsPath,
    });
    console.log('config saved');
  } catch (e) {
    console.warn('save_config failed:', e);
  }
}

// ── Token validation & repo combobox ──────────────────────────────
let _allRepos = [];
let _repoDropdownIdx = -1;

window.validateToken = async function() {
  const token = document.getElementById('cfg-token').value.trim();
  if (!token) { toast('paste a token first', 'error'); return; }

  const btn = document.getElementById('token-validate-btn');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    // Fetch all accessible repos (paginate up to 500)
    let page = 1, all = [];
    while (page <= 5) {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
      );
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || res.statusText); }
      const batch = await res.json();
      all = all.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    _allRepos = all.map(r => r.full_name).sort((a, b) => a.localeCompare(b));
    toast(`found ${_allRepos.length} repo${_allRepos.length !== 1 ? 's' : ''}`);
    document.getElementById('cfg-repo').placeholder = 'type to search repos…';
    renderRepoDropdown(_allRepos);
    showRepoDropdown();
    document.getElementById('cfg-repo').focus();
  } catch (e) {
    toast('token error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'OK →';
  }
};

function renderRepoDropdown(repos) {
  const dd = document.getElementById('repo-dropdown');
  if (!repos.length) {
    dd.innerHTML = '<div class="repo-option no-match">no repos found</div>';
  } else {
    dd.innerHTML = repos.map((r, i) =>
      `<div class="repo-option" data-repo="${r}" onmousedown="selectRepo('${r}')">${r}</div>`
    ).join('');
  }
  _repoDropdownIdx = -1;
}

window.filterRepos = function(val) {
  if (!_allRepos.length) return;
  const lower = val.toLowerCase();
  const filtered = val ? _allRepos.filter(r => r.toLowerCase().includes(lower)) : _allRepos;
  renderRepoDropdown(filtered);
  showRepoDropdown();
};

window.showRepoDropdown = function() {
  if (!_allRepos.length) return;
  document.getElementById('repo-dropdown').classList.add('show');
};

function hideRepoDropdown() {
  document.getElementById('repo-dropdown').classList.remove('show');
  _repoDropdownIdx = -1;
}

window.selectRepo = function(name) {
  document.getElementById('cfg-repo').value = name;
  hideRepoDropdown();
};

window.repoKeydown = function(e) {
  const dd = document.getElementById('repo-dropdown');
  const items = dd.querySelectorAll('.repo-option:not(.no-match)');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _repoDropdownIdx = Math.min(_repoDropdownIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _repoDropdownIdx = Math.max(_repoDropdownIdx - 1, 0);
  } else if (e.key === 'Enter' && _repoDropdownIdx >= 0) {
    e.preventDefault();
    selectRepo(items[_repoDropdownIdx].dataset.repo);
    return;
  } else if (e.key === 'Escape') {
    hideRepoDropdown(); return;
  } else { return; }
  items.forEach((el, i) => el.classList.toggle('active', i === _repoDropdownIdx));
  items[_repoDropdownIdx]?.scrollIntoView({ block: 'nearest' });
};

// Close dropdown when clicking outside
document.addEventListener('mousedown', e => {
  if (!document.getElementById('repo-combobox').contains(e.target)) hideRepoDropdown();
});

// ── State ──────────────────────────────────────────────────────────
let cfg = { token: '', repo: '', branch: 'main', postsPath: 'content/blog' };
let _treeItems = [];      // [{path, type, sha, relPath}] from GitHub tree API
let _expandedDirs = new Set();
let _fileMetaCache = new Map(); // path -> {title, draft, date}
let _searchFilter = '';
let currentPost = null;
let dirty = false;
let previewing = false;
let _ctxTarget = null;        // { path, type } for context menu
let _newPostFolder = '';      // absolute path of folder for next new-post-in-folder

// slugEdited lives on window so both module code and inline oninput handlers share one variable
window.slugEdited = false;

// ── Theme ─────────────────────────────────────────────────────────
const _themes = ['light', 'dark', 'eink'];
const _themeIcons = { light: '○ theme', dark: '● theme', eink: '◑ theme' };

function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('theme', name);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = _themeIcons[name] ?? '○';
}

window.cycleTheme = function() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = _themes[(_themes.indexOf(current) + 1) % _themes.length];
  setTheme(next);
};

// Apply persisted theme immediately (before first paint)
setTheme(localStorage.getItem('theme') || 'light');

// ── UI helpers ────────────────────────────────────────────────────
function toast(msg, type = '', dur = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type === 'error' ? 'show error' : 'show';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.className = '', dur);
}

function setStatus(path, words, chars) {
  if (path !== undefined) document.getElementById('status-path').textContent = path;
  if (words !== undefined) document.getElementById('status-words').textContent = words + ' words';
  if (chars !== undefined) document.getElementById('status-chars').textContent = chars + ' chars';
}

function markDirty() {
  dirty = true;
}

function markClean() {
  dirty = false;
}

function updateWordCount() {
  const text = document.getElementById('md-editor').value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  setStatus(undefined, words, chars);
}

window.markDirty = markDirty;
window.updatePreview = updatePreview;
window.updateWordCount = updateWordCount;

// ── Frontmatter helpers ───────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-');
}

window.autoSlug = function() {
  if (window.slugEdited) return;
  const title = document.getElementById('post-title-input').value;
  document.getElementById('fm-slug').value = slugify(title);
};

function buildFrontmatter({ title, isDraft, date, tags, slug }) {
  const d = date || todayISO();
  const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  let fm = `+++\ntitle = "${title}"\ndate = "${d}"\n`;
  if (isDraft) fm += `draft = true\n`;
  if (tagList.length) fm += `\n[taxonomies]\ntags = [${tagList.map(t => `"${t}"`).join(', ')}]\n`;
  fm += `+++\n\n`;
  return fm;
}

function parseFrontmatter(raw) {
  // TOML frontmatter (+++ delimiters)
  let m = raw.match(/^\+\+\+\n([\s\S]*?)\n\+\+\+\n?([\s\S]*)$/);
  if (m) {
    const header = m[1];
    const body = m[2].replace(/^\n/, '');
    const title = (header.match(/title\s*=\s*"([^"]*)"/) || [])[1] || '';
    const draft = /draft\s*=\s*true/.test(header);
    const date = ((header.match(/date\s*=\s*["']?(\S+?)["']?\s*$/) || [])[1] || '').replace(/["']/g, '');
    const description = (header.match(/description\s*=\s*"([^"]*)"/) || [])[1] || '';
    const slug = (header.match(/slug\s*=\s*"([^"]*)"/) || [])[1] || '';
    // Tags live under [taxonomies] in Zola; also handle top-level tags = [...]
    const taxSection = header.match(/\[taxonomies\]([\s\S]*?)(?=\n\[|\s*$)/);
    const tagSource = taxSection ? taxSection[1] : header;
    const tagMatch = tagSource.match(/\btags\s*=\s*\[([^\]]*)\]/);
    const tags = tagMatch ? tagMatch[1].replace(/["']/g, '').split(',').map(t => t.trim()).filter(Boolean).join(', ') : '';
    return { title, slug, draft, date, tags, description, body, format: 'toml' };
  }
  // YAML frontmatter (--- delimiters)
  m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    const header = m[1];
    const body = m[2].replace(/^\n/, '');
    const title = ((header.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || '').trim();
    const draft = /^draft:\s*true\s*$/m.test(header);
    const date = (header.match(/^date:\s*(\S+)/m) || [])[1] || '';
    const description = ((header.match(/^description:\s*["']?(.+?)["']?\s*$/m) || [])[1] || '').trim();
    const slug = ((header.match(/^slug:\s*["']?(.+?)["']?\s*$/m) || [])[1] || '').trim();
    // Tags: look under taxonomies.tags first (Zola convention), then top-level tags
    // Matches both inline [a, b] and block list (- item) forms in either location
    function extractYamlTags(source) {
      const inline = source.match(/^[ \t]*tags:\s*\[([^\]]*)\]\s*$/m);
      if (inline) return inline[1].replace(/["']/g, '').split(',').map(t => t.trim()).filter(Boolean).join(', ');
      const block = source.match(/^[ \t]*tags:\s*\n((?:[ \t]*-[^\n]*\n?)*)/m);
      if (block) return [...block[1].matchAll(/[ \t]*-\s*["']?(.+?)["']?\s*$/gm)].map(t => t[1].trim()).join(', ');
      return '';
    }
    const taxSection = header.match(/^taxonomies:\s*\n((?:[ \t]+\S[^\n]*\n?)*)/m);
    let tags = taxSection ? extractYamlTags(taxSection[1]) : '';
    if (!tags) tags = extractYamlTags(header);
    return { title, slug, draft, date, tags, description, body, format: 'yaml' };
  }
  return { title: '', slug: '', draft: false, date: '', tags: '', description: '', body: raw, format: 'toml' };
}

// ── GitHub API ────────────────────────────────────────────────────
async function ghFetch(path, opts = {}) {
  if (!cfg.token || !cfg.repo) { openSettings(); throw new Error('not configured'); }
  const url = `https://api.github.com/repos/${cfg.repo}/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

async function commitFile(path, content, sha, message) {
  const encoded = btoa(unescape(encodeURIComponent(content)));
  const body = { message, content: encoded, branch: cfg.branch };
  if (sha) body.sha = sha;
  const result = await ghFetch(`contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return result;
}

// ── File tree ─────────────────────────────────────────────────────
window.loadPosts = async function() {
  if (!cfg.token || !cfg.repo) { openSettings(); return; }
  setStatus('loading…');
  try {
    const branchData = await ghFetch(`branches/${cfg.branch}`);
    const treeSha = branchData.commit.commit.tree.sha;
    const treeData = await ghFetch(`git/trees/${treeSha}?recursive=1`);

    const prefix = cfg.postsPath.replace(/\/$/, '');
    _treeItems = treeData.tree
      .filter(item => {
        if (!item.path.startsWith(prefix + '/') && item.path !== prefix) return false;
        // keep directories and .md files only
        return item.type === 'tree' || item.path.endsWith('.md');
      })
      .map(item => ({
        path: item.path,
        type: item.type,   // 'blob' | 'tree'
        sha: item.sha,
        relPath: item.path.slice(prefix.length + 1) || ''
      }));

    // All data is loaded; start with all folders collapsed
    _expandedDirs = new Set([prefix]);

    renderTree();
    setStatus(currentPost ? currentPost.path : 'select a file');
  } catch (e) {
    console.error('loadPosts failed:', e);
    setStatus('not connected');
    document.getElementById('post-list').innerHTML = `
      <div style="padding:16px 10px;color:var(--text3);font-size:11px;line-height:1.6;">
        <div style="color:var(--danger);margin-bottom:8px;">⚠ could not connect</div>
        <div style="margin-bottom:12px;word-break:break-word;">${escapeHtml(e.message)}</div>
        <button onclick="loadPosts()" style="margin-bottom:6px;width:100%">↺ retry</button>
        <button onclick="openSettings()" style="width:100%">⚙ settings</button>
      </div>`;
  }
};

function treeChildren(parentPath) {
  return _treeItems
    .filter(item => item.path.substring(0, item.path.lastIndexOf('/')) === parentPath)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return b.path.localeCompare(a.path);
    });
}

function dirHasMatch(dirPath) {
  if (!_searchFilter) return true;
  return _treeItems.some(item =>
    item.type === 'blob' &&
    item.path.startsWith(dirPath + '/') &&
    item.path.split('/').pop().toLowerCase().includes(_searchFilter)
  );
}

function renderTreeNodes(parentPath, depth) {
  let html = '';
  const pad = depth * 14;
  for (const item of treeChildren(parentPath)) {
    const name = item.path.split('/').pop();
    if (item.type === 'tree') {
      const exp = _expandedDirs.has(item.path);
      html += `<div class="tree-item tree-dir" style="padding-left:${8 + pad}px"
                    onclick="window.toggleDir('${item.path}')"
                    oncontextmenu="event.stopPropagation();window.showCtxMenu(event,'${item.path}','tree')">
        <span class="tree-arrow">${exp ? '▾' : '▸'}</span>
        <span class="tree-name">${escapeHtml(name)}</span>
      </div>`;
      if (exp) html += renderTreeNodes(item.path, depth + 1);
    } else {
      if (_searchFilter && !name.toLowerCase().includes(_searchFilter)) continue;
      const active = currentPost && currentPost.path === item.path;
      const meta = _fileMetaCache.get(item.path);
      const label = name.replace(/\.md$/, '');
      html += `<div class="tree-item tree-file${active ? ' active' : ''}"
                    style="padding-left:${22 + pad}px"
                    onclick="window.openTreeFile('${item.path}', '${item.sha}')"
                    oncontextmenu="event.stopPropagation();window.showCtxMenu(event,'${item.path}','blob')">
        <span class="tree-name">${escapeHtml(label)}</span>
        ${meta ? `<span class="badge ${meta.draft ? 'badge-draft' : 'badge-pub'}">${meta.draft ? 'draft' : 'live'}</span>` : ''}
      </div>`;
    }
  }
  return html;
}

function renderTree() {
  const prefix = cfg.postsPath.replace(/\/$/, '');
  document.getElementById('post-list').innerHTML = renderTreeNodes(prefix, 0);
}

window.toggleDir = function(path) {
  if (_expandedDirs.has(path)) _expandedDirs.delete(path);
  else _expandedDirs.add(path);
  renderTree();
};

// ── Context menu ──────────────────────────────────────────────────
window.showCtxMenu = function(e, path, type) {
  e.preventDefault();
  _ctxTarget = { path, type };
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-new-post').style.display = type === 'tree' ? '' : 'none';
  document.getElementById('ctx-rename').style.display   = type === 'blob' ? '' : 'none';
  // Clamp to viewport.
  // e.clientX/Y are in physical CSS pixels; the menu inherits body's zoom
  // so its position values are in zoomed coordinates — divide to compensate.
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  menu.classList.add('show');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const x = e.clientX / zoom;
  const y = e.clientY / zoom;
  menu.style.left = Math.min(x, window.innerWidth  / zoom - mw - 4) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight / zoom - mh - 4) + 'px';
};

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('show');
  _ctxTarget = null;
}

document.addEventListener('click',       () => hideCtxMenu());
document.addEventListener('contextmenu', () => hideCtxMenu());

window.ctxNewPost = function() {
  if (!_ctxTarget) return;
  _newPostFolder = _ctxTarget.path;
  _expandedDirs.add(_ctxTarget.path);
  hideCtxMenu();
  window.newPost();
};

window.ctxRename = async function() {
  if (!_ctxTarget || _ctxTarget.type !== 'blob') return;
  const oldPath = _ctxTarget.path;
  hideCtxMenu();
  const oldName = oldPath.split('/').pop().replace(/\.md$/, '');
  const input = prompt('Rename to:', oldName);
  if (!input || input.trim() === oldName) return;
  const newSlug = slugify(input.trim()) || input.trim().toLowerCase().replace(/\s+/g, '-');
  const dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
  const newPath = dir + '/' + newSlug + '.md';
  setStatus('renaming…');
  try {
    const data = await ghFetch(`contents/${oldPath}?ref=${cfg.branch}`);
    const rawContent = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    await commitFile(newPath, rawContent, null, `rename: ${oldName} → ${newSlug}`);
    await ghFetch(`contents/${oldPath}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `rename: ${oldName} → ${newSlug}`, sha: data.sha, branch: cfg.branch }),
    });
    toast('renamed');
    if (currentPost && currentPost.path === oldPath) {
      currentPost.path = newPath;
      currentPost.name = newSlug + '.md';
      document.getElementById('fm-slug').value = newSlug;
      setStatus(newPath);
    }
    await loadPosts();
  } catch (e) {
    toast('rename failed: ' + e.message, 'error');
    setStatus('rename failed');
  }
};

window.filterPosts = function(val) {
  _searchFilter = val.toLowerCase();
  // Expand everything while searching so results are visible
  if (_searchFilter) _treeItems.filter(i => i.type === 'tree').forEach(i => _expandedDirs.add(i.path));
  renderTree();
};

window.openTreeFile = async function(path, sha) {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const data = await ghFetch(`contents/${path}?ref=${cfg.branch}`);
    const remoteRaw = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));

    // Prefer local save if one exists and differs from remote
    let raw = remoteRaw;
    if (window.__TAURI_INTERNALS__) {
      const filename = path.split('/').pop();
      const local = await tauriInvoke('load_local', { filename }).catch(() => null);
      if (local && local !== remoteRaw) {
        if (confirm(`A locally saved version of "${filename}" exists. Use local version?`)) {
          raw = local;
        }
      }
    }

    const filename = path.split('/').pop();
    const isIndex = filename === '_index.md';
    const fm = parseFrontmatter(raw);
    currentPost = { name: filename, path, sha: data.sha, raw, draft: fm.draft, title: fm.title, date: fm.date, isIndex };
    _fileMetaCache.set(path, { title: fm.title, draft: fm.draft, date: fm.date });
    markClean();

    if (isIndex) {
      // Section index: edit raw content only, frontmatter fields are not applicable
      setFrontmatterEditable(false);
      document.getElementById('post-title-input').value = '';
      document.getElementById('fm-date').value = '';
      document.getElementById('fm-tags').value = '';
      document.getElementById('fm-slug').value = '';
      document.getElementById('md-editor').value = raw;
      document.getElementById('unpub-btn').style.display = 'none';
    } else {
      setFrontmatterEditable(true);
      document.getElementById('post-title-input').value = fm.title;
      document.getElementById('md-editor').value = fm.body;
      document.getElementById('fm-date').value = fm.date || todayISO();
      document.getElementById('fm-tags').value = fm.tags;
      const filenameSlug = path.split('/').pop().replace(/\.md$/, '');
      document.getElementById('fm-slug').value = fm.slug || filenameSlug;
      window.slugEdited = true;
      document.getElementById('unpub-btn').style.display = !fm.draft ? 'inline-flex' : 'none';
    }
    setStatus(path);
    updateWordCount();
    updateHighlight();
    updatePreview();
    renderTree();
  } catch (e) {
    toast('could not open: ' + e.message, 'error');
  }
};

function setFrontmatterEditable(on) {
  const ids = ['post-title-input', 'fm-date', 'fm-tags', 'fm-slug'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    el.disabled = !on;
  });
  document.getElementById('frontmatter-bar').style.opacity = on ? '' : '0.35';
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── New post ──────────────────────────────────────────────────────
function _populateFolderSelect(selectId, preselect) {
  const prefix = cfg.postsPath.replace(/\/$/, '');
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  const rootOpt = document.createElement('option');
  rootOpt.value = prefix;
  rootOpt.textContent = '/ (posts root)';
  select.appendChild(rootOpt);
  _treeItems
    .filter(i => i.type === 'tree')
    .sort((a, b) => b.path.localeCompare(a.path))
    .forEach(dir => {
      const opt = document.createElement('option');
      opt.value = dir.path;
      opt.textContent = '/' + dir.relPath;
      select.appendChild(opt);
    });
  if (preselect) select.value = preselect;
}

window.newPost = function() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  _populateFolderSelect('np-folder', _newPostFolder || null);
  document.getElementById('np-title').value = '';
  document.getElementById('np-overlay').classList.add('show');
  setTimeout(() => document.getElementById('np-title').focus(), 50);
};

window.closeNewPostModal = function() {
  document.getElementById('np-overlay').classList.remove('show');
};

window.confirmNewPost = function() {
  const folder = document.getElementById('np-folder').value;
  const title  = document.getElementById('np-title').value.trim();
  if (!title) { document.getElementById('np-title').focus(); return; }
  window.closeNewPostModal();

  _newPostFolder = folder;
  currentPost = null;
  markClean();
  window.slugEdited = false;
  setFrontmatterEditable(true);
  document.getElementById('post-title-input').value = title;
  document.getElementById('md-editor').value = '';
  document.getElementById('fm-date').value = todayISO();
  document.getElementById('fm-tags').value = '';
  document.getElementById('fm-slug').value = slugify(title);
  document.getElementById('unpub-btn').style.display = 'none';
  updateHighlight();
  renderTree();
  setStatus('new post', 0, 0);
  document.getElementById('md-editor').focus();
};

// ── New folder modal ──────────────────────────────────────────────
window.newFolder = function() {
  if (!cfg.token || !cfg.repo) { openSettings(); return; }
  _populateFolderSelect('nf-parent', null);
  document.getElementById('nf-name').value = '';
  document.getElementById('nf-overlay').classList.add('show');
  setTimeout(() => document.getElementById('nf-name').focus(), 50);
};

window.closeNewFolderModal = function() {
  document.getElementById('nf-overlay').classList.remove('show');
};

window.confirmNewFolder = async function() {
  const parentPath = document.getElementById('nf-parent').value;
  const name = document.getElementById('nf-name').value.trim();
  if (!name) { document.getElementById('nf-name').focus(); return; }

  const folderSlug = slugify(name) || name.toLowerCase().replace(/\s+/g, '-');
  const path = `${parentPath}/${folderSlug}/_index.md`;
  const content = `+++\ntitle = "${todayISO()}"\nsort_by = "date"\n+++\n`;

  window.closeNewFolderModal();

  try {
    const existing = await getExistingSha(path);
    if (existing) { toast('folder already exists', 'error'); return; }
    await commitFile(path, content, null, `add section: ${folderSlug}`);
    toast('folder created');

    // Refresh tree from GitHub (loadPosts resets _expandedDirs to root only)
    await loadPosts();

    // Re-expand the full ancestor chain so the new folder is immediately visible
    const newFolderPath = `${parentPath}/${folderSlug}`;
    const prefix = cfg.postsPath.replace(/\/$/, '');
    let p = newFolderPath;
    while (p && p !== prefix) {
      _expandedDirs.add(p);
      p = p.substring(0, p.lastIndexOf('/'));
    }
    renderTree();
  } catch (e) {
    toast('failed: ' + e.message, 'error');
  }
};

// ── Upload file ───────────────────────────────────────────────────
let _uploadFileData = null; // { name, base64 }

window.uploadFile = function() {
  if (!cfg.token || !cfg.repo) { openSettings(); return; }
  _populateFolderSelect('ul-folder', null);
  _uploadFileData = null;
  document.getElementById('ul-filename').value = '';
  document.getElementById('ul-file-input').value = '';
  document.getElementById('ul-confirm-btn').disabled = true;
  document.getElementById('ul-overlay').classList.add('show');
};

window.closeUploadModal = function() {
  document.getElementById('ul-overlay').classList.remove('show');
};

window.handleUploadFileSelect = function(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    // data URL is "data:<type>;base64,<content>" — strip the prefix
    _uploadFileData = { name: file.name, base64: e.target.result.split(',')[1] };
    document.getElementById('ul-filename').value = file.name;
    document.getElementById('ul-confirm-btn').disabled = false;
  };
  reader.readAsDataURL(file);
};

window.confirmUpload = async function() {
  if (!_uploadFileData) return;
  const folder = document.getElementById('ul-folder').value;
  const path = `${folder}/${_uploadFileData.name}`;
  window.closeUploadModal();
  setStatus('uploading…');
  try {
    const sha = await getExistingSha(path);
    const body = { message: `upload: ${_uploadFileData.name}`, content: _uploadFileData.base64, branch: cfg.branch };
    if (sha) body.sha = sha;
    await ghFetch(`contents/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('uploaded ✓');
    await loadPosts();
  } catch (e) {
    toast('upload failed: ' + e.message, 'error');
    setStatus('upload failed');
  }
};

// ── Get current content ───────────────────────────────────────────
function getCurrentContent(isDraft) {
  // Section index files are edited as raw content — skip frontmatter rebuilding
  if (currentPost && currentPost.isIndex) {
    return document.getElementById('md-editor').value;
  }
  const title = document.getElementById('post-title-input').value || 'Untitled';
  const body = document.getElementById('md-editor').value;
  const date = document.getElementById('fm-date').value || todayISO();
  const tags = document.getElementById('fm-tags').value;
  return buildFrontmatter({ title, isDraft, date, tags }) + body;
}

function getSlug() {
  const s = document.getElementById('fm-slug').value.trim();
  if (s) return s;
  return slugify(document.getElementById('post-title-input').value || 'untitled');
}

async function getExistingSha(path) {
  try {
    const data = await ghFetch(`contents/${path}?ref=${cfg.branch}`);
    return data.sha;
  } catch {
    return null;
  }
}

// ── Save locally (no GitHub commit) ──────────────────────────────
window.saveLocal = async function() {
  const slug = getSlug() || 'untitled';
  const filename = slug + '.md';
  const isDraft = currentPost ? currentPost.draft : true;
  const content = getCurrentContent(isDraft);
  if (window.__TAURI_INTERNALS__) {
    try {
      await tauriInvoke('save_local', { filename, content });
      markClean();
      toast('saved locally');
      setStatus(currentPost ? currentPost.path : filename + ' (local, not on GitHub)');
    } catch (e) {
      toast('local save failed: ' + e.message, 'error');
    }
  } else {
    try {
      localStorage.setItem('local-draft:' + filename, content);
      markClean();
      toast('saved locally');
    } catch (e) {
      toast('local save failed', 'error');
    }
  }
};

// ── Save draft ────────────────────────────────────────────────────
window.saveDraft = async function() {
  if (!cfg.token) { openSettings(); return; }
  const slug = getSlug();
  const subdir = (!currentPost && _newPostFolder) ? _newPostFolder.slice(cfg.postsPath.replace(/\/$/, '').length + 1) + '/' : '';
  const path = currentPost ? currentPost.path : `${cfg.postsPath}/${subdir}${slug}.md`;
  const content = getCurrentContent(true);
  const title = document.getElementById('post-title-input').value || slug;

  document.getElementById('save-btn').disabled = true;
  setStatus('saving…');
  try {
    const sha = currentPost && currentPost.path === path
      ? currentPost.sha
      : await getExistingSha(path);

    const result = await commitFile(path, content, sha, `draft: ${title}`);
    markClean();
    toast('draft saved');

    // Update local state
    const newSha = result.content.sha;
    if (currentPost && currentPost.path === path) {
      currentPost.sha = newSha;
      currentPost.raw = content;
      currentPost.draft = true;
      currentPost.title = title;
      _fileMetaCache.set(path, { title, draft: true, date: document.getElementById('fm-date').value });
    } else {
      await loadPosts();
      currentPost = { name: path.split('/').pop(), path, sha: newSha, raw: content, draft: true, title };
      _newPostFolder = '';
    }
    document.getElementById('unpub-btn').style.display = 'none';
    renderTree();
    setStatus(path);
  } catch (e) {
    toast('save failed: ' + e.message, 'error');
    setStatus('save failed');
  } finally {
    document.getElementById('save-btn').disabled = false;
  }
};

// ── Publish ───────────────────────────────────────────────────────
window.publish = async function() {
  if (!cfg.token) { openSettings(); return; }
  const slug = getSlug();
  const subdir = (!currentPost && _newPostFolder) ? _newPostFolder.slice(cfg.postsPath.replace(/\/$/, '').length + 1) + '/' : '';
  const path = currentPost ? currentPost.path : `${cfg.postsPath}/${subdir}${slug}.md`;
  const content = getCurrentContent(false);
  const title = document.getElementById('post-title-input').value || slug;

  document.getElementById('pub-btn').disabled = true;
  setStatus('publishing…');
  try {
    const sha = currentPost && currentPost.path === path
      ? currentPost.sha
      : await getExistingSha(path);

    const result = await commitFile(path, content, sha, `publish: ${title}`);
    markClean();
    toast('published! 🎉');

    const newSha = result.content.sha;
    if (currentPost && currentPost.path === path) {
      currentPost.sha = newSha;
      currentPost.raw = content;
      currentPost.draft = false;
      currentPost.title = title;
      _fileMetaCache.set(path, { title, draft: false, date: document.getElementById('fm-date').value });
    } else {
      await loadPosts();
      currentPost = { name: path.split('/').pop(), path, sha: newSha, raw: content, draft: false, title };
      _newPostFolder = '';
    }
    document.getElementById('unpub-btn').style.display = 'inline-flex';
    renderTree();
    setStatus(path);
  } catch (e) {
    toast('publish failed: ' + e.message, 'error');
    setStatus('publish failed');
  } finally {
    document.getElementById('pub-btn').disabled = false;
  }
};

// ── Unpublish (re-save as draft) ──────────────────────────────────
window.unpublish = async function() {
  if (!confirm('Move this post back to draft? It will still exist in your repo but Zola won\'t build it.')) return;
  const slug = getSlug();
  const path = `${cfg.postsPath}/${slug}.md`;
  const content = getCurrentContent(true);
  const title = document.getElementById('post-title-input').value || slug;

  try {
    const sha = currentPost && currentPost.path === path ? currentPost.sha : await getExistingSha(path);
    const result = await commitFile(path, content, sha, `draft: ${title}`);
    markClean();
    toast('moved to draft');
    if (currentPost) {
      currentPost.sha = result.content.sha;
      currentPost.draft = true;
      _fileMetaCache.set(slug === getSlug() ? path : currentPost.path,
        { title: document.getElementById('post-title-input').value, draft: true, date: document.getElementById('fm-date').value });
    }
    document.getElementById('unpub-btn').style.display = 'none';
    renderTree();
  } catch (e) {
    toast('failed: ' + e.message, 'error');
  }
};

// ── Preview ───────────────────────────────────────────────────────
window.togglePreview = function() {
  previewing = !previewing;
  const btn  = document.getElementById('preview-btn');
  const wrap = document.getElementById('md-editor-wrap');
  const pv   = document.getElementById('preview-pane');
  const sp   = document.getElementById('splitter');
  if (previewing) {
    updatePreview();
    // Reset any manual width left over from a previous drag
    wrap.style.flex  = '1';
    wrap.style.width = '';
    pv.style.display = 'block';
    pv.style.flex    = '1';
    pv.style.width   = '';
    sp.style.display = 'block';
    btn.textContent  = '✕ preview';
  } else {
    pv.style.display = 'none';
    sp.style.display = 'none';
    wrap.style.flex  = '1';
    wrap.style.width = '';
    btn.textContent  = '◎ preview';
  }
};

function updatePreview() {
  if (!previewing) return;
  const { body: md } = parseFrontmatter(document.getElementById('md-editor').value);

  let html = marked.parse(md)
    // Strip HTML comments (<!-- more --> etc.) — marked passes them through as-is
    .replace(/<!--[\s\S]*?-->/g, '')
    // Resolve root-relative URLs so links and images work from the preview pane
    .replace(/(href|src)="(\/[^"]*?)"/g, '$1="https://philwilson.org$2"');

  document.getElementById('preview-pane').innerHTML = html;
}

window.updatePreview = updatePreview;

// ── Markdown syntax highlighting ──────────────────────────────────
function applyInlineHighlight(l) {
  l = l.replace(/(`[^`]+`)/g,             '<span class="mh-code">$1</span>');
  l = l.replace(/(\*\*[^*\n]+?\*\*)/g,   '<span class="mh-bold">$1</span>');
  l = l.replace(/(\*[^*\n]+?\*)/g,       '<span class="mh-em">$1</span>');
  l = l.replace(/(\[[^\]\n]+\]\([^)\n]+\))/g, '<span class="mh-link">$1</span>');
  return l;
}

function highlightMarkdown(raw) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = raw.split('\n');
  let inCodeBlock = false;
  let inFrontmatter = false;
  let fmDelimiter = '';

  return lines.map((line, idx) => {
    const el = esc(line);

    // Frontmatter block at top of file
    if (idx === 0 && (line === '+++' || line === '---')) {
      inFrontmatter = true;
      fmDelimiter = line;
      return `<span class="mh-fm">${el}</span>`;
    }
    if (inFrontmatter) {
      if (line === fmDelimiter) inFrontmatter = false;
      return `<span class="mh-fm">${el}</span>`;
    }

    // Fenced code blocks
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return `<span class="mh-fence">${el}</span>`;
    }
    if (inCodeBlock) return `<span class="mh-code-block">${el}</span>`;

    // HTML comments (<!-- ... -->) including Zola's <!-- more --> separator
    if (/^<!--/.test(line)) return `<span class="mh-comment">${el}</span>`;

    // Block-level
    if (/^#{1,6} /.test(line))             return `<span class="mh-h">${applyInlineHighlight(el)}</span>`;
    if (/^>/.test(line))                   return `<span class="mh-quote">${el}</span>`;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return `<span class="mh-hr">${el}</span>`;

    return applyInlineHighlight(el);
  }).join('\n');
}

function updateHighlight() {
  const hl = document.getElementById('md-highlight');
  if (!hl) return;
  hl.innerHTML = highlightMarkdown(document.getElementById('md-editor').value);
  hl.scrollTop  = document.getElementById('md-editor').scrollTop;
}

document.getElementById('md-editor').addEventListener('scroll', () => {
  const hl = document.getElementById('md-highlight');
  if (hl) hl.scrollTop = document.getElementById('md-editor').scrollTop;
});

window.updateHighlight = updateHighlight;

// ── Settings modal ────────────────────────────────────────────────
let _configRequired = false;

window.openSettings = function() {
  _configRequired = !cfg.token || !cfg.repo;
  document.getElementById('cfg-token').value = cfg.token;
  document.getElementById('cfg-repo').value = cfg.repo;
  document.getElementById('cfg-branch').value = cfg.branch;
  document.getElementById('cfg-path').value = cfg.postsPath;
  // Seed dropdown with current repo so it's selectable even before re-validating
  if (cfg.repo && !_allRepos.includes(cfg.repo)) {
    _allRepos = [cfg.repo, ..._allRepos.filter(r => r !== cfg.repo)];
    renderRepoDropdown(_allRepos);
  }
  // Show/hide cancel button depending on whether config is required
  document.getElementById('modal-cancel-btn').style.display = _configRequired ? 'none' : '';
  document.getElementById('modal-title').textContent =
    _configRequired ? 'Connect to GitHub to continue' : 'GitHub settings';
  document.getElementById('modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById(cfg.token ? 'cfg-repo' : 'cfg-token').focus(), 50);
};

window.closeModal = function() {
  if (_configRequired) return;
  document.getElementById('modal-overlay').classList.remove('show');
};

window.modalOk = async function() {
  const token = document.getElementById('cfg-token').value.trim();
  const repo = document.getElementById('cfg-repo').value.trim();
  const branch = document.getElementById('cfg-branch').value.trim() || 'main';
  const postsPath = document.getElementById('cfg-path').value.trim() || 'content/blog';

  if (!token || !repo) { toast('token and repo are required', 'error'); return; }

  cfg = { token, repo, branch, postsPath };
  _configRequired = false;

  await savePersistedConfig();

  document.getElementById('repo-display-text').textContent = `${repo} (${branch})`;
  document.getElementById('modal-overlay').classList.remove('show');
  await loadPosts();
};

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay') && !_configRequired) closeModal();
});

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modal-overlay').classList.contains('show')) {
    e.preventDefault();
    closeModal(); // no-op when _configRequired
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 's') { e.preventDefault(); saveDraft(); }
    if (e.key === 'Enter') { e.preventDefault(); publish(); }
    if (e.key === 'n') { e.preventDefault(); newPost(); }
    if (e.key === 'p') { e.preventDefault(); togglePreview(); }
    if (e.key === ',') { e.preventDefault(); openSettings(); }
  }
});

// ── Splitter drag ─────────────────────────────────────────────────
const splitter = document.getElementById('splitter');
let _splitterDragging = false;
let _splitterStartX, _splitterStartWrapWidth;

function _zoomedX(clientX) {
  // e.clientX is in physical viewport pixels; offsetWidth is in the pre-zoom
  // coordinate space. Divide by body zoom so the delta is in the same units.
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  return clientX / zoom;
}

function _splitterStart(clientX) {
  _splitterDragging = true;
  _splitterStartX = _zoomedX(clientX);
  _splitterStartWrapWidth = document.getElementById('md-editor-wrap').offsetWidth;
  splitter.classList.add('dragging');
}

function _splitterMove(clientX) {
  if (!_splitterDragging) return;
  const wrap  = document.getElementById('md-editor-wrap');
  const pv    = document.getElementById('preview-pane');
  const total = wrap.offsetWidth + splitter.offsetWidth + pv.offsetWidth;
  const dx    = _zoomedX(clientX) - _splitterStartX;
  const newW  = Math.max(200, Math.min(total - 200, _splitterStartWrapWidth + dx));
  wrap.style.flex  = 'none';
  wrap.style.width = newW + 'px';
  pv.style.flex    = '1';
  pv.style.width   = '';
}

function _splitterEnd() {
  _splitterDragging = false;
  splitter.classList.remove('dragging');
}

splitter.addEventListener('mousedown', e => { _splitterStart(e.clientX); e.preventDefault(); });
document.addEventListener('mousemove', e => _splitterMove(e.clientX));
document.addEventListener('mouseup',   _splitterEnd);

// Touch support (e.g. Android preview mode)
splitter.addEventListener('touchstart', e => { _splitterStart(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove',  e => { if (_splitterDragging) { _splitterMove(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
document.addEventListener('touchend',   _splitterEnd);

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  try {
    // Stamp the editor placeholder with the build's git hash
    if (window.__TAURI_INTERNALS__) {
      const hash = await tauriInvoke('git_hash').catch(() => null);
      if (hash) {
        document.getElementById('md-editor').placeholder =
          `start writing in markdown…  [${hash}]`;
      }
    }

    // Try loading from Tauri store; fall back to sessionStorage
    const saved = await loadPersistedConfig()
      || JSON.parse(sessionStorage.getItem('cfg') || 'null');

    if (saved) {
      if (saved.token)     cfg.token     = saved.token;
      if (saved.repo)      cfg.repo      = saved.repo;
      if (saved.branch)    cfg.branch    = saved.branch;
      // Rust returns posts_path (snake_case); JS config uses postsPath
      if (saved.postsPath || saved.posts_path)
        cfg.postsPath = saved.postsPath || saved.posts_path;
    }

    if (cfg.repo) {
      document.getElementById('repo-display-text').textContent =
        `${cfg.repo} (${cfg.branch})`;
    }

    if (cfg.token && cfg.repo) {
      await loadPosts();
    } else {
      setTimeout(openSettings, 200);
    }
  } catch (e) {
    console.error('init failed:', e);
    setTimeout(openSettings, 200);
  }
}

init();
