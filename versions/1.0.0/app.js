// ─── 工具函数 ────────────────────────────────────────────────────────────────

function extractDriveFileId(url) {
  url = url.trim();
  if (!url) return null;
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/,
    /drive\.google\.com\/open\?.*id=([a-zA-Z0-9_-]{10,})/,
    /drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]{10,})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function isDriveFolderUrl(url) {
  return /drive\.google\.com\/drive\/folders\//.test(url);
}

function buildDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
}

function viewUrlFor(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

// 把一行/一段文本里夹带的链接抠出来：支持 Markdown [文字](url)、
// <url>、引号包裹、行尾多余标点；无协议头的裸域名补 https://。
function cleanUrlToken(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^<+/, '').replace(/>+$/, '');
  s = s.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  // Markdown 链接只取括号里的 URL
  const md = /\[.*?\]\((https?:\/\/[^)\s]+)\)/.exec(s);
  if (md) s = md[1];
  // 行尾跟在 URL 后面的中文标点/句号/逗号一律去掉（URL 本身极少以它们结尾）
  s = s.replace(/[。；，、]+$/, '');
  // 末尾不成对的 ) ] } 去掉，成对的保留（如维基式 URL）
  while (/[)\]}]$/.test(s)) {
    const close = s[s.length - 1];
    const open = close === ')' ? '(' : close === ']' ? '[' : '{';
    const opens = s.split(open).length - 1;
    const closes = s.split(close).length - 1;
    if (closes > opens) s = s.slice(0, -1); else break;
  }
  s = s.replace(/[,;]+$/, '');
  return s;
}

function normalizeUrl(raw) {
  const s = cleanUrlToken(raw);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // 裸域名：example.com/path/file.zip
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(\/\S*)?$/.test(s)) return 'https://' + s;
  return null;
}

