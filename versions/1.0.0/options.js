const chooseBtn = document.getElementById('chooseBtn');
const reauthBtn = document.getElementById('reauthBtn');
const statusLine = document.getElementById('statusLine');
const folderNameEl = document.getElementById('folderName');
const modeStatus = document.getElementById('modeStatus');

async function refreshStatus() {
  const handle = await getSavedDirHandle();

  if (!handle) {
    folderNameEl.textContent = '尚未设置';
    statusLine.textContent = '请选择一个文件夹作为固定下载位置（自动/只用浏览器下载模式下不设置也能下载）';
    statusLine.className = 'status-line muted';
    reauthBtn.style.display = 'none';
    return;
  }

  folderNameEl.textContent = handle.name;

  let perm;
  try {
    perm = await handle.queryPermission({ mode: 'readwrite' });
  } catch (e) {
    perm = 'error';
  }

  if (perm === 'granted') {
    statusLine.textContent = '✓ 已授权，下载会自动存到这里';
    statusLine.className = 'status-line ok';
    reauthBtn.style.display = 'none';
  } else {
    statusLine.textContent = '⚠ 授权已失效或文件夹不可用，请重新授权';
    statusLine.className = 'status-line warn';
    reauthBtn.style.display = 'inline-flex';
  }
}

chooseBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveDirHandle(handle);
    await refreshStatus();
  } catch (e) {
    if (e.name !== 'AbortError') {
      alert('选择文件夹失败：' + e.message);
    }
  }
});

reauthBtn.addEventListener('click', async () => {
  const handle = await getSavedDirHandle();
  if (!handle) return;
  try {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    await refreshStatus();
    if (perm !== 'granted') {
      alert('未获得授权，下载功能暂时无法使用。也可以直接点击上方按钮重新选择文件夹。');
    }
  } catch (e) {
    alert('授权失败：' + e.message + '\n可以尝试直接重新选择文件夹。');
  }
});

// ── 下载方式：存 chrome.storage.local，background 读取 ──
async function loadDownloadMode() {
  let mode = 'auto';
  try {
    const r = await chrome.storage.local.get({ downloadMode: 'auto' });
    if (r && (r.downloadMode === 'auto' || r.downloadMode === 'folder' || r.downloadMode === 'browser')) {
      mode = r.downloadMode;
    }
  } catch (e) { /* 无 storage 时默认 auto */ }
  document.querySelectorAll('input[name="downloadMode"]').forEach((el) => {
    el.checked = el.value === mode;
  });
}

document.querySelectorAll('input[name="downloadMode"]').forEach((el) => {
  el.addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ downloadMode: el.value });
      if (modeStatus) {
        modeStatus.textContent = '✓ 已保存：' + el.parentElement.textContent.trim();
        modeStatus.className = 'status-line ok';
      }
    } catch (e) {
      if (modeStatus) {
        modeStatus.textContent = '保存失败：' + (e.message || '未知错误');
        modeStatus.className = 'status-line warn';
      }
    }
  });
});

loadDownloadMode();
refreshStatus();
