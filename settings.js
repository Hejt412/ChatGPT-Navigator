(() => {
  'use strict';
  const api = globalThis.__chatgptRailFolder.create(chrome.storage.local);
  const location = document.getElementById('location'), permission = document.getElementById('permission');
  const status = document.getElementById('status'), choose = document.getElementById('choose');
  const authorize = document.getElementById('authorize'), browser = document.getElementById('browser');
  let selectedHandle = null;
  const report = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const busy = value => { for (const button of [choose, authorize, browser]) button.disabled = value; };
  async function refresh() {
    const value = await api.status();
    selectedHandle = await api.getHandle();
    location.textContent = value.mode === 'folder' ? `${value.name} / ${value.subdirectory}` : '浏览器本地存储';
    permission.textContent = value.mode !== 'folder' ? '保存在当前浏览器的用户数据目录。'
      : value.granted ? '文件夹已授权，问题目录会自动保存到这里。' : '文件夹授权已失效，请重新授权后继续保存。';
    authorize.hidden = value.mode !== 'folder' || value.granted;
  }
  choose.addEventListener('click', async () => {
    if (!window.showDirectoryPicker) { report('当前浏览器不支持选择保存文件夹，请使用桌面版 Edge 或 Chrome。', true); return; }
    busy(true); report('');
    try {
      const handle = await window.showDirectoryPicker({ id: 'navigator-memory', mode: 'readwrite' });
      const result = await api.configure(handle);
      await refresh(); report(`已切换到所选文件夹，已迁移 ${result.migrated} 个对话。刷新已打开的聊天页面即可使用。`);
    } catch (error) { if (error.name !== 'AbortError') report(error.message || '文件夹选择失败，原记忆已保留。', true); }
    finally { busy(false); }
  });
  authorize.addEventListener('click', async () => {
    busy(true);
    try {
      if (!selectedHandle || await selectedHandle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('尚未获得写入授权，请允许访问或重新选择文件夹。');
      await refresh(); report('文件夹已重新授权，刷新聊天页面即可恢复记忆。');
    } catch (error) { report(error.message, true); }
    finally { busy(false); }
  });
  browser.addEventListener('click', async () => {
    busy(true);
    try { const result = await api.useBrowser(); await refresh(); report(`已切回浏览器存储，已恢复 ${result.migrated} 个对话。原文件夹中的记忆文件保留。`); }
    catch (error) { report(error.message, true); }
    finally { busy(false); }
  });
  refresh().catch(error => report(error.message, true));
})();
