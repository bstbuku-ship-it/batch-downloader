// idb.js — 极简 IndexedDB 封装，用于跨 popup / options / background(service worker)
// 持久化保存用户选择的下载文件夹句柄（FileSystemDirectoryHandle）。
// 三个上下文共享同一个扩展 origin，因此都能读写同一份 IndexedDB 数据。

const IDB_DB_NAME = 'gdrive_dl_db';
const IDB_STORE = 'config';
const DIR_HANDLE_KEY = 'dirHandle';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 取出已保存的目录句柄（可能为 null）
async function getSavedDirHandle() {
  try {
    return (await idbGet(DIR_HANDLE_KEY)) || null;
  } catch (e) {
    return null;
  }
}

// 保存目录句柄
async function saveDirHandle(handle) {
  return idbSet(DIR_HANDLE_KEY, handle);
}

// 清除已保存的目录句柄（用于"路径异常"时重置）
async function clearDirHandle() {
  return idbDelete(DIR_HANDLE_KEY);
}