function extractUrlsFromText(text) {
  const found = [];
  // 先找带协议的 URL（可能一行里夹杂文字）
  const re = /https?:\/\/[^\s<>"']+/g;
  let m;
  while ((m = re.exec(text))) {
    const u = normalizeUrl(m[0]);
    if (u && !found.includes(u)) found.push(u);
  }
  // 再找同一行里剩下的裸域名链接（去掉已找到的 URL，避免把它的域名重复算一次）
  const rest = text.replace(/https?:\/\/[^\s<>"']+/g, ' ');
  const bareRe = /(?:^|[\s,，;；<>"'(\[])([a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(?:\/[^\s<>"'\)\]]*)?)/g;
  while ((m = bareRe.exec(rest))) {
    const u = normalizeUrl(m[1]);
    if (u && !found.includes(u)) found.push(u);
  }
  return found;
}

function guessDisplayName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let last = parts.length ? parts[parts.length - 1] : '';
    try { last = decodeURIComponent(last); } catch (e) { /* ignore */ }
    if (last && !/^(download|get|file|files|dl|uc|open|view)$/i.test(last)) return last;
    return u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch (e) {
    return url;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function statusLabel(s) {
  return {
    pending: '待下载',
    downloading: '下载中…',
    done: '✓ 完成',
    error: '✗ 失败',
    skipped: '↗ 已新开分页',
  }[s] || s;
}

// 文件大小格式化：1024 进制，保留 1 位小数（末尾 .0 去掉）。
// 字节数只能是下载完成后的实际写盘字节（或浏览器下载前响应头给的预估），
// 拿不到时返回 null，界面显示“大小未知”，绝不编一个数。
function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const s = (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[u]}`;
}

function sizeLabel(bytes) {
  const s = formatFileSize(bytes);
  return s === null ? '大小未知' : s;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function flashCopied(btn, okText) {
  const original = btn.innerHTML;
  btn.innerHTML = okText;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('copied');
  }, 1200);
}

// ─── 状态 ────────────────────────────────────────────────────────────────────
let parsedFiles = [];
let invalidLines = [];
let folderStatus = { configured: false };
let sessionState = 'idle'; // idle | running | paused | finished
let pauseRequested = false;
let defaultBtnHTML = '';
// 最近一次下载成功的文件（打开文件夹按钮用）：浏览器下载的有 downloadId
// 可精确定位，固定文件夹模式的只有文件夹名（见 background openDownloadFolder）。
let lastSuccess = null;

const MAX_BATCH = 500;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const linkInput = document.getElementById('linkInput');
const linksList = document.getElementById('linksList');
const linkCount = document.getElementById('linkCount');
const parsedCount = document.getElementById('parsedCount');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const openFolderBtn = document.getElementById('openFolderBtn');
const summaryLine = document.getElementById('summaryLine');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const settingsBtn = document.getElementById('settingsBtn');
const folderBar = document.getElementById('folderBar');
const folderBarText = document.getElementById('folderBarText');
const folderBarAction = document.getElementById('folderBarAction');
const invalidWrap = document.getElementById('invalidWrap');
const invalidList = document.getElementById('invalidList');
const invalidCount = document.getElementById('invalidCount');

defaultBtnHTML = downloadBtn.innerHTML;

// ─── 设置入口 ────────────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
folderBarAction.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ─── 文件夹 / 下载方式状态检测 ───────────────────────────────────────────────
async function refreshFolderStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'get-folder-status' }, (res) => {
      folderStatus = res || { configured: false };
      renderFolderBar();
      resolve(folderStatus);
    });
  });
}

function folderReady() {
  if (folderStatus.mode === 'browser') return true;
  if (folderStatus.effectiveReady !== undefined) return folderStatus.effectiveReady;
  return folderStatus.configured && folderStatus.permission === 'granted';
}

function renderFolderBar() {
  if (folderStatus.mode === 'browser') {
    folderBar.className = 'folder-bar ok';
    folderBarText.textContent = '浏览器下载模式：保存到浏览器默认下载文件夹（按日期分子文件夹）';
    folderBarAction.textContent = '更改';
    updateDownloadBtnUI();
    return;
  }
  if (!folderStatus.configured) {
    folderBar.className = 'folder-bar warn';
    folderBarText.textContent = '尚未设置保存文件夹，未设置时将改用浏览器下载（默认下载文件夹）';
    folderBarAction.textContent = '去设置';
    updateDownloadBtnUI();
    return;
  }
  if (folderStatus.permission !== 'granted') {
    folderBar.className = 'folder-bar warn';
    folderBarText.textContent = `「${folderStatus.name}」授权已失效，未修复时将改用浏览器下载`;
    folderBarAction.textContent = '重新授权';
    updateDownloadBtnUI();
    return;
  }
  folderBar.className = 'folder-bar ok';
  folderBarText.textContent = `保存至：${folderStatus.name}`;
  folderBarAction.textContent = '更换';
  updateDownloadBtnUI();
}

refreshFolderStatus();
window.addEventListener('focus', refreshFolderStatus);

// ─── 链接解析：Drive 走文件 ID，别的 http/https 链接原样收 ──────────────────
linkInput.addEventListener('input', parseLinks);
linkInput.addEventListener('paste', () => setTimeout(parseLinks, 50));

function parseLinks() {
  const rawText = linkInput.value || '';
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);

  const seen = new Set();
  const newFiles = [];
  const prevByKey = new Map(parsedFiles.map(f => [f.key, f]));
  const bad = [];

  for (const line of lines) {
    const urls = extractUrlsFromText(line);
    if (urls.length === 0) {
      bad.push({ line, reason: '没有可识别的 http/https 链接' });
      continue;
    }
    for (const url of urls) {
      if (isDriveFolderUrl(url)) {
        bad.push({ line: url, reason: '这是 Drive 文件夹链接，不是单个文件，无法直接下载' });
        continue;
      }
      const driveId = extractDriveFileId(url);
      let item;
      if (driveId) {
        const key = 'drive:' + driveId;
        if (seen.has(key)) continue;
        seen.add(key);
        item = prevByKey.get(key) || {
          key, kind: 'drive', id: driveId,
          url: buildDownloadUrl(driveId), originalUrl: url,
          displayName: 'Drive 文件 · ' + driveId, status: 'pending', sizeBytes: null,
        };
        item.originalUrl = url;
      } else {
        let normalized = url;
        try { normalized = new URL(url).href; } catch (e) { /* 保留原样 */ }
        const key = 'url:' + normalized;
        if (seen.has(key)) continue;
        seen.add(key);
        item = prevByKey.get(key) || {
          key, kind: 'generic', id: null,
          url: normalized, originalUrl: url,
          displayName: guessDisplayName(normalized), status: 'pending', sizeBytes: null,
        };
        item.url = normalized;
        item.originalUrl = url;
      }
      newFiles.push(item);
      if (newFiles.length >= MAX_BATCH) break;
    }
    if (newFiles.length >= MAX_BATCH) break;
  }

  parsedFiles = newFiles;
  invalidLines = bad;

  const total = parsedFiles.length;
  linkCount.textContent = `${total} 个`;
  parsedCount.textContent = total;
  parsedCount.className = 'badge' + (total === 0 ? ' zero' : '');

  if (sessionState !== 'running') {
    sessionState = 'idle';
    lastSuccess = null; // 粘贴新链接重新开始：上一轮的“打开文件夹”收起
  }
  renderFolderBar();
  renderList();
  renderInvalid();
}

function renderInvalid() {
  if (!invalidWrap) return;
  if (invalidLines.length === 0) {
    invalidWrap.style.display = 'none';
    return;
  }
  invalidWrap.style.display = 'block';
  invalidCount.textContent = `${invalidLines.length} 行未识别`;
  invalidList.innerHTML = invalidLines.slice(0, 20).map(b =>
    `<div class="invalid-item"><span class="invalid-line">${escapeHtml(b.line.slice(0, 120))}</span><span class="invalid-reason">${escapeHtml(b.reason)}</span></div>`
  ).join('') + (invalidLines.length > 20 ? `<div class="invalid-more">还有 ${invalidLines.length - 20} 行未列出</div>` : '');
}

// ─── 渲染列表 ────────────────────────────────────────────────────────────────
const GROUPS = [
  { key: 'active', statuses: ['pending', 'downloading'], label: '⏳ 待下载 / 进行中', cls: 'g-active', copy: false },
  { key: 'error', statuses: ['error'], label: '❌ 失败', cls: 'g-failed', copy: true },
  { key: 'skipped', statuses: ['skipped'], label: '↗ 已新开分页', cls: 'g-skipped', copy: true },
  { key: 'done', statuses: ['done'], label: '✓ 成功', cls: 'g-done', copy: false },
];

function copyUrlFor(f) {
  return f.kind === 'drive' && f.id ? viewUrlFor(f.id) : f.originalUrl;
}

function renderList() {
  if (parsedFiles.length === 0) {
    linksList.innerHTML = `
      <div class="empty-hint">
        <span class="empty-icon">🔗</span>
        粘贴任意文件链接后自动识别（每行一个，也可混在文字里）
      </div>`;
    return;
  }

  let html = '';

  for (const group of GROUPS) {
    const items = parsedFiles
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => group.statuses.includes(f.status));
    if (items.length === 0) continue;

    html += `
      <div class="group-header ${group.cls}">
        <span>${group.label}</span>
        <span class="group-count">(${items.length})</span>
        ${group.copy ? `<button class="group-copy-btn" data-group="${group.key}">📋 复制全部链接</button>` : ''}
      </div>`;

    html += items.map(({ f, i }) => `
      <div class="link-item ${f.status}" data-index="${i}">
        <div class="link-dot"></div>
        <div class="link-id" title="${escapeHtml(f.originalUrl)}">
          <span class="kind-badge ${f.kind}">${f.kind === 'drive' ? 'Drive' : '通用'}</span>
          ${escapeHtml(f.displayName)}
          <div class="link-url">${escapeHtml(f.originalUrl)}</div>
          ${f.message ? `<div class="link-message">${escapeHtml(f.message)}</div>` : ''}
        </div>
        <div class="link-side">
          <div class="link-status">${statusLabel(f.status)}</div>
          <div class="link-size${f.sizeBytes === null || f.sizeBytes === undefined ? ' unknown' : ''}">${escapeHtml(sizeLabel(f.sizeBytes))}</div>
        </div>
        <button class="icon-btn open-btn" data-index="${i}" title="在新标签页打开原链接">↗</button>
        <button class="icon-btn copy-btn" data-index="${i}" title="复制链接">📋</button>
        ${f.status === 'pending' ? `<button class="icon-btn remove-btn" data-index="${i}" title="移除">✕</button>` : ''}
      </div>`).join('');
  }

  linksList.innerHTML = html;

  linksList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      parsedFiles.splice(idx, 1);
      parsedCount.textContent = parsedFiles.length;
      parsedCount.className = 'badge' + (parsedFiles.length === 0 ? ' zero' : '');
      renderFolderBar();
      renderList();
    });
  });

  linksList.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      const file = parsedFiles[idx];
      if (!file) return;
      const ok = await copyText(copyUrlFor(file));
      if (ok) flashCopied(e.currentTarget, '✓');
    });
  });

  linksList.querySelectorAll('.open-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      const file = parsedFiles[idx];
      if (!file) return;
      chrome.runtime.sendMessage({ action: 'open-tab', url: file.originalUrl });
    });
  });

  linksList.querySelectorAll('.group-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.group;
      const group = GROUPS.find(g => g.key === key);
      if (!group) return;
      const urls = parsedFiles
        .filter(f => group.statuses.includes(f.status))
        .map(f => copyUrlFor(f));
      if (urls.length === 0) return;
      const ok = await copyText(urls.join('\n'));
      if (ok) flashCopied(e.currentTarget, `✓ 已复制 ${urls.length} 条链接`);
    });
  });
}

// ─── 打开文件夹按钮 & 完成汇总行（确认稿改动 1）────────────────────────────
// 出现规矩（确认稿定的）：全部下载结束（finished）且至少成功 1 个时出现；
// 还没下载、下载中、暂停、全部失败、清空、粘贴新链接重新开始时都不出现。
function updateOpenFolderBtn() {
  if (!openFolderBtn) return;
  const show = sessionState === 'finished' && parsedFiles.some((f) => f.status === 'done');
  openFolderBtn.style.display = show ? 'flex' : 'none';
}

function updateSummary() {
  if (!summaryLine) return;
  if (sessionState !== 'finished') {
    summaryLine.className = 'summary-line';
    summaryLine.textContent = '';
    return;
  }
  const done = parsedFiles.filter((f) => f.status === 'done').length;
  const failed = parsedFiles.filter((f) => f.status === 'error').length;
  const anySize = parsedFiles.some((f) => f.status === 'done' && typeof f.sizeBytes === 'number' && Number.isFinite(f.sizeBytes));
  const totalBytes = parsedFiles
    .filter((f) => f.status === 'done')
    .reduce((a, f) => a + (typeof f.sizeBytes === 'number' && Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  summaryLine.className = 'summary-line visible' + (done === 0 ? ' bad' : ' ok');
  summaryLine.textContent = `全部完成 · 成功 ${done} 个 · 失败 ${failed} 个` + (anySize ? ` · 共 ${formatFileSize(totalBytes)}` : '');
}

if (openFolderBtn) {
  openFolderBtn.addEventListener('click', () => {
    if (!lastSuccess) return;
    chrome.runtime.sendMessage({ action: 'open-folder', downloadId: lastSuccess.downloadId || null }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        showToast((res && res.message) || '打开下载文件夹失败');
        return;
      }
      if (res.via === 'show') {
        showToast('已打开下载文件夹，并定位到最近成功的文件');
      } else {
        // 固定文件夹模式：Chrome 只能打开浏览器默认下载文件夹，这里把本次
        // 真正的保存位置报出来，不让用户以为打开的就是它。
        showToast(`已打开浏览器默认下载文件夹（本次保存在「${lastSuccess.folder || '下载文件夹'}」）`);
      }
    });
  });
}

// ─── 下载 / 暂停 / 继续 ────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', onDownloadBtnClick);

function onDownloadBtnClick() {
  if (sessionState === 'running') {
    pauseRequested = true;
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = '⏳ 暂停中…（等待当前文件完成）';
    return;
  }
  startDownload();
}

function updateDownloadBtnUI() {
  updateOpenFolderBtn();
  updateSummary();

  const ready = folderReady();

  if (sessionState === 'running') {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = '⏸ 暂停';
    return;
  }
  if (sessionState === 'paused') {
    downloadBtn.disabled = !ready;
    downloadBtn.innerHTML = '▶ 继续下载';
    return;
  }
  if (sessionState === 'finished') {
    const anyError = parsedFiles.some(f => f.status === 'error');
    downloadBtn.disabled = !ready || parsedFiles.length === 0;
    downloadBtn.innerHTML = anyError ? '↻ 重新下载失败项' : '✓ 全部完成';
    return;
  }
  downloadBtn.disabled = !ready || parsedFiles.length === 0;
  downloadBtn.innerHTML = defaultBtnHTML;
}

async function startDownload() {
  if (parsedFiles.length === 0 || sessionState === 'running') return;

  await refreshFolderStatus();
  if (!folderReady()) {
    renderFolderBar();
    return;
  }

  sessionState = 'running';
  pauseRequested = false;
  clearBtn.disabled = true;
  progressWrap.classList.add('visible');
  updateDownloadBtnUI();

  let stoppedForFolder = false;

  for (let i = 0; i < parsedFiles.length; i++) {
    if (pauseRequested) break;

    const file = parsedFiles[i];
    if (file.status === 'done' || file.status === 'skipped') continue;

    file.status = 'downloading';
    renderList();
    updateProgress();

    try {
      const res = await downloadFile(file);
      if (res.success) {
        file.status = 'done';
        if (typeof res.sizeBytes === 'number' && Number.isFinite(res.sizeBytes) && res.sizeBytes >= 0) {
          file.sizeBytes = res.sizeBytes;
        }
        if (typeof res.downloadId === 'number') file.downloadId = res.downloadId;
        if (res.folder) file.folder = res.folder;
        if (res.filename) file.savedFilename = res.filename;
        lastSuccess = {
          downloadId: file.downloadId || null,
          folder: file.folder || '',
          filename: file.savedFilename || file.displayName,
        };
        const notes = [];
        if (res.bypassedInterstitial) notes.push('已自动跳过“病毒扫描确认”页');
        if (res.via === 'browser') notes.push(`已交由浏览器下载${res.folder ? '（' + res.folder + '）' : ''}，请在浏览器下载栏确认`);
        if (res.note) notes.push(res.note);
        if (res.filename) notes.push('已保存为 ' + res.filename);
        if (res.renamed) notes.push(`因文件名含系统不支持的字符，已自动重命名为 ${res.filename}`);
        file.message = notes.length ? notes.join('；') : undefined;
      } else if (res.skipped) {
        file.status = 'skipped';
        file.message = res.message;
      } else if (res.error === 'NO_FOLDER' || res.error === 'NO_PERMISSION') {
        file.status = 'pending';
        stoppedForFolder = true;
        await refreshFolderStatus();
      } else {
        file.status = 'error';
        file.message = res.message;
      }
    } catch (e) {
      file.status = 'error';
      file.message = e.message;
    }

    renderList();
    updateProgress();

    if (stoppedForFolder) break;
    if (pauseRequested) break;
    if (i < parsedFiles.length - 1) await sleep(400);
  }

  clearBtn.disabled = false;

  if (stoppedForFolder) {
    sessionState = 'paused';
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = '⚠ 文件夹异常，请先设置';
  } else {
    sessionState = pauseRequested ? 'paused' : 'finished';
    updateDownloadBtnUI();
  }

  renderFolderBar();
}

function downloadFile(file) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'download', url: file.url, originalUrl: file.originalUrl, fileId: file.id, kind: file.kind },
      (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response || { success: false, message: '未知错误' });
      }
    );
  });
}

function updateProgress() {
  const total = parsedFiles.length;
  const settled = parsedFiles.filter(f => f.status === 'done' || f.status === 'skipped' || f.status === 'error').length;
  const pct = total > 0 ? Math.round((settled / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `${settled} / ${total}  (${pct}%)`;
}

// ─── 清空 ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (sessionState === 'running') return;
  linkInput.value = '';
  parsedFiles = [];
  invalidLines = [];
  lastSuccess = null;
  sessionState = 'idle';
  pauseRequested = false;
  parsedCount.textContent = '0';
  parsedCount.className = 'badge zero';
  linkCount.textContent = '0 个';
  progressWrap.classList.remove('visible');
  progressFill.style.width = '0%';
  updateDownloadBtnUI();
  renderList();
  renderInvalid();
});

updateDownloadBtnUI();

// ─── 版本药丸 & 更新检查（照搬提醒助手的成熟模式）────────────────────────
// 更新源：GitHub 公开的最新 Release。实际请求由后台 service worker 发起
// 并做缓存、节流与限流退避；这里只比较版本号、画药丸和弹更新窗口。
// 静默检查：页面打开时做一次，只刷新药丸；有新版才弹更新窗口，无新版不弹任何东西。
// 手动检查：点药丸，1 分钟最多 3 次，超出只弹气泡、不发请求；无新版弹气泡报当前版本。
const UPDATE_REPO_OWNER = 'bstbuku-ship-it';
const UPDATE_REPO_NAME = 'batch-downloader';
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;
const IGNORED_UPDATE_KEY = 'bd_ignored_update';
const updateState = { release: null, dismissedTag: null, manualChecks: [], ignoredTag: null, checkSeq: 0 };
const versionPill = document.getElementById('versionPill');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function parseVersionTag(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().replace(/^v/i, '').match(/^(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function compareVersions(a, b) {
  const pa = parseVersionTag(a);
  const pb = parseVersionTag(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
function currentVersion() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return '1.0.0'; }
}
function isNewerRelease(release) {
  return !!release && compareVersions(release.tag, `v${currentVersion()}`) > 0;
}

function loadIgnoredTag() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(IGNORED_UPDATE_KEY, (d) => {
        const v = d && d[IGNORED_UPDATE_KEY];
        updateState.ignoredTag = (typeof v === 'string' && parseVersionTag(v)) ? v : null;
        resolve(updateState.ignoredTag);
      });
    } catch (_) { updateState.ignoredTag = null; resolve(null); }
  });
}

function setVersionPill(release) {
  if (!versionPill) return;
  versionPill.textContent = `v${currentVersion()}`;
  const showUpdate = release && isNewerRelease(release) && release.tag !== updateState.ignoredTag;
  versionPill.classList.toggle('update-available', !!showUpdate);
  versionPill.title = showUpdate ? `有新版本 ${release.tag} 可用，点击查看更新` : '点击检查更新';
}

function requestUpdateCheck(force) {
  return new Promise((resolve, reject) => {
    // 20 秒超时兜底：后台请求挂起或 service worker 未唤醒时，不让界面永远等下去。
    const timer = setTimeout(() => reject(new Error('检查更新超时，请稍后再试')), 20000);
    try {
      chrome.runtime.sendMessage({ type: 'checkUpdate', force: !!force }, (res) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || '无法联系后台')); return; }
        if (!res || !res.ok) { reject(new Error((res && res.error) || '检查更新失败')); return; }
        resolve(res.release || null);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function checkForUpdates({ force = false, showDialog = true, showLatestToast = false } = {}) {
  // 序号：后发起的检查优先，先发起的检查晚到时不再弹气泡/窗口，避免盖掉最新的反馈。
  const mySeq = ++updateState.checkSeq;
  if (force) {
    const now = Date.now();
    updateState.manualChecks = updateState.manualChecks.filter((t) => now - t < 60000);
    if (updateState.manualChecks.length >= 3) {
      showToast('操作频繁，请稍后再试。');
      return null;
    }
    updateState.manualChecks.push(now);
  }
  await loadIgnoredTag();
  try {
    const release = await requestUpdateCheck(force);
    updateState.release = release;
    if (release && isNewerRelease(release)) {
      if (force) {
        updateState.dismissedTag = null; // 手动点药丸：本轮内重新提醒，不受之前关掉的影响
        if (release.tag === updateState.ignoredTag) {
          // 手动点药丸：重新提醒一次，清除本次的“暂时忽略”。
          updateState.ignoredTag = null;
          try { chrome.storage.local.remove(IGNORED_UPDATE_KEY); } catch (_) { /* 忽略 */ }
        }
      }
      setVersionPill(release);
      if (mySeq !== updateState.checkSeq) return release; // 已有更新的检查，不再弹窗口
      const ov = document.getElementById('upd-overlay');
      if (showDialog && release.tag !== updateState.dismissedTag && ov && ov.classList.contains('hidden')) showUpdateDialog(release);
      return release;
    }
    setVersionPill(release);
    if (mySeq !== updateState.checkSeq) return release;
    if (force && showLatestToast) showToast(`当前已是最新版本（v${currentVersion()}）。`);
    return release;
  } catch (err) {
    if (mySeq !== updateState.checkSeq) return null;
    if (force) showToast(`检查更新失败：${err.message || err}`);
    else if (typeof console !== 'undefined' && console.error) console.error(err);
    return null;
  }
}

// 发布页链接只接受本仓库的 releases 地址，其余一律用固定 Releases 首页兜底。
function safeReleaseUrl(raw) {
  try {
    const u = new URL(raw);
    const prefix = `/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/`.toLowerCase();
    if (u.origin === 'https://github.com' && u.pathname.toLowerCase().startsWith(prefix)) {
      return u.href.slice(0, 2048);
    }
  } catch (_) { /* 不是合法 URL，用兜底 */ }
  return UPDATE_RELEASES_URL;
}

function showUpdateDialog(release) {
  const ov = document.getElementById('upd-overlay');
  if (!ov) return;
  const curEl = document.getElementById('upd-cur');
  const newEl = document.getElementById('upd-new');
  const nameEl = document.getElementById('upd-name');
  const notesEl = document.getElementById('upd-notes');
  const closeBtn = document.getElementById('upd-close');
  const ignoreBtn = document.getElementById('upd-ignore');
  const goBtn = document.getElementById('upd-go');
  if (curEl) curEl.textContent = `当前版本 v${currentVersion()}`;
  if (newEl) newEl.textContent = release.tag;
  if (nameEl) {
    if (release.name && release.name !== release.tag) {
      nameEl.textContent = release.name;
      nameEl.classList.remove('hidden');
    } else {
      nameEl.textContent = '';
      nameEl.classList.add('hidden');
    }
  }
  if (notesEl) {
    if (release.body) {
      notesEl.textContent = release.body;
      notesEl.classList.remove('hidden');
    } else {
      notesEl.textContent = '';
      notesEl.classList.add('hidden');
    }
  }
  const close = () => {
    updateState.dismissedTag = release.tag;
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', onKey);
    ov.classList.add('hidden');
    // 关闭或前往下载后药丸仍保持橙色，只有“暂时忽略”才恢复灰色。
    setVersionPill(release);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', onKey);
  if (closeBtn) closeBtn.onclick = close;
  if (ignoreBtn) ignoreBtn.onclick = () => {
    updateState.ignoredTag = release.tag;
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', onKey);
    try { chrome.storage.local.set({ [IGNORED_UPDATE_KEY]: release.tag }); } catch (_) { /* 忽略 */ }
    setVersionPill(release);
    ov.classList.add('hidden');
  };
  if (goBtn) goBtn.onclick = async () => {
    const url = safeReleaseUrl(release.html_url);
    try {
      if (chrome.tabs && chrome.tabs.create) await chrome.tabs.create({ url });
      else window.open(url, '_blank');
    } catch (_) {
      try { window.open(url, '_blank'); } catch (_) { /* 打开失败时用户可手动访问 Releases 页 */ }
    }
    close();
  };
  ov.onmousedown = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
  if (goBtn && goBtn.focus) goBtn.focus();
}

// 点版本号药丸就是一次手动检查：无新版也给气泡，有新版弹更新窗口。
if (versionPill) {
  versionPill.addEventListener('click', () => {
    checkForUpdates({ force: true, showDialog: true, showLatestToast: true });
  });
  // 页面打开时做一次静默检查：只刷新药丸，有新版才弹更新窗口，无新版不弹任何东西。
  setVersionPill(null);
  checkForUpdates({ force: false, showDialog: true, showLatestToast: false });
}
