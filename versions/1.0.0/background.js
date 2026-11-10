// background.js — Service Worker（通用批量下载）
// build: 2026-11-09 rev2 — UI 确认稿三处：打开文件夹 / 文件大小 / 固定高度（版本仍 v1.0.0）
// 识别逻辑不再限定 Google Drive：
//  1) Drive 链接走原来的 fetch + 确认页跳过 + 固定文件夹写入；
//  2) 任意 http/https 链接走通用路径：先读响应头推断文件名，HTML 网页不
//     当文件写盘、改为新开分页；text/plain 等是正经文件，不再误判为确认页；
//  3) 没设固定文件夹、或固定文件夹不可用时，改走 chrome.downloads 交给
//     浏览器下载（仍按日期分子文件夹，无法推断文件名时由浏览器按服务器
//     建议命名），下载本身不再被文件夹设置卡住。
// 链接只用来向它自己的源站发请求、写入本地磁盘或新开分页，不上传到别处。
// 文件名一律经过 sanitizeName 净化，含 ../ 一律变下划线，不会写出目标目录。

importScripts('idb.js');
// 注意：idb.js 里数据库名/键名保持原样（gdrive_dl_db / dirHandle），
// 改名后老用户已选的固定文件夹不丢失。

// ── 点击工具栏图标：打开/聚焦一个常驻标签页 ──
chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL('app.html');
  try {
    const tabs = await chrome.tabs.query({ url: appUrl });
    if (tabs.length > 0) {
      const tab = tabs[0];
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: appUrl });
    }
  } catch (e) {
    chrome.tabs.create({ url: appUrl });
  }
});

// ── 日期文件夹 ──────────────────────────────────────────────────────────────
function getTodayDateStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

// ── 下载方式设置：auto（默认）/ folder（只用固定文件夹）/ browser（只用浏览器下载） ──
async function getDownloadMode() {
  try {
    if (chrome.storage && chrome.storage.local) {
      const r = await chrome.storage.local.get({ downloadMode: 'auto' });
      const m = r && r.downloadMode;
      if (m === 'folder' || m === 'browser' || m === 'auto') return m;
    }
  } catch (e) { /* 无 storage 时按 auto 处理 */ }
  return 'auto';
}

// ── 只接受 http/https，拒绝 javascript:/data:/file:/chrome: 等 ───────────────
function validateHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null;
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u;
}

function isDriveHost(hostname) {
  return /(^|\.)drive\.google\.com$/.test(hostname) ||
    /(^|\.)docs\.google\.com$/.test(hostname) ||
    /(^|\.)drive\.usercontent\.google\.com$/.test(hostname) ||
    /\.googleusercontent\.com$/.test(hostname);
}

// ── 从 Content-Disposition 解析真实文件名 ───────────────────────────────────
function fixLatin1Mojibake(str) {
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return str;
  }
}

function parseFilenameFromDisposition(cd, fallback) {
  if (!cd) return fallback;
  let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[1].replace(/^["']|["']$/g, '')); } catch (e) { /* ignore */ }
  }
  m = /filename="?([^";]+)"?/i.exec(cd);
  if (m) return fixLatin1Mojibake(m[1]);
  return fallback;
}

// ── 从 URL 路径取文件名（去掉查询串，解码，空段返回 ''）────────────────────
function basenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    let last = parts[parts.length - 1];
    try { last = decodeURIComponent(last); } catch (e) { /* 保留原样 */ }
    return last;
  } catch (e) {
    return '';
  }
}

const CONTENT_TYPE_EXT = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/x-7z-compressed': '.7z', 'application/x-rar-compressed': '.rar',
  'application/gzip': '.gz', 'application/x-tar': '.tar',
  'application/json': '.json', 'text/csv': '.csv', 'text/plain': '.txt',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/octet-stream': '',
};

function extForContentType(contentType) {
  const base = String(contentType || '').toLowerCase().split(';')[0].trim();
  return CONTENT_TYPE_EXT[base] || '';
}

function hasKnownExtension(name) {
  return /\.[a-zA-Z0-9]{1,10}$/.test(name || '');
}

