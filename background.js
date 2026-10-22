/* 为已打开的页面补上导航；更新后刷新一次页面，可在网页初始化时接入历史加载器。 */
'use strict';

const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

async function injectRail(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['conversation-model.js', 'history-loader.js', 'page-state.js', 'page-bridge.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['conversation-model.js', 'content.js']
  });
}

async function injectOpenChats() {
  try {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
    await Promise.all(tabs.filter(tab => tab.id != null && !tab.discarded).map(async tab => {
      try {
        await injectRail(tab.id);
      } catch (error) {
        // 页面可能刚被关闭、跳转或尚未授予站点访问权限；其他页面仍继续加载。
        console.warn('ChatGPT 右侧导航未能注入页面：', error.message);
      }
    }));
  } catch (error) {
    console.warn('ChatGPT 右侧导航未能检查已打开页面：', error.message);
  }
}

chrome.runtime.onInstalled.addListener(injectOpenChats);

// 用户也可以从扩展菜单点击图标，补载脚本或重新扫描当前对话。
chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) return;
  try {
    await injectRail(tab.id);
  } catch (error) {
    console.warn('ChatGPT 右侧导航重新加载失败：', error.message);
  }
});
