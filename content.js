/*
 * ChatGPT 右侧问题导航 v1.0.3
 * 仅处理当前网页 DOM 中已经渲染出来的用户消息。
 * 不请求历史 API，不自动滚动加载历史，不存储或传输任何对话内容。
 */
(() => {
  'use strict';

  const VERSION = '1.0.3';
  const previousInstance = window.__chatgptRightRailLoaded;
  // 同版本只重新扫描；升级时替换旧实例，避免继续调用旧选择器。
  if (previousInstance?.version === VERSION) {
    previousInstance.refresh();
    return;
  }
  previousInstance?.dispose?.();

  const USER_MESSAGE_SELECTOR = [
    '[data-message-author-role="user"]',
    '[data-author-role="user"]',
    '[data-turn="user"]',
    '[data-user-message-bubble="true"]',
    '[data-content-search-unit-key$=":user"]',
    '[data-chatgpt-search-unit-key$=":user"]'
  ].join(', ');
  const SEARCH_USER_TURN_SELECTOR = '[data-chatgpt-search-unit-key$=":user"]';
  const CONTENT_USER_TURN_SELECTOR = '[data-content-search-unit-key$=":user"]';
  const USER_MARKER_ATTRIBUTES = [
    'data-message-author-role', 'data-author-role', 'data-turn',
    'data-user-message-bubble', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key'
  ];
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"], [data-turn-id], [data-turn], article';
  const RAIL_ID = 'chatgpt-right-rail-extension';
  const MAX_TOOLTIP_CHARS = 200;

  let host = null;
  let root = null;
  let rail = null;
  let tooltip = null;
  let entries = [];
  let activeIndex = -1;
  let scanTimer = 0;
  let scrollFrame = 0;
  let lastUrl = location.href;
  let hoverIndex = -1;

  const css = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; color-scheme: light; }
    :host([data-dark="true"]) { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    .rail {
      position: fixed;
      top: 50%;
      right: 11px;
      transform: translateY(-50%);
      width: 38px;
      max-height: min(72vh, 740px);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      overflow: auto;
      overscroll-behavior: contain;
      scrollbar-width: none;
      pointer-events: auto;
      padding: 6px 2px;
      border-radius: 11px;
      background: transparent;
      transition: background 140ms ease;
    }
    .rail:hover, .rail:focus-within { background: rgba(128,128,128,.075); }
    .rail::-webkit-scrollbar { display: none; }
    .rail[hidden], .tooltip[hidden] { display: none !important; }
    .mark {
      display: flex;
      flex: 0 0 17px;
      width: 34px;
      height: 17px;
      align-items: center;
      justify-content: flex-end;
      padding: 0 3px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
      outline-offset: -2px;
    }
    .mark:focus-visible { outline: 2px solid #2386ea; }
    .dash {
      display: block;
      height: 3px;
      width: 24px;
      border-radius: 99px;
      background: #a1a1aa;
      opacity: .86;
      transition: none;
    }
    :host([data-dark="true"]) .dash { background: #888891; }
    /* 悬停和高亮只变颜色，保持横线的左右端点及粗细不变。 */
    .mark:hover .dash, .mark:focus-visible .dash { background: #626b7d; opacity: 1; }
    .mark[aria-current="location"] .dash,
    .mark[aria-current="location"]:hover .dash { background: #1681e6; opacity: 1; }
    .tooltip {
      position: fixed;
      transform: translateY(-50%);
      right: 55px;
      max-width: min(340px, calc(100vw - 78px));
      min-width: 125px;
      padding: 11px 13px;
      border-radius: 11px;
      background: rgba(255,255,255,.98);
      border: 1px solid rgba(0,0,0,.10);
      box-shadow: 0 8px 30px rgba(0,0,0,.14);
      color: #292929;
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      overflow-wrap: anywhere;
      pointer-events: none;
      white-space: normal;
    }
    :host([data-dark="true"]) .tooltip { background: #292929; border-color: #4e4e4e; color: #f3f3f3; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .tooltip-count { font-size: 11px; opacity: .59; margin-bottom: 4px; }
    .tooltip-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
    @media (max-width: 550px) { .rail { right: 3px; } .tooltip { right: 46px; } }
    @media (prefers-reduced-motion: reduce) { .rail { transition: none; } }
  `;

  function isDarkMode() {
    const html = document.documentElement;
    const body = document.body;
    const theme = (html.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    if (html.classList.contains('dark') || body?.classList.contains('dark')) return true;
    if (html.classList.contains('light') || body?.classList.contains('light')) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function ensureRail() {
    if (host?.isConnected) return false;
    // 复用旧版本的宿主节点，让旧上下文的观察器不会反复重建导航。
    host = document.getElementById(RAIL_ID) || document.createElement('div');
    // Shadow DOM 将所有样式隔离，避免影响 ChatGPT 原有界面。
    host.id = RAIL_ID;
    host.dataset.version = VERSION;
    host.setAttribute('aria-label', 'ChatGPT 右侧问题导航插件');
    root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    rail = document.createElement('nav');
    rail.className = 'rail';
    rail.setAttribute('aria-label', '已加载问题快速导航');
    rail.hidden = true;
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    root.replaceChildren(style, rail, tooltip);
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    updateTheme();
    return true;
  }

  function updateTheme() {
    if (host) host.dataset.dark = String(isDarkMode());
  }

  function targetFor(message) {
    // 新版页面把同一条提问标记在外层搜索单元、内容单元和气泡上。
    // 统一使用最外层用户单元，避免一条提问被重复列出。
    const searchTurn = message.closest(SEARCH_USER_TURN_SELECTOR);
    if (searchTurn) return searchTurn;
    const contentTurn = message.closest(CONTENT_USER_TURN_SELECTOR);
    if (contentTurn) return contentTurn;
    // 优先定位整条聊天 turn，避免只能跳到气泡的中间位置。
    return message.closest(TURN_SELECTOR) || message;
  }

  function previewFor(message) {
    // ChatGPT 的用户文本通常位于 whitespace-pre-wrap 节点中。
    const bubble = message.querySelector('[data-user-message-bubble="true"]') || message;
    const textNode = bubble.querySelector('.whitespace-pre-wrap') || bubble;
    const raw = (textNode.innerText || textNode.textContent || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '（图片、附件或空白消息）';
    return raw.length > MAX_TOOLTIP_CHARS ? raw.slice(0, MAX_TOOLTIP_CHARS) + '…' : raw;
  }

  function findEntries() {
    const nodes = document.querySelectorAll(USER_MESSAGE_SELECTOR);
    const seen = new Set();
    const found = [];
    for (const message of nodes) {
      if (!message.isConnected || message.closest(`#${RAIL_ID}`)) continue;
      const target = targetFor(message);
      if (seen.has(target)) continue;
      seen.add(target);
      found.push({ target, message, preview: previewFor(message) });
    }
    return found;
  }

  function renderRail() {
    const fragment = document.createDocumentFragment();
    const length = entries.length;
    for (let index = 0; index < length; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mark';
      button.dataset.index = String(index);
      button.setAttribute('aria-label', `第 ${index + 1} 个问题：${entries[index].preview}`);
      const dash = document.createElement('span');
      dash.className = 'dash';
      button.append(dash);
      button.addEventListener('click', () => goTo(index));
      button.addEventListener('mouseenter', () => showTooltip(index, button));
      button.addEventListener('mouseleave', hideTooltip);
      button.addEventListener('focus', () => showTooltip(index, button));
      button.addEventListener('blur', hideTooltip);
      fragment.appendChild(button);
    }
    rail.replaceChildren(fragment);
    rail.hidden = length === 0;
    hideTooltip();
    activeIndex = -1;
    updateCurrentPosition();
  }

  function showTooltip(index, button) {
    if (!entries[index]) return;
    hoverIndex = index;
    const rect = button.getBoundingClientRect();
    const center = Math.max(75, Math.min(innerHeight - 75, rect.top + rect.height / 2));
    tooltip.replaceChildren();
    const count = document.createElement('div');
    count.className = 'tooltip-count';
    count.textContent = `第 ${index + 1} / ${entries.length} 个已加载的问题`;
    const desc = document.createElement('div');
    desc.className = 'tooltip-text';
    desc.textContent = entries[index].preview;
    tooltip.append(count, desc);
    tooltip.style.top = `${center}px`;
    tooltip.hidden = false;
  }

  function hideTooltip() {
    hoverIndex = -1;
    if (tooltip) tooltip.hidden = true;
  }

  function goTo(index) {
    const entry = entries[index];
    if (!entry?.target?.isConnected) { scanNow(); return; }
    hideTooltip();
    try {
      entry.target.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'center',
        inline: 'nearest'
      });
    } catch {
      entry.target.scrollIntoView();
    }
    setActive(index);
  }

  function setActive(index) {
    if (activeIndex === index) return;
    const previous = rail?.children[activeIndex];
    if (previous) previous.removeAttribute('aria-current');
    activeIndex = index;
    const current = rail?.children[index];
    if (!current) return;
    current.setAttribute('aria-current', 'location');
    // 只滚动导航栏自身，不触发聊天正文滚动。
    const top = current.offsetTop;
    if (top < rail.scrollTop + 26 || top > rail.scrollTop + rail.clientHeight - 26) {
      rail.scrollTop = Math.max(0, top - rail.clientHeight / 2);
    }
  }

  function updateCurrentPosition() {
    if (!entries.length || !rail) return;
    const line = innerHeight * 0.37;
    let current = 0;
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i].target.getBoundingClientRect();
      if (r.top <= line) current = i;
      else break;
    }
    setActive(current);
  }

  function queuePositionUpdate() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateCurrentPosition();
    });
  }

  function scanNow() {
    window.clearTimeout(scanTimer);
    scanTimer = 0;
    const recreated = ensureRail();
    updateTheme();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      hideTooltip();
    }
    const next = findEntries();
    const changed = recreated || next.length !== entries.length || next.some((item, i) =>
      item.target !== entries[i]?.target || item.preview !== entries[i]?.preview
    );
    if (changed) {
      entries = next;
      renderRail();
    } else {
      queuePositionUpdate();
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(scanNow, 140);
  }

  function isRelevantNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.id === RAIL_ID) return false;
    return node.matches(USER_MESSAGE_SELECTOR) || node.matches(TURN_SELECTOR) ||
      !!node.querySelector(USER_MESSAGE_SELECTOR);
  }

  function onMutations(mutations) {
    let needsScan = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const name = mutation.attributeName;
        if ((name === 'class' || name === 'data-theme') &&
            (mutation.target === document.documentElement || mutation.target === document.body)) updateTheme();
        if (USER_MARKER_ATTRIBUTES.includes(name)) needsScan = true;
        continue;
      }
      if (mutation.type === 'characterData') {
        if (mutation.target.parentElement?.closest(USER_MESSAGE_SELECTOR)) needsScan = true;
        continue;
      }
      // 用户消息内部文本变动时同步更新摘要（不扫描 AI 流式输出）。
      if (mutation.target.nodeType === Node.ELEMENT_NODE &&
          mutation.target.closest?.(USER_MESSAGE_SELECTOR)) { needsScan = true; break; }
      // 检查新增/移除的用户 turn，不因 AI 每个输出 token 全量扫描。
      for (const node of mutation.addedNodes) {
        if (isRelevantNode(node)) { needsScan = true; break; }
      }
      if (needsScan) break;
      for (const node of mutation.removedNodes) {
        if (isRelevantNode(node)) { needsScan = true; break; }
      }
      if (needsScan) break;
      if (!host?.isConnected) needsScan = true;
    }
    if (needsScan) scheduleScan();
  }

  scanNow();
  const observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'data-theme', ...USER_MARKER_ATTRIBUTES]
  });
  window.addEventListener('scroll', queuePositionUpdate, true);
  window.addEventListener('resize', queuePositionUpdate, { passive: true });
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('hashchange', scheduleScan);
  window.addEventListener('pageshow', scheduleScan);
  // ChatGPT 使用客户端路由：URL 变化时轻量检查，不刷新、不加载历史记录。
  const routeTimer = window.setInterval(() => {
    if (location.href !== lastUrl || (host && !host.isConnected)) scheduleScan();
  }, 1200);
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  colorScheme.addEventListener('change', updateTheme);

  function dispose() {
    observer.disconnect();
    window.clearTimeout(scanTimer);
    window.clearInterval(routeTimer);
    window.cancelAnimationFrame(scrollFrame);
    window.removeEventListener('scroll', queuePositionUpdate, true);
    window.removeEventListener('resize', queuePositionUpdate);
    window.removeEventListener('popstate', scheduleScan);
    window.removeEventListener('hashchange', scheduleScan);
    window.removeEventListener('pageshow', scheduleScan);
    colorScheme.removeEventListener('change', updateTheme);
  }

  window.__chatgptRightRailLoaded = { version: VERSION, refresh: scanNow, dispose };
})();