// 优先级：Content-Disposition > URL 最后一段 > 主机名兜底；
// URL 段无扩展名时按 Content-Type 补扩展名；全程不信任原始字符串，
// 返回值调用方仍需 sanitizeName。
function inferFilename({ disposition, finalUrl, contentType, fallbackBase }) {
  const fromCd = parseFilenameFromDisposition(disposition, '');
  if (fromCd) return fromCd;
  let base = basenameFromUrl(finalUrl);
  // 常见“下载接口”式路径：/download、/uc、/open、/files/123、/get?id=…，最后一段不是文件名
  if (base && !hasKnownExtension(base)) {
    const ext = extForContentType(contentType);
    if (/^(download|get|file|files|dl|uc|open|view)$/i.test(base)) {
      base = '';
    } else if (ext) {
      base += ext;
    }
  }
  if (base) return base;
  if (fallbackBase) return fallbackBase + extForContentType(contentType);
  const host = (() => { try { return new URL(finalUrl).hostname; } catch (e) { return 'download'; } })();
  return host + extForContentType(contentType);
}

function isHtmlContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.startsWith('text/html') || ct.startsWith('application/xhtml+xml');
}

// ── Drive“病毒扫描确认页”解析（仅 Drive 路径用）────────────────────────────
// 确认表单的 action 只接受 Drive 域名（相对路径按 drive.google.com 解析）：
// 绝对地址指向外站时直接丢弃，绝不带着用户 Cookie 去请求外站、更不把
// 外站返回的正文当文件写盘（A-01）。
function resolveConfirmUrl(actionUrl) {
  try {
    const u = new URL(actionUrl, 'https://drive.google.com');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!isDriveHost(u.hostname)) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

function extractConfirmDownloadUrl(html) {
  if (!html) return null;
  let formMatch = /<form[^>]*id=["']download-form["'][^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) {
    formMatch = /<form[^>]*action=["']([^"']*(?:drive\.usercontent\.google\.com|drive\.google\.com)[^"']*download[^"']*)["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  }
  if (formMatch) {
    const actionUrl = formMatch[1];
    const formBody = formMatch[2];
    const params = new URLSearchParams();
    const inputRe = /<input\b[^>]*>/gi;
    let im;
    while ((im = inputRe.exec(formBody))) {
      const tag = im[0];
      const nameM = /\bname=["']([^"']+)["']/i.exec(tag);
      const valueM = /\bvalue=["']([^"']*)["']/i.exec(tag);
      if (nameM) params.set(nameM[1], valueM ? valueM[1] : '');
    }
    const base = resolveConfirmUrl(actionUrl);
    const qs = params.toString();
    if (base && qs) return `${base}?${qs}`;
    // action 指向外站：不直接返回，继续尝试下面的老结构链接兜底。
  }
  const linkMatch = /href="(\/uc\?export=download[^"]*confirm=[^"]*)"/i.exec(html);
  if (linkMatch) {
    return `https://drive.google.com${linkMatch[1].replace(/&amp;/g, '&')}`;
  }
  return null;
}

function looksLikeQuotaExceeded(html) {
  return /配额|quota|exceeded|超出|次数已达上限/i.test(html || '');
}

function sanitizeName(name) {
  const WINDOWS_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);
  let cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // 双向覆盖/零宽/不可见字符：防止 "report.pdf\u202Eexe" 这类文件名欺骗（A-03）
    .replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') cleaned = 'download';
  const dot = cleaned.lastIndexOf('.');
  const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  if (WINDOWS_RESERVED.has(base.toUpperCase())) cleaned = '_' + cleaned;
  if (cleaned.length > 150) {
    const d2 = cleaned.lastIndexOf('.');
    const hasExt = d2 > 0 && cleaned.length - d2 <= 12;
    const ext = hasExt ? cleaned.slice(d2) : '';
    const b2 = hasExt ? cleaned.slice(0, d2) : cleaned;
    cleaned = b2.slice(0, 150 - ext.length) + ext;
  }
  return cleaned;
}

async function fileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return false;
    throw e;
  }
}

