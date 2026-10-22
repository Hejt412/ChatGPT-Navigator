/* 扩展页面 / 后台使用的目录存储。磁盘访问仅通过用户选择的目录句柄。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__chatgptRailFolder = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const PREFIX = 'question-memory:v1:', LOCATION = 'navigation-memory-location';
  const SUBDIRECTORY = 'navigator-data', DB = 'chatgpt-navigator-directory', LOCK = 'chatgpt-navigator-memory-storage';
  const MAX_RECORD = 1024 * 1024;
  const MAX_TOTAL = 6 * 1024 * 1024, MAX_CONVERSATIONS = 50, TTL = 90 * 24 * 60 * 60 * 1000;
  const keyPattern = /^question-memory:v1:(https:\/\/(?:chatgpt\.com|chat\.openai\.com)):([a-zA-Z0-9_-]{1,128})$/;
  function filename(key) {
    const match = typeof key === 'string' && key.match(keyPattern);
    if (!match) throw new Error('无效的导航记忆标识');
    return `conversation-${match[1] === 'https://chatgpt.com' ? 'chatgpt' : 'openai'}-${match[2]}.json`;
  }
  const validRecord = (key, value) => {
    const match = key.match(keyPattern);
    return !!match && value?.version === 1 && value.origin === match[1] && value.conversationId === match[2] &&
      Array.isArray(value.entries) && new TextEncoder().encode(JSON.stringify(value)).length <= MAX_RECORD;
  };

  function handleStore(indexedDB) {
    async function access(write, handle) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('settings');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction('settings', write ? 'readwrite' : 'readonly');
          const store = transaction.objectStore('settings');
          const request = write ? store.put(handle, 'directory') : store.get('directory');
          let result;
          request.onsuccess = () => { result = request.result; };
          transaction.oncomplete = () => resolve(write ? handle : result);
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('保存文件夹授权失败'));
        });
      } finally { db.close(); }
    }
    return { get: () => access(false), set: handle => access(true, handle) };
  }

  function create(storage, options = {}) {
    const handles = options.handles || handleStore(options.indexedDB || root.indexedDB);
    const locks = options.locks || root.navigator?.locks;
    let pending = Promise.resolve();
    const run = action => locks?.request ? locks.request(LOCK, action) :
      (pending = pending.catch(() => {}).then(action));
    const location = async () => (await storage.get(LOCATION))[LOCATION] || { mode: 'browser' };
    async function directory(handle = null, create = false) {
      handle ||= await handles.get();
      if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        const error = new Error('文件夹写入授权已失效，请打开保存位置设置重新授权');
        error.name = 'DirectoryPermissionRequired'; throw error;
      }
      return handle.getDirectoryHandle(SUBDIRECTORY, { create });
    }
    async function readFile(dir, key) {
      try {
        const file = await (await dir.getFileHandle(filename(key))).getFile();
        if (file.size > MAX_RECORD) return undefined;
        const value = JSON.parse(await file.text());
        return validRecord(key, value) ? value : undefined;
      } catch (error) {
        if (error.name === 'NotFoundError' || error instanceof SyntaxError) return undefined;
        throw error;
      }
    }
    async function readAll(dir) {
      const result = {};
      for await (const entry of dir.values()) {
        const match = entry.kind === 'file' && entry.name.match(/^conversation-(chatgpt|openai)-([a-zA-Z0-9_-]{1,128})\.json$/);
        if (!match) continue;
        const key = `${PREFIX}${match[1] === 'chatgpt' ? 'https://chatgpt.com' : 'https://chat.openai.com'}:${match[2]}`;
        const value = await readFile(dir, key);
        if (value) result[key] = value;
      }
      return result;
    }
    async function writeFiles(dir, values) {
      for (const [key, value] of Object.entries(values)) {
        if (!validRecord(key, value)) throw new Error('导航记忆数据无效或超过单条容量');
        const file = await dir.getFileHandle(filename(key), { create: true });
        const writable = await file.createWritable();
        try { await writable.write(JSON.stringify(value)); await writable.close(); }
        catch (error) { try { await writable.abort(); } catch {} throw error; }
      }
    }
    async function browserRecords() {
      return Object.fromEntries(Object.entries(await storage.get(null)).filter(([key, value]) => key.startsWith(PREFIX) && validRecord(key, value)));
    }
    async function currentRecords() {
      return (await location()).mode === 'folder' ? readAll(await directory()) : browserRecords();
    }
    function retained(values, preferred = '') {
      const entries = Object.entries(values).sort(([a, x], [b, y]) => Number(b === preferred) - Number(a === preferred) || y.updatedAt - x.updatedAt);
      const keep = {}, remove = []; let bytes = 0, count = 0;
      for (const [key, value] of entries) {
        const length = new TextEncoder().encode(JSON.stringify(value)).length;
        if (!Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > TTL || count >= MAX_CONVERSATIONS || bytes + length > MAX_TOTAL) remove.push(key);
        else { keep[key] = value; bytes += length; count++; }
      }
      return { keep, remove };
    }
    async function removeFiles(dir, keys) {
      for (const key of keys) try { await dir.removeEntry(filename(key)); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    return {
      get(key) {
        return run(async () => {
          if (key !== null) filename(key);
          if ((await location()).mode !== 'folder') return key === null ? browserRecords() : storage.get(key);
          let dir;
          try { dir = await directory(); }
          catch (error) { if (error.name === 'NotFoundError') return {}; throw error; }
          return key === null ? readAll(dir) : { [key]: await readFile(dir, key) };
        });
      },
      set(values) {
        return run(async () => {
          for (const [key, value] of Object.entries(values)) {
            filename(key); if (!validRecord(key, value)) throw new Error('导航记忆数据无效');
          }
          if ((await location()).mode === 'folder') await writeFiles(await directory(null, true), values);
          else await storage.set(values);
        });
      },
      saveRecord(key, record) {
        return run(async () => {
          filename(key); if (!validRecord(key, record)) throw new Error('导航记忆数据无效');
          const folderMode = (await location()).mode === 'folder';
          const dir = folderMode ? await directory(null, true) : null;
          const current = dir ? await readAll(dir) : await browserRecords();
          if (current[key]?.updatedAt > record.updatedAt) return current[key];
          const { remove } = retained({ ...current, [key]: record }, key);
          if (dir) { await removeFiles(dir, remove); await writeFiles(dir, { [key]: record }); }
          else { if (remove.length) await storage.remove(remove); await storage.set({ [key]: record }); }
          return record;
        });
      },
      remove(keys) {
        return run(async () => {
          keys = Array.isArray(keys) ? keys : [keys]; keys.forEach(filename);
          if ((await location()).mode !== 'folder') { await storage.remove(keys); return; }
          const dir = await directory();
          await removeFiles(dir, keys);
        });
      },
      status() {
        return run(async () => {
          const value = await location();
          if (value.mode !== 'folder') return { mode: 'browser', granted: true };
          const handle = await handles.get();
          return { mode: 'folder', name: handle?.name || value.name || '所选文件夹', subdirectory: SUBDIRECTORY,
            granted: !!handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted' };
        });
      },
      getHandle: () => handles.get(),
      configure(handle) {
        return run(async () => {
          if (!handle || handle.kind !== 'directory') throw new Error('请选择文件夹');
          const oldLocation = await location();
          const fromBrowser = await browserRecords();
          let fromFolder = {};
          if (oldLocation.mode === 'folder') try { fromFolder = await readAll(await directory()); }
          catch (error) { if (!['DirectoryPermissionRequired', 'NotFoundError'].includes(error.name)) throw error; }
          const dir = await directory(handle, true), existing = await readAll(dir);
          const values = { ...existing };
          for (const source of [fromBrowser, fromFolder]) for (const [key, value] of Object.entries(source)) {
            if (!values[key] || value.updatedAt > values[key].updatedAt) values[key] = value;
          }
          const { keep, remove } = retained(values);
          await writeFiles(dir, keep);
          // 数据已写入并核验，才切换位置并删除浏览器中的旧目录正文。
          for (const [key, value] of Object.entries(keep)) {
            if (JSON.stringify(await readFile(dir, key)) !== JSON.stringify(value)) throw new Error('文件写入校验失败，原记忆已保留');
          }
          await removeFiles(dir, remove);
          await handles.set(handle);
          await storage.set({ [LOCATION]: { mode: 'folder', name: handle.name || '所选文件夹' } });
          if (Object.keys(fromBrowser).length) await storage.remove(Object.keys(fromBrowser));
          return { migrated: Object.keys(keep).length, name: handle.name || '所选文件夹' };
        });
      },
      useBrowser() {
        return run(async () => {
          const values = await currentRecords();
          if (Object.keys(values).length) await storage.set(values);
          await storage.set({ [LOCATION]: { mode: 'browser' } });
          return { migrated: Object.keys(values).length };
        });
      }
    };
  }
  return Object.freeze({ create, filename, LOCATION, SUBDIRECTORY });
});