async function uniqueFileName(dirHandle, name) {
  if (!(await fileExists(dirHandle, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 1;
  while (await fileExists(dirHandle, `${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

function extractSafeExtension(name) {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name);
  return m ? '.' + m[1] : '';
}

async function createFileHandleSafely(dayDirHandle, desiredName, safeId) {
  try {
    const finalName = await uniqueFileName(dayDirHandle, desiredName);
    const fileHandle = await dayDirHandle.getFileHandle(finalName, { create: true });
    return { fileHandle, name: finalName, renamed: false };
  } catch (e) {
    const ext = extractSafeExtension(desiredName);
    const safeBase = `${safeId}${ext}`;
    const safeName = await uniqueFileName(dayDirHandle, safeBase);
    const fileHandle = await dayDirHandle.getFileHandle(safeName, { create: true });
    return { fileHandle, name: safeName, renamed: true };
  }
}

async function checkPermission(handle) {
  if (!handle) return 'no-handle';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch (e) {
    return 'no-handle';
  }
}

async function writeResponseToFolder(resp, handle, filename, safeId) {
  const dateFolder = getTodayDateStr();
  let writable;
  let attemptedName = filename;
  let bytesWritten = 0;
  try {
    const dayDirHandle = await handle.getDirectoryHandle(dateFolder, { create: true });
    const created = await createFileHandleSafely(dayDirHandle, filename, safeId);
    attemptedName = created.name;
    writable = await created.fileHandle.createWritable();
    if (resp.body) {
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesWritten += value.byteLength;
        await writable.write(value);
      }
    } else {
      const buf = await resp.arrayBuffer();
      bytesWritten = buf.byteLength;
      await writable.write(buf);
    }
    await writable.close();
    return {
      success: true, filename: attemptedName,
      folder: `${handle.name}/${dateFolder}`,
      renamed: created.renamed,
      originalName: created.renamed ? filename : undefined,
      sizeBytes: bytesWritten,
    };
  } catch (e) {
    try { if (writable) await writable.abort(); } catch (e2) { /* ignore */ }
    return {
      success: false, error: 'WRITE_FAILED',
      message: `写入失败（文件名: ${attemptedName}）：${e.message || '未知错误'}`,
    };
  }
}

// ── 浏览器下载兜底：不读响应体，只把 URL 交给浏览器 ─────────────────────────
// filename 为 undefined 时由浏览器按服务器建议命名（会落在下载根目录，
// 不进日期子文件夹）；能推断出文件名时一律带上日期子文件夹。
// sizeBytes 由调用方从响应头里取到后传进来（浏览器下载本身不等它写完，
// 所以这里只透传，不另外等下载完成再查）。
function downloadViaBrowser(url, filename, sizeBytes) {
  return new Promise((resolve) => {
    try {
      const opts = { url, saveAs: false, conflictAction: 'uniquify' };
      if (filename) opts.filename = filename;
      chrome.downloads.download(opts, (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: 'BROWSER_DOWNLOAD_FAILED', message: chrome.runtime.lastError.message || '浏览器下载启动失败' });
          return;
        }
        resolve({ success: true, via: 'browser', downloadId, filename: filename || undefined, sizeBytes: (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0) ? sizeBytes : null });
      });
    } catch (e) {
      resolve({ success: false, error: 'BROWSER_DOWNLOAD_FAILED', message: e.message || '浏览器下载启动失败' });
    }
  });
}

// 只读响应头推断文件名与大小，不下载正文：拿到头就取消 body。
// Content-Length 不是每个服务器都给，给了也可能是分块传输后的近似值，
// 所以返回的 sizeBytes 只作“下载前预估”，真正写盘的大小以后台实际写盘字节为准。
function parseContentLength(headers) {
  const raw = headers.get('content-length');
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(n);
}

async function probeFileInfo(url, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 10000) : null;
  try {
    const resp = await fetch(url, { credentials: 'include', signal: ctrl ? ctrl.signal : undefined });
    const ct = resp.headers.get('content-type') || '';
    const cd = resp.headers.get('content-disposition');
    const name = inferFilename({ disposition: cd, finalUrl: resp.url || url, contentType: ct, fallbackBase: '' });
    const sizeBytes = parseContentLength(resp.headers);
    try { resp.body && resp.body.cancel(); } catch (e) { /* ignore */ }
    if (!resp.ok || isHtmlContentType(ct)) return null;
    return { name: sanitizeName(name), sizeBytes };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeFilename(url, timeoutMs) {
  const info = await probeFileInfo(url, timeoutMs);
  return info ? info.name : null;
}

function openTab(url) {
  try { chrome.tabs.create({ url }); } catch (e) { /* ignore */ }
}

// ── 打开下载文件夹（确认稿改动 1）───────────────────────────────────────────
// 浏览器下载的文件：用 chrome.downloads.show(downloadId) 打开文件夹并定位到该文件。
// 先经 chrome.downloads.search 核实该 id 确实存在，避免拿任意数字去探其它下载记录。
// 固定文件夹模式的文件：Chrome 不提供“打开任意文件夹”的接口，只能打开浏览器
// 默认下载文件夹（chrome.downloads.showDefaultFolder）。如果用户的固定文件夹
// 本来就是默认下载文件夹，结果就是对的；否则打开的是默认文件夹，页面侧会用
// 气泡把本次真正的保存位置报出来，不让用户以为打开的就是它。
async function openDownloadFolder(downloadId) {
  const id = (typeof downloadId === 'number' && Number.isInteger(downloadId) && downloadId >= 0) ? downloadId : null;
  if (id !== null && chrome.downloads && typeof chrome.downloads.search === 'function' && typeof chrome.downloads.show === 'function') {
    let items = [];
    try {
      items = await new Promise((resolve) => {
        try {
          chrome.downloads.search({ id }, (res) => {
            if (chrome.runtime.lastError) resolve([]);
            else resolve(Array.isArray(res) ? res : []);
          });
        } catch (e) { resolve([]); }
      });
    } catch (e) { items = []; }
    if (items.some((d) => d && d.id === id)) {
      try {
        chrome.downloads.show(id);
        return { success: true, via: 'show' };
      } catch (e) { /* 定位失败时继续走默认文件夹兜底 */ }
    }
  }
  try {
    if (chrome.downloads && typeof chrome.downloads.showDefaultFolder === 'function') {
      chrome.downloads.showDefaultFolder();
      return { success: true, via: 'default-folder' };
    }
  } catch (e) {
    return { success: false, error: 'SHOW_FAILED', message: e.message || '打开下载文件夹失败' };
  }
  return { success: false, error: 'NO_SHOW_API', message: '当前浏览器不支持打开下载文件夹' };
}

// ── 更新检查（GitHub Releases，照搬提醒助手的成熟模式）───────────────
// 只请求公开的 Release 信息，不发送任何下载链接或个人信息；
// 返回的字段经过白名单与长度校验。自动检查与手动检查的规则见 app.js。
// 仓库尚未建立：404 当作“还没有 Release”处理，不报错弹窗。
// 不硬编码任何认证 Token（是否加 Token 由用户决定）。
const UPDATE_REPO_OWNER = 'bstbuku-ship-it';
const UPDATE_REPO_NAME = 'batch-downloader';
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`;
const CACHE_KEY = 'bd_update_cache';
const RATELIMIT_KEY = 'bd_update_ratelimit_until';
const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 小时
const FORCE_THROTTLE_MS = 10000; // 手动检查至少间隔 10 秒
const MAX_BACKOFF_MS = 3600 * 1000; // 限流退避最多 1 小时
const MAX_TAG_LEN = 100;
const MAX_NAME_LEN = 500;
const MAX_BODY_LEN = 20000;
const MAX_URL_LEN = 2048;

let lastForceAt = 0;

// "v1.0" / "1.0" / "v1.2.3" -> [1,0,0] / [1,2,3]；非法返回 null。
// 每段最多 9 位数字，锚定整串匹配，避免 "1.0abc"、"1.0.1.2" 被当成合法版本号。
function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().replace(/^v/i, '').match(/^(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

// 发布页链接只接受本仓库的 releases 地址，其余一律用固定 Releases 首页兜底。
// 仓库名大小写以 GitHub 实际返回为准，这里按小写比较，避免大小写差异误判。
function safeReleaseUrl(raw) {
  try {
    const u = new URL(raw);
    const prefix = `/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/`.toLowerCase();
    if (u.origin === 'https://github.com' && u.pathname.toLowerCase().startsWith(prefix)) {
      return u.href.slice(0, MAX_URL_LEN);
    }
  } catch (_) { /* 不是合法 URL，用兜底 */ }
  return UPDATE_RELEASES_URL;
}

function sanitizeRelease(data) {
  if (!data || typeof data !== 'object') return null;
  // 接受 GitHub API 的 tag_name，也接受已缓存过的 tag（本函数对缓存再校验时是幂等的）。
  const rawTag = typeof data.tag_name === 'string' ? data.tag_name : (typeof data.tag === 'string' ? data.tag : null);
  if (!rawTag || !parseVersion(rawTag)) return null;
  const tag = rawTag.slice(0, MAX_TAG_LEN);
  const name = typeof data.name === 'string' ? data.name.slice(0, MAX_NAME_LEN) : tag;
  const body = typeof data.body === 'string' ? data.body.slice(0, MAX_BODY_LEN) : '';
  return { tag, name, body, html_url: safeReleaseUrl(data.html_url) };
}

function rateLimitErrorMessage(status, data, headers) {
  const msg = data && typeof data.message === 'string' ? data.message.slice(0, 200) : '';
  let resetMs = 0;
  const reset = headers.get('x-ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) resetMs = Number(reset) * 1000;
  const retryAfter = headers.get('retry-after');
  if (!resetMs && retryAfter && Number.isFinite(Number(retryAfter))) resetMs = Date.now() + Number(retryAfter) * 1000;
  const until = resetMs ? Math.min(resetMs, Date.now() + MAX_BACKOFF_MS) : Date.now() + 60000;
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return { until, text: `GitHub 返回 ${status}（API 调用次数已用完，约 ${minutes} 分钟后恢复${msg ? `：${msg}` : ''}）` };
}

async function checkRelease(force) {
  const now = Date.now();
  const cachedRaw = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
  // 缓存也要重新校验：存储里的记录可能被损坏或篡改，不能直接信任上次存的形状。
  const cached = cachedRaw && cachedRaw.release && typeof cachedRaw.checkedAt === 'number'
    ? { release: sanitizeRelease(cachedRaw.release), checkedAt: cachedRaw.checkedAt }
    : null;
  const rateLimitUntil = Number((await chrome.storage.local.get(RATELIMIT_KEY))[RATELIMIT_KEY]) || 0;

  if (force && now - lastForceAt < FORCE_THROTTLE_MS && cached && cached.release) {
    return cached.release; // 10 秒节流：直接用缓存，不再发请求
  }
  if (!force && cached && cached.release && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached.release; // 6 小时缓存
  }
  if (rateLimitUntil > now) {
    if (cached && cached.release) return cached.release; // 退避期内用缓存，不再发请求
    throw new Error(`GitHub API 调用次数已用完，约 ${Math.max(1, Math.ceil((rateLimitUntil - now) / 60000))} 分钟后恢复`);
  }

  if (force) lastForceAt = now;

  let res;
  try {
    // 15 秒超时：请求挂起时不让扩展页面的查询永远等不到回复（页面侧另有 20 秒超时兜底）。
    const timeoutSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(15000)
      : undefined;
    res = await fetch(UPDATE_API_URL, {
      signal: timeoutSignal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'batch-downloader-update-check'
      }
    });
  } catch (err) {
    throw new Error(`无法连接 GitHub：${err && err.message ? err.message : String(err)}`);
  }

  if (res.status === 404) {
    await chrome.storage.local.remove(RATELIMIT_KEY);
    return null; // 还没有任何 Release（仓库未建或未发布）
  }
  if (res.status === 403 || res.status === 429) {
    let data = null;
    try { data = await res.json(); } catch (_) { /* 只有状态码也够用 */ }
    const info = rateLimitErrorMessage(res.status, data, res.headers);
    await chrome.storage.local.set({ [RATELIMIT_KEY]: info.until });
    throw new Error(info.text);
  }
  if (!res.ok) {
    throw new Error(`GitHub 返回 ${res.status}`);
  }

  await chrome.storage.local.remove(RATELIMIT_KEY);
  let data;
  try { data = await res.json(); } catch (_) { return null; }
  const release = sanitizeRelease(data);
  if (release) {
    await chrome.storage.local.set({ [CACHE_KEY]: { release, checkedAt: Date.now() } });
  }
  return release;
}

// ── 消息路由 ────────────────────────────────────────────────────────────────
// 只回答本扩展自己的页面：sender.id 必须是本扩展的 id（A-02）。
// 未声明 externally_connectable 时外部页面/扩展本来就发不进来，
// 这里是纵深防御，与其他插件的审计结论保持一致。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    if (message && message.action === 'get-folder-status') sendResponse({ configured: false });
    else if (message && message.action === 'open-tab') sendResponse({ ok: false });
    else if (message && message.action === 'open-folder') sendResponse({ success: false, error: 'FORBIDDEN', message: '拒绝：发送方不是本扩展' });
    else if (message && message.action === 'download') sendResponse({ success: false, error: 'FORBIDDEN', message: '拒绝：发送方不是本扩展' });
    else if (message && message.type === 'checkUpdate') sendResponse({ ok: false, error: '拒绝：发送方不是本扩展' });
    return;
  }

  if (message.action === 'get-folder-status') {
    (async () => {
      const mode = await getDownloadMode();
      const handle = await getSavedDirHandle();
      if (!handle) {
        sendResponse({ configured: false, mode, effectiveReady: mode !== 'folder' });
        return;
      }
      const perm = await checkPermission(handle);
      sendResponse({
        configured: true, name: handle.name, permission: perm, mode,
        effectiveReady: mode === 'browser' || perm === 'granted',
      });
    })();
    return true;
  }

  if (message.action === 'open-tab') {
    if (message.url && validateHttpUrl(message.url)) openTab(message.url);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'open-folder') {
    openDownloadFolder(message.downloadId).then(sendResponse);
    return true;
  }

  if (message.action === 'download') {
    handleDownload(message).then(sendResponse);
    return true;
  }

  if (message.type === 'checkUpdate') {
    // 只回答本扩展自己的页面：sender.id 必须是本扩展的 id。
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: '拒绝：发送方不是本扩展' });
      return;
    }
    checkRelease(!!message.force)
      .then((release) => sendResponse({ ok: true, release }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true; // 异步回复
  }
});

async function handleDownload(message) {
  const rawUrl = message.url || message.originalUrl;
  const parsed = validateHttpUrl(rawUrl);
  if (!parsed) {
    return { success: false, error: 'INVALID_URL', message: '不是可下载的 http/https 链接（已拒绝非网页协议）' };
  }
  const url = parsed.href;
  const kind = message.kind === 'drive' ? 'drive' : (message.fileId && isDriveHost(parsed.hostname) ? 'drive' : 'generic');
  const safeId = message.fileId || parsed.hostname.replace(/\W+/g, '_') || 'download';

  if (kind === 'drive' && message.fileId) {
    return handleDriveDownload(url, message.fileId);
  }
  return handleGenericDownload(url, safeId);
}

// ── Drive 路径：保留原有确认页跳过逻辑，只修一个误判 ───────────────────────
// 原版把 text/plain 也当确认页处理，Drive 上的 .txt/.csv 会被误判；
// 现在只有 text/html 才走确认页解析，text/plain 按文件写盘。
async function handleDriveDownload(url, fileId) {
  const mode = await getDownloadMode();
  if (mode === 'browser') {
    const probed = await probeFileInfo(url, 10000);
    const filename = probed ? `${getTodayDateStr()}/${probed.name}` : undefined;
    const r = await downloadViaBrowser(url, filename, probed ? probed.sizeBytes : null);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹' };
    return r;
  }

  const handle = await getSavedDirHandle();
  if (!handle) {
    if (mode === 'folder') {
      return { success: false, error: 'NO_FOLDER', message: '尚未设置保存文件夹，请先在设置中选择' };
    }
    const r = await downloadViaBrowser(url, undefined);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹', note: '尚未设置固定文件夹，已改用浏览器下载' };
    return r;
  }
  const perm = await checkPermission(handle);
  if (perm !== 'granted') {
    if (mode === 'folder') {
      return { success: false, error: 'NO_PERMISSION', message: '文件夹授权已失效，请重新授权' };
    }
    const r = await downloadViaBrowser(url, undefined);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹', note: '文件夹授权已失效，已改用浏览器下载' };
    return { success: false, error: 'NO_PERMISSION', message: '文件夹授权已失效，请重新授权' };
  }

  let resp;
  try {
    resp = await fetch(url, { credentials: 'include' });
  } catch (e) {
    const r = await downloadViaBrowser(url, undefined);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹', note: '直接请求失败，已改用浏览器下载' };
    return { success: false, error: 'FETCH_FAILED', message: e.message || '网络请求失败' };
  }
  if (!resp.ok) {
    return { success: false, error: 'HTTP_' + resp.status, message: `服务器返回 HTTP ${resp.status}` };
  }

  let contentType = (resp.headers.get('content-type') || '').toLowerCase();
  let bypassedInterstitial = false;

  if (isHtmlContentType(contentType)) {
    const html = await resp.text().catch(() => '');
    const confirmUrl = extractConfirmDownloadUrl(html);
    let bypassed = false;
    if (confirmUrl) {
      try {
        const resp2 = await fetch(confirmUrl, { credentials: 'include' });
        const ct2 = (resp2.headers.get('content-type') || '').toLowerCase();
        if (resp2.ok && !isHtmlContentType(ct2)) {
          resp = resp2;
          contentType = ct2;
          bypassed = true;
          bypassedInterstitial = true;
        } else {
          try { resp2.body && resp2.body.cancel(); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 走兜底 */ }
    }
    if (!bypassed) {
      const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
      openTab(viewUrl);
      const quotaHint = looksLikeQuotaExceeded(html)
        ? '（看起来是该文件今日下载次数已用完，需要等待或更换账号，无法自动跳过）'
        : '（确认页结构变化导致无法自动识别，已在新分页打开，请手动点击“仍然下载”）';
      return {
        success: false, skipped: true, error: 'INTERSTITIAL',
        message: `无法自动跳过确认页，已在新分页打开，请手动下载 ${quotaHint}`,
        viewUrl,
      };
    }
  }

  const cd = resp.headers.get('content-disposition');
  const filename = sanitizeName(inferFilename({
    disposition: cd, finalUrl: resp.url || url, contentType,
    fallbackBase: fileId,
  }) || `${fileId}.bin`);
  const written = await writeResponseToFolder(resp, handle, filename, fileId);
  if (written.success) written.bypassedInterstitial = bypassedInterstitial;
  return written;
}

// ── 通用路径：任意 http/https 文件链接 ──────────────────────────────────────
async function handleGenericDownload(url, safeId) {
  const mode = await getDownloadMode();

  // 浏览器下载模式：不碰固定文件夹，直接交给浏览器。
  if (mode === 'browser') {
    const probed = await probeFileInfo(url, 10000);
    const filename = probed ? `${getTodayDateStr()}/${probed.name}` : undefined;
    const r = await downloadViaBrowser(url, filename, probed ? probed.sizeBytes : null);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹' };
    return r;
  }

  // auto / folder：有可用文件夹就写入固定文件夹，否则 auto 兜底浏览器下载。
  const handle = await getSavedDirHandle();
  const perm = await checkPermission(handle);
  const folderUsable = Boolean(handle) && perm === 'granted';

  if (!folderUsable) {
    if (mode === 'folder') {
      return handle
        ? { success: false, error: 'NO_PERMISSION', message: '文件夹授权已失效，请重新授权' }
        : { success: false, error: 'NO_FOLDER', message: '尚未设置保存文件夹，请先在设置中选择' };
    }
    const probed = await probeFileInfo(url, 10000);
    const filename = probed ? `${getTodayDateStr()}/${probed.name}` : undefined;
    const r = await downloadViaBrowser(url, filename, probed ? probed.sizeBytes : null);
    if (r.success) {
      return { ...r, folder: '浏览器默认下载文件夹', note: '尚未设置/授权固定文件夹，已改用浏览器下载' };
    }
    return r;
  }

  let resp;
  try {
    resp = await fetch(url, { credentials: 'include' });
  } catch (e) {
    const r = await downloadViaBrowser(url, undefined);
    if (r.success) return { ...r, folder: '浏览器默认下载文件夹', note: '直接请求失败，已改用浏览器下载' };
    return { success: false, error: 'FETCH_FAILED', message: e.message || '网络请求失败' };
  }
  if (!resp.ok) {
    return { success: false, error: 'HTTP_' + resp.status, message: `服务器返回 HTTP ${resp.status}（需要登录或链接已失效时，可点 ↗ 在新分页打开查看）` };
  }

  const contentType = resp.headers.get('content-type') || '';
  // HTML = 网页/登录页/错误页，不是文件：不写盘，改开新分页让用户看。
  if (isHtmlContentType(contentType)) {
    try { resp.body && resp.body.cancel(); } catch (e) { /* ignore */ }
    openTab(url);
    return {
      success: false, skipped: true, error: 'NOT_A_FILE',
      message: '该链接返回的是网页（不是文件），已在新分页打开；如需保存网页内容请在新分页中手动处理',
      viewUrl: url,
    };
  }

  const cd = resp.headers.get('content-disposition');
  const filename = sanitizeName(inferFilename({
    disposition: cd, finalUrl: resp.url || url, contentType, fallbackBase: safeId,
  }));
  return writeResponseToFolder(resp, handle, filename, safeId);
}
