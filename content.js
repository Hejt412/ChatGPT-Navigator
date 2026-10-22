/*
 * ChatGPT 问题导航 v2.2.1
 * 优先使用网页已加载的对话数据，只索引当前分支；页面扫描作为兼容方案。
 * 消息索引只在内存中，本地书签只保存消息标识；历史分页由网页自身执行。
 */
(() => {
  'use strict';

  const VERSION = '2.2.1';
  const Model = window.__chatgptRailModel;
  const DATA_CHANNEL = 'chatgpt-navigator-v2';
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
    'data-user-message-bubble', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key',
    'data-message-id', 'data-turn-id', 'data-testid', 'hidden', 'aria-hidden', 'inert'
  ];
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"], [data-turn-id], [data-turn], article';
  const RAIL_ID = 'chatgpt-right-rail-extension';
  const MAX_TOOLTIP_CHARS = 200;
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], [data-author-role="assistant"], [data-turn="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';

  let host = null;
  let root = null;
  let rail = null;
  let tooltip = null;
  let historyControl = null;
  let entries = [];
  let activeIndex = -1;
  let scanTimer = 0;
  let scrollFrame = 0;
  let lastUrl = location.href;
  let hoverIndex = -1;
  let historyTimer = 0;
  let historyTask = null;
  let historyEnabled = false;
  let historyComplete = false;
  let cachedContainer = null;
  let disposed = false;
  let nextEntryKey = 0;
  let conversationRoot = null;
  let staleTargets = new Map();
  let pressedKey = null;
  let dataSnapshot = null;
  let dataBranchAnchor = '';
  let dataRouteId = Model?.conversationId(location.href) || null;
  let dataNonce = crypto.randomUUID();
  let sourceTimers = [];
  let bookmarks = new Set();
  let bookmarkScope = '';
  let tooltipTimer = 0;
  let tooltipHideTimer = 0;
  let dragState = null;
  let suppressClick = false;
  let positionObserver = null;
  let navigationNotice = '';
  let motionIndex = -1;
  let lastSourceRequest = 0;
  let nativeHistoryState = 'idle';
  let manualHistoryIndex = false;
  let diagnosticPanel = null;
  let diagnosticText = null;
  let diagnosticTimer = 0;
  let bridgeDiagnostics = null;

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
      max-height: min(70vh, 640px);
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
      animation: rail-appear 150ms ease-out;
    }
    .rail::-webkit-scrollbar { display: none; }
    .rail[hidden], .tooltip[hidden] { display: none !important; }
    .mark {
      display: flex;
      flex: 0 0 10px;
      width: 34px;
      height: 10px;
      position: relative;
      touch-action: pan-y;
      align-items: center;
      justify-content: flex-end;
      padding: 0 3px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
      outline-offset: -2px;
      color: #999ba1;
    }
    .mark:focus-visible { outline: 2px solid #2386ea; }
    .dash {
      display: block;
      height: 2px;
      width: 26px;
      background: currentColor;
      opacity: .55;
      transform: scaleX(var(--dash-scale, .230769));
      transform-origin: right center;
      transition: transform 160ms linear(0, .398 10%, .682 20%, .843 30%, .925 40%, .972 50%, 1.004 60%, 1.008 70%, 1.003 80%, 1), opacity 120ms ease;
    }
    .mark[aria-current="location"], .mark[data-motion="true"], .mark:focus-visible { color: #202123; }
    .mark[aria-current="location"] .dash { opacity: .7; }
    .mark[data-motion="true"] .dash, .mark:focus-visible .dash { opacity: 1; }
    :host([data-dark="true"]) .mark { color: #b4b4b8; }
    :host([data-dark="true"]) .mark[aria-current="location"], :host([data-dark="true"]) .mark[data-motion="true"] { color: #f3f3f3; }
    .rail[data-scrubbing="true"] .dash { transition-duration: 0ms; }
    .bookmark-dot { position: absolute; right: calc(5px + 26px * var(--dash-scale, .230769)); top: calc(50% - 1px); width: 2px; height: 2px; border-radius: 50%; background: currentColor; transition: right 160ms ease-out; }
    .tooltip {
      position: fixed;
      transform: translateY(-50%);
      right: 55px;
      width: min(320px, calc(100vw - 78px));
      min-width: 125px;
      padding: 8px;
      border-radius: 12px;
      background: rgba(255,255,255,.98);
      border: 1px solid rgba(0,0,0,.10);
      box-shadow: 0 8px 30px rgba(0,0,0,.14);
      color: #292929;
      font: 13px/20px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      overflow-wrap: anywhere;
      pointer-events: auto;
      white-space: normal;
      transition: top 120ms cubic-bezier(.2,.8,.2,1);
    }
    .tooltip[data-entering="true"] { animation: preview-appear 150ms ease-out; }
    :host([data-dark="true"]) .tooltip { background: #292929; border-color: #4e4e4e; color: #f3f3f3; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .tooltip-count { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .tooltip-heading { display: flex; align-items: flex-start; gap: 8px; }
    .tooltip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; cursor: pointer; }
    .tooltip-response { margin-top: 4px; color: #888; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
    :host([data-dark="true"]) .tooltip-response { color: #b1b1b1; }
    .bookmark-button { flex: 0 0 24px; width: 24px; height: 24px; padding: 3px; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; }
    .bookmark-button:hover { background: rgba(128,128,128,.14); }
    .bookmark-button[aria-pressed="true"] { color: #c48919; }
    .bookmark-button svg { display: block; width: 18px; height: 18px; }
    .tooltip-attachments { margin-top: 6px; display: flex; gap: 6px; color: #777; font-size: 11px; }
    .attachment { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-control {
      position: fixed; right: 11px; width: 38px; height: 24px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: 0; border-radius: 6px;
      background: transparent; color: #777; pointer-events: auto; cursor: pointer;
      font: 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    }
    .history-control:hover, .history-control:focus-visible { background: rgba(128,128,128,.10); }
    .history-control[hidden] { display: none !important; }
    .diagnostics { position: fixed; right: 55px; bottom: 30px; width: min(355px, calc(100vw - 75px)); max-height: min(75vh, 620px); overflow: auto; padding: 12px; border-radius: 12px; border: 1px solid #ddd; background: #fff; color: #292929; box-shadow: 0 8px 30px #0002; pointer-events: auto; font: 12px/1.5 'Segoe UI','Microsoft YaHei',sans-serif; }
    .diagnostics[hidden] { display: none !important; }
    .diagnostics pre { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; margin: 8px 0; }
    .diagnostics p { margin: 4px 0; color: #777; }
    .diagnostics button { border: 1px solid #ccc; border-radius: 6px; padding: 5px 9px; margin-right: 8px; cursor: pointer; background: transparent; color: inherit; }
    :host([data-dark="true"]) .diagnostics { background: #292929; color: #eee; border-color: #555; }
    :host([data-dark="true"]) .history-control { color: #aaa; }
    @media (max-width: 550px) { .rail, .history-control { right: 3px; } .tooltip { right: 46px; } }
    @keyframes rail-appear { from { opacity: 0; } to { opacity: 1; } }
    @keyframes preview-appear { from { opacity: 0; translate: 5px 0; } to { opacity: 1; translate: 0 0; } }
    @media (prefers-reduced-motion: reduce) { .rail, .dash, .tooltip, .bookmark-dot { animation: none !important; transition: none !important; } }
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
    rail.setAttribute('aria-label', '已索引问题快速导航');
    rail.hidden = true;
    rail.addEventListener('pointerdown', event => {
      pressedKey = event.button === 0 ? event.target.closest('.mark')?.dataset.key : null;
      if (pressedKey && event.pointerType !== 'touch') {
        dragState = { pointerId: event.pointerId, key: pressedKey, changed: false };
        rail.setPointerCapture?.(event.pointerId);
      }
    });
    rail.addEventListener('pointermove', onRailPointerMove);
    rail.addEventListener('pointerleave', () => { if (!dragState) paintRailMotion(-1); });
    rail.addEventListener('pointerup', event => {
      if (dragState?.pointerId !== event.pointerId) return;
      // 原按钮在按下后可能被目录更新替换，浏览器此时不会再派发 click。
      // 使用按下/拖动时记录的消息身份完成定位，同时吃掉可能出现的合成 click。
      const key = dragState.key;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
      dragState = null;
      pressedKey = null;
      rail.dataset.scrubbing = 'false';
      if (rail.hasPointerCapture?.(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      goTo(key);
    });
    rail.addEventListener('pointercancel', () => { dragState = null; pressedKey = null; rail.dataset.scrubbing = 'false'; paintRailMotion(-1); });
    rail.addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; pressedKey = null; return; }
      const key = (event.detail > 0 && pressedKey) || event.target.closest('.mark')?.dataset.key;
      pressedKey = null;
      if (key) goTo(key);
    });
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-label', '问题与回答预览');
    tooltip.hidden = true;
    tooltip.id = 'question-navigation-preview';
    tooltip.addEventListener('mouseenter', () => window.clearTimeout(tooltipHideTimer));
    tooltip.addEventListener('mouseleave', scheduleTooltipHide);
    tooltip.addEventListener('focusout', event => { if (!tooltip.contains(event.relatedTarget)) scheduleTooltipHide(); });
    historyControl = document.createElement('button');
    historyControl.type = 'button';
    historyControl.className = 'history-control';
    historyControl.hidden = true;
    historyControl.addEventListener('contextmenu', event => { event.preventDefault(); openDiagnostics(); });
    historyControl.addEventListener('click', event => {
      if (nativeHistoryState === 'loading') cancelNativeHistory();
      else if (historyTask) cancelHistory(true);
      else if (dataSnapshot?.complete) { requestSnapshot(); scanNow(); }
      else if (!Model || event.shiftKey) startHistoryIndex();
      else requestSnapshot(true);
    });
    root.replaceChildren(style, rail, tooltip, historyControl);
    diagnosticPanel = null;
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
    return message.closest('[data-testid^="conversation-turn-"], [data-turn-id], [data-turn="user"]') || message;
  }

  function textFor(message) {
    // ChatGPT 的用户文本通常位于 whitespace-pre-wrap 节点中。
    const bubble = message.querySelector('[data-user-message-bubble="true"]') || message;
    const textNode = bubble.querySelector('.whitespace-pre-wrap') || bubble;
    return (textNode.innerText || textNode.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function signatureFor(message) {
    const text = textFor(message);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${hash >>> 0}`;
  }

  function identityFor(target, message) {
    const messageNode = message.closest('[data-message-id]') || target.querySelector('[data-message-id]');
    const turnNode = message.closest('[data-turn-id]');
    const messageId = messageNode?.getAttribute('data-message-id') || turnNode?.getAttribute('data-turn-id') || '';
    let unitKey = '';
    for (const name of ['data-chatgpt-search-unit-key', 'data-content-search-unit-key', 'data-testid']) {
      const node = message.closest(`[${name}]`);
      if (node) { unitKey = `${name}:${node.getAttribute(name)}`; break; }
    }
    return { messageId, messageIdKind: messageNode ? 'message' : turnNode ? 'turn' : 'none', unitKey,
      identifiers: [messageId, ...unitKey.split(':').slice(1)].filter(Boolean) };
  }

  function findEntries() {
    const scope = currentConversationRoot();
    if (!scope) return [];
    const nodes = scope.querySelectorAll(USER_MESSAGE_SELECTOR);
    const seen = new Set();
    const found = [];
    for (const message of nodes) {
      if (!message.isConnected || message.closest(`#${RAIL_ID}, aside, nav, [role="dialog"], [hidden], [aria-hidden="true"], [inert]`) ||
          message.closest(ASSISTANT_SELECTOR) || message.querySelector(USER_MESSAGE_SELECTOR)) continue;
      const target = targetFor(message);
      if (seen.has(target)) continue;
      seen.add(target);
      const anchor = scrollAnchorFor({ target, message });
      if (!anchor || getComputedStyle(anchor).visibility === 'hidden') continue;
      const signature = signatureFor(message);
      const stale = staleTargets.get(target);
      if (stale && stale.signature === signature && stale.message === message) continue;
      const container = anchor && scrollContainerFor(anchor);
      const viewport = scrollViewport(container);
      const text = textFor(message);
      found.push({
        key: null, ...identityFor(target, message), signature, target, message,
        preview: text ? text.slice(0, MAX_TOOLTIP_CHARS) + (text.length > MAX_TOOLTIP_CHARS ? '…' : '') : '（图片、附件或空白消息）',
        position: anchor ? (container?.scrollTop || 0) + anchor.getBoundingClientRect().top - viewport.top : 0
      });
    }
    readDomResponses(found, scope);
    return found;
  }

  function readDomResponses(found, scope) {
    for (const entry of found) { entry.response = ''; entry.attachments = []; }
    for (const node of scope.querySelectorAll(ASSISTANT_SELECTOR)) {
      if (node.querySelector(ASSISTANT_SELECTOR) || node.closest('[hidden], [aria-hidden="true"], [inert], [role="dialog"]')) continue;
      let entry = null;
      for (const candidate of found) {
        if (candidate.message.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) entry = candidate;
        else break;
      }
      if (!entry || entry.response.length >= 1600) continue;
      const textNode = node.querySelector('.markdown, .prose, [data-message-content]') || node;
      if (!textNode.getBoundingClientRect().height || getComputedStyle(textNode).visibility === 'hidden') continue;
      const text = (textNode.innerText || textNode.textContent || '').trim();
      if (text) entry.response = (entry.response + (entry.response ? '\n' : '') + text).slice(0, 1600);
    }
  }

  function matchScore(previous, next) {
    if (previous.messageId && next.messageId) {
      if (previous.messageId === next.messageId) return 10000;
      const weakTurn = (previous.source === 'data' && next.messageIdKind === 'turn') ||
        (next.source === 'data' && previous.messageIdKind === 'turn');
      if (!weakTurn) return 0;
    }
    if (previous.signature !== next.signature) return 0;
    return 10 + (previous.unitKey && previous.unitKey === next.unitKey ? 5 : 0) +
      (previous.message === next.message ? 20 : 0) + (Math.abs(previous.position - next.position) < 3 ? 1 : 0);
  }

  function alignEntryKeys(previous, found) {
    // 按消息身份和前后顺序一一匹配。不能把临时 fallback-turn 序号当作永久消息 ID，
    // 也不能只按文本去重，否则两个不同位置的“继续”会合并。
    if (previous.length === found.length && previous.every((entry, index) => matchScore(entry, found[index]) > 0)) {
      for (let i = 0; i < found.length; i++) {
        found[i].key = previous[i].key;
        if (!found[i].messageId) found[i].messageId = previous[i].messageId;
      }
    } else {
      const rows = Array.from({ length: previous.length + 1 }, () => new Float64Array(found.length + 1));
      for (let i = previous.length - 1; i >= 0; i--) {
        for (let j = found.length - 1; j >= 0; j--) {
          const score = matchScore(previous[i], found[j]);
          rows[i][j] = Math.max(rows[i + 1][j], rows[i][j + 1], score ? score + rows[i + 1][j + 1] : 0);
        }
      }
      let i = 0;
      let j = 0;
      while (i < previous.length && j < found.length) {
        const score = matchScore(previous[i], found[j]);
        if (score && rows[i][j] === score + rows[i + 1][j + 1]) {
          found[j].key = previous[i].key;
          if (!found[j].messageId) found[j].messageId = previous[i].messageId;
          i++; j++;
        } else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
        else j++;
      }
    }
  }

  function mergeEntries(found) {
    alignEntryKeys(entries, found);
    for (const item of found) if (!item.key) item.key = `entry:${++nextEntryKey}`;
    if (!historyEnabled) return found;
    const merged = entries.map(entry => {
      const bound = scrollAnchorFor(entry);
      return { ...entry, target: bound ? entry.target : null, message: bound ? entry.message : null };
    });
    const byKey = new Map(merged.map(entry => [entry.key, entry]));
    for (let i = 0; i < found.length; i++) {
      const item = found[i];
      if (byKey.has(item.key)) { Object.assign(byKey.get(item.key), item); continue; }
      const next = found.slice(i + 1).find(entry => byKey.has(entry.key));
      const previous = found[i - 1];
      let at = next ? merged.findIndex(entry => entry.key === next.key) : -1;
      if (at < 0 && previous && byKey.has(previous.key)) at = merged.findIndex(entry => entry.key === previous.key) + 1;
      if (at < 0) at = merged.findIndex(entry => entry.position > item.position);
      merged.splice(at < 0 ? merged.length : at, 0, item);
      byKey.set(item.key, item);
    }
    return merged;
  }

  function bindDataEntries(found) {
    const knownIds = new Set(dataSnapshot.nodes.flatMap(node => [node.id, node.messageId]));
    const signatureNodes = new Map();
    for (const node of dataSnapshot.nodes) {
      if (node.role !== 'user') continue;
      if (!signatureNodes.has(node.signature)) signatureNodes.set(node.signature, node.messageId);
      else signatureNodes.set(node.signature, null);
    }
    const visibleIds = found.flatMap(entry => {
      const ids = (entry.identifiers || [entry.messageId]).filter(id => knownIds.has(id));
      if (!ids.length && entry.messageIdKind !== 'message') {
        const unique = signatureNodes.get(entry.signature);
        if (unique) ids.push(unique);
      }
      return ids;
    });
    const models = Model.entriesFromSnapshot(dataSnapshot, visibleIds);
    const previous = new Map(entries.map(entry => [entry.key, entry]));
    const byAlias = new Map(models.flatMap(entry => entry.aliases.map(id => [id, entry.messageId])));
    const oldComplete = historyComplete;
    historyComplete = dataSnapshot.complete;
    historyEnabled = false;
    const live = found.filter(item => !knownIds.has(item.messageId) || byAlias.has(item.messageId));
    for (const item of live) {
      const canonical = item.identifiers?.map(id => byAlias.get(id)).find(Boolean);
      if (canonical) item.messageId = canonical;
    }
    const raw = models.map(item => ({ ...item, unitKey: '', target: null, message: null,
      position: previous.get(item.key)?.position ?? 0, positionKnown: previous.get(item.key)?.positionKnown === true,
      source: 'data' }));
    alignEntryKeys(raw, live);
    // 单个没有消息 ID 的“继续”可能对应多个轮次，不能仅凭相同文本猜测目标。
    for (let at = 0; at < live.length; at++) {
      const item = live[at];
      if (!item.key || item.messageIdKind === 'message' || signatureNodes.get(item.signature) !== null ||
          item.identifiers?.some(id => byAlias.has(id))) continue;
      const certain = live.map((other, index) => ({ other, index, model: raw.find(entry => entry.key === other.key) }))
        .filter(value => value.model && (signatureNodes.get(value.other.signature) || value.other.identifiers?.some(id => byAlias.has(id))));
      const before = certain.filter(value => value.index < at).at(-1)?.model.ordinal ?? -1;
      const after = certain.find(value => value.index > at)?.model.ordinal ?? raw.length;
      let candidates = raw.filter(entry => entry.signature === item.signature && entry.ordinal > before && entry.ordinal < after);
      if (candidates.length !== 1) candidates = candidates.filter(entry => entry.positionKnown && Math.abs(entry.position - item.position) < innerHeight * 0.2);
      item.key = candidates.length === 1 ? candidates[0].key : null;
    }
    const byKey = new Map(live.filter(item => item.key).map(item => [item.key, item]));
    const result = raw.map(item => {
      const dom = byKey.get(item.key);
      return dom ? { ...item, target: dom.target, message: dom.message, signature: dom.signature,
        unitKey: dom.unitKey, position: dom.position, positionKnown: true, response: item.response || dom.response } : item;
    });
    // 新发送的消息可能先显示在 DOM 中，随后才出现在下一份对话数据中。
    const last = raw.at(-1);
    const branchAnchor = `${last?.key || ''}:${Model.signature(last?.response || '')}`;
    const previousLive = dataBranchAnchor === branchAnchor ? entries.filter(entry => entry.source === 'live') : [];
    dataBranchAnchor = branchAnchor;
    const pending = live.filter(item => !item.key && !knownIds.has(item.messageId));
    alignEntryKeys(previousLive, pending);
    const overlay = previousLive.map(item => ({ ...item,
      message: scrollAnchorFor(item) ? item.message : null, target: scrollAnchorFor(item) ? item.target : null }));
    const byLiveKey = new Map(overlay.map(item => [item.key, item]));
    const lastKey = previousLive.at(-1)?.key || last?.key;
    const boundary = live.findIndex(item => item.key === lastKey);
    for (const item of pending) {
      if (item.key && byLiveKey.has(item.key)) Object.assign(byLiveKey.get(item.key), item, { positionKnown: true });
      else if (boundary >= 0 && live.indexOf(item) > boundary) {
        item.key ||= item.messageId ? `message:${item.messageId}` : `live:${item.signature}:${++nextEntryKey}`;
        overlay.push({ ...item, source: 'live', positionKnown: true });
      }
    }
    for (const item of overlay) result.push({ ...item, ordinal: result.length });
    if (oldComplete !== historyComplete) updateHistoryControl();
    return result;
  }

  function requestSnapshot(force = false) {
    if (!Model || !dataRouteId || disposed) return;
    window.postMessage({ channel: DATA_CHANNEL, type: 'request', conversationId: dataRouteId, nonce: dataNonce, force: force === true }, location.origin);
  }

  function localDiagnostics() {
    return { navigatorVersion: VERSION, hasConversationRoute: !!dataRouteId, modelInstalled: !!Model,
      indexedQuestions: entries.length, renderedQuestions: findEntries().length,
      source: dataSnapshot ? 'conversation-data' : 'rendered-page', complete: historyComplete,
      graphNodes: dataSnapshot?.nodes.length || 0, historyState: nativeHistoryState,
      bridge: bridgeDiagnostics || { connected: false, hint: '未收到主页面诊断响应，请重新加载扩展后刷新 ChatGPT' } };
  }

  function updateDiagnostics() {
    if (diagnosticText?.isConnected) diagnosticText.textContent = JSON.stringify(localDiagnostics(), null, 2);
  }

  function openDiagnostics() {
    hideTooltip();
    if (!diagnosticPanel?.isConnected) {
      diagnosticPanel = document.createElement('section'); diagnosticPanel.className = 'diagnostics';
      diagnosticPanel.setAttribute('role', 'dialog'); diagnosticPanel.setAttribute('aria-label', '导航诊断');
      const title = document.createElement('strong'); title.textContent = '导航诊断';
      const note = document.createElement('p'); note.textContent = '只包含版本、数量和加载状态，不包含聊天原文、网址或登录信息。';
      diagnosticText = document.createElement('pre');
      const copy = document.createElement('button'); copy.textContent = '复制诊断'; copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(diagnosticText.textContent); copy.textContent = '已复制'; }
        catch { copy.textContent = '请选中文字复制'; }
      });
      const close = document.createElement('button'); close.textContent = '关闭'; close.type = 'button';
      close.addEventListener('click', () => { diagnosticPanel.hidden = true; });
      diagnosticPanel.append(title, note, diagnosticText, copy, close); root.append(diagnosticPanel);
    }
    diagnosticPanel.hidden = false;
    bridgeDiagnostics = null;
    updateDiagnostics();
    if (Model && dataRouteId) window.postMessage({ channel: DATA_CHANNEL, type: 'diagnose', conversationId: dataRouteId, nonce: dataNonce }, location.origin);
    window.clearTimeout(diagnosticTimer);
    diagnosticTimer = window.setTimeout(updateDiagnostics, 1000);
  }

  function cancelNativeHistory() {
    if (!Model || !dataRouteId || disposed) return;
    nativeHistoryState = 'cancelled';
    window.postMessage({ channel: DATA_CHANNEL, type: 'cancel', conversationId: dataRouteId, nonce: dataNonce }, location.origin);
    updateHistoryControl();
  }

  function resetDataRoute() {
    dataSnapshot = null;
    dataBranchAnchor = '';
    nativeHistoryState = 'idle';
    manualHistoryIndex = false;
    bridgeDiagnostics = null;
    if (diagnosticPanel) diagnosticPanel.hidden = true;
    dataRouteId = Model?.conversationId(location.href) || null;
    dataNonce = crypto.randomUUID();
    for (const timer of sourceTimers) window.clearTimeout(timer);
    lastSourceRequest = 0;
    sourceTimers = [0, 250, 1000, 3500, 8000, 16000].map(delay => window.setTimeout(requestSnapshot, delay));
    loadBookmarks();
  }

  function onSnapshot(event) {
    if (!Model || event.source !== window || event.origin !== location.origin || disposed) return;
    const message = event.data;
    if (!message || message.channel !== DATA_CHANNEL || !['snapshot', 'status', 'diagnostics'].includes(message.type) || message.nonce !== dataNonce ||
        Model.conversationId(location.href) !== dataRouteId) return;
    if (message.type === 'diagnostics') {
      if (message.conversationId !== dataRouteId || !message.diagnostics || typeof message.diagnostics !== 'object') return;
      // 只保留预先定义的计数 / 布尔值；页面消息不能把任意内容混入复制结果。
      const fields = ['bridgeVersion', 'cachedSource', 'cachedNodes', 'cachedComplete', 'currentResponses', 'parsedSnapshots', 'lastHttpStatus'];
      bridgeDiagnostics = { connected: true };
      for (const key of fields) {
        const value = message.diagnostics[key];
        if (typeof value === 'number' || typeof value === 'boolean' || value === null ||
            (key === 'bridgeVersion' && typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) ||
            (key === 'cachedSource' && ['none', 'response', 'bootstrap'].includes(value))) bridgeDiagnostics[key] = value;
      }
      for (const group of ['state', 'history']) {
        bridgeDiagnostics[group] = {};
        for (const [key, value] of Object.entries(message.diagnostics[group] || {})) {
          if (/^[A-Za-z]{1,40}$/.test(key) && (typeof value === 'number' || typeof value === 'boolean')) bridgeDiagnostics[group][key] = value;
        }
      }
      updateDiagnostics();
      return;
    }
    if (message.type === 'status') {
      if (message.conversationId !== dataRouteId || !['loading', 'complete', 'cancelled', 'error', 'unavailable'].includes(message.state)) return;
      nativeHistoryState = message.state;
      if (message.state === 'loading' && !dataSnapshot) historyEnabled = true;
      if (host) host.dataset.history = message.state;
      updateHistoryControl();
      return;
    }
    const snapshot = Model.normalizeSnapshot(message.snapshot, dataRouteId);
    if (!snapshot) return;
    if (manualHistoryIndex && !snapshot.complete) return;
    cancelHistory(true);
    dataSnapshot = snapshot;
    if (snapshot.complete) { nativeHistoryState = 'complete'; manualHistoryIndex = false; }
    scanNow();
  }

  function bookmarkId(entry) {
    if (entry.messageId) return `message:${entry.messageId}`;
    const occurrence = entries.slice(0, entries.indexOf(entry)).filter(item => item.signature === entry.signature).length;
    return `text:${entry.signature}:${occurrence}`;
  }

  async function loadBookmarks() {
    const scope = `question-bookmarks:${dataRouteId || location.pathname}`;
    bookmarkScope = scope;
    bookmarks = new Set();
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) { paintBookmarks(); return; }
    try {
      const result = await storage.get(scope);
      if (disposed || bookmarkScope !== scope) return;
      const ids = result[scope];
      bookmarks = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string').slice(0, 10000) : []);
      paintBookmarks();
    } catch { /* 无存储权限时仍允许使用本页内存书签。 */ }
  }

  function paintBookmarks() {
    if (!rail) return;
    for (const button of rail.children) {
      const entry = entries.find(item => item.key === button.dataset.key);
      if (!entry) continue;
      const selected = bookmarks.has(bookmarkId(entry));
      button.dataset.bookmarked = String(selected);
      const dot = button.querySelector('.bookmark-dot');
      if (selected && !dot) {
        const marker = document.createElement('span'); marker.className = 'bookmark-dot'; marker.setAttribute('aria-hidden', 'true'); button.append(marker);
      } else if (!selected) dot?.remove();
      button.setAttribute('aria-label', `第 ${button.dataset.index * 1 + 1} 个问题${selected ? '，已收藏' : ''}：${entry.preview}`);
    }
  }

  async function toggleBookmark(key, button) {
    const entry = entries.find(item => item.key === key);
    if (!entry) return;
    const id = bookmarkId(entry);
    if (bookmarks.has(id)) bookmarks.delete(id); else bookmarks.add(id);
    const selected = bookmarks.has(id);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', selected ? '取消收藏此问题' : '收藏此问题');
    button.querySelector('svg')?.setAttribute('fill', selected ? 'currentColor' : 'none');
    paintBookmarks();
    try { await globalThis.chrome?.storage?.local?.set({ [bookmarkScope]: [...bookmarks] }); } catch { /* 当前页面书签仍保留。 */ }
  }

  function renderRail() {
    const fragment = document.createDocumentFragment();
    const length = entries.length;
    for (let index = 0; index < length; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mark';
      const key = entries[index].key;
      button.dataset.index = String(index);
      button.dataset.key = key;
      button.setAttribute('aria-label', `第 ${index + 1} 个问题：${entries[index].preview}`);
      const dash = document.createElement('span');
      dash.className = 'dash';
      button.append(dash);
      button.addEventListener('mouseenter', () => showTooltip(entries.findIndex(entry => entry.key === key), button));
      button.addEventListener('mouseleave', scheduleTooltipHide);
      button.addEventListener('focus', () => showTooltip(entries.findIndex(entry => entry.key === key), button));
      button.addEventListener('blur', event => { if (!tooltip.contains(event.relatedTarget)) scheduleTooltipHide(); });
      fragment.appendChild(button);
    }
    rail.replaceChildren(fragment);
    motionIndex = -1;
    rail.hidden = length === 0;
    paintBookmarks();
    hideTooltip();
    activeIndex = -1;
    fitRail();
    observePositions();
    updateCurrentPosition();
  }

  function fitRail() {
    if (!rail) return;
    updateHistoryControl();
  }

  function showTooltip(index, button) {
    if (!entries[index]) return;
    window.clearTimeout(tooltipTimer);
    window.clearTimeout(tooltipHideTimer);
    hoverIndex = index;
    paintRailMotion(index);
    const key = entries[index].key;
    if (!tooltip.hidden) { renderTooltip(index, button); return; }
    tooltipTimer = window.setTimeout(() => {
      const currentIndex = entries.findIndex(entry => entry.key === key);
      if (currentIndex < 0 || !button.isConnected) return;
      renderTooltip(currentIndex, button);
    }, 150);
  }

  function renderTooltip(index, button) {
    const entry = entries[index];
    if (!entry || !tooltip) return;
    if (entry.source !== 'data' && entry.message?.isConnected) {
      const current = findEntries().find(item => item.message === entry.message);
      if (current?.response) entry.response = current.response;
    }
    const rect = button.getBoundingClientRect();
    const center = Math.max(75, Math.min(innerHeight - 75, rect.top + rect.height / 2));
    tooltip.dataset.entering = String(tooltip.hidden);
    tooltip.replaceChildren();
    const count = document.createElement('div');
    count.className = 'tooltip-count';
    count.textContent = `第 ${index + 1} / ${entries.length} 个${historyComplete ? '' : '已索引的'}问题`;
    const desc = document.createElement('div');
    desc.className = 'tooltip-text';
    desc.textContent = entry.prompt || entry.preview;
    desc.addEventListener('click', () => goTo(entry.key));
    const heading = document.createElement('div');
    heading.className = 'tooltip-heading';
    const bookmark = document.createElement('button');
    bookmark.type = 'button';
    bookmark.className = 'bookmark-button';
    const selected = bookmarks.has(bookmarkId(entry));
    bookmark.setAttribute('aria-pressed', String(selected));
    bookmark.setAttribute('aria-label', selected ? '取消收藏此问题' : '收藏此问题');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', selected ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z');
    svg.append(path); bookmark.append(svg);
    bookmark.addEventListener('click', event => { event.stopPropagation(); toggleBookmark(entry.key, bookmark); });
    heading.append(desc, bookmark);
    const response = document.createElement('div');
    response.className = 'tooltip-response';
    response.textContent = entry.response || '暂无回答预览';
    tooltip.append(count, heading, response);
    if (entry.attachments?.length) {
      const attachments = document.createElement('div'); attachments.className = 'tooltip-attachments';
      for (const file of entry.attachments.slice(0, 2)) {
        const label = document.createElement('span'); label.className = 'attachment'; label.textContent = `📎 ${file.name}`; label.title = file.name; attachments.append(label);
      }
      if (entry.attachments.length > 2) attachments.append(document.createTextNode(`+${entry.attachments.length - 2}`));
      tooltip.append(attachments);
    }
    tooltip.style.top = `${center}px`;
    tooltip.hidden = false;
    const height = tooltip.getBoundingClientRect().height;
    tooltip.style.top = `${Math.max(height / 2 + 12, Math.min(innerHeight - height / 2 - 12, center))}px`;
    button.setAttribute('aria-describedby', tooltip.id);
    paintRailMotion(index);
  }

  function paintRailMotion(index) {
    if (!rail || motionIndex === index) return;
    const affected = new Set();
    for (const center of [motionIndex, index]) if (center >= 0) {
      for (let offset = -3; offset <= 3; offset++) affected.add(center + offset);
    }
    motionIndex = index;
    const progress = [1, .7, .4, .2];
    for (const at of affected) {
      const button = rail.children[at];
      if (!button) continue;
      const distance = index >= 0 ? Math.abs(at - index) : Infinity;
      button.style.setProperty('--dash-scale', String((6 + 20 * (progress[distance] || 0)) / 26));
      button.dataset.motion = String(distance === 0);
    }
  }

  function scheduleTooltipHide() {
    window.clearTimeout(tooltipHideTimer);
    tooltipHideTimer = window.setTimeout(hideTooltip, 180);
  }

  function hideTooltip() {
    window.clearTimeout(tooltipTimer);
    window.clearTimeout(tooltipHideTimer);
    hoverIndex = -1;
    if (tooltip) tooltip.hidden = true;
    paintRailMotion(-1);
  }

  function onRailPointerMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    rail.dataset.scrubbing = 'true';
    const rect = rail.getBoundingClientRect();
    const node = root.elementFromPoint?.(rect.left + rect.width / 2, Math.max(rect.top + 1, Math.min(rect.bottom - 1, event.clientY)));
    const key = node?.closest('.mark')?.dataset.key;
    if (!key || key === dragState.key) return;
    dragState.key = key; dragState.changed = true;
    const index = entries.findIndex(entry => entry.key === key);
    if (index < 0) return;
    const button = rail.children[index];
    renderTooltip(index, button);
    // 拖动时仅定位已经渲染的消息；松开后再定位尚未加载的目标。
    if (scrollAnchorFor(entries[index])) goTo(key, { keepPreview: true });
  }

  function observePositions() {
    positionObserver?.disconnect();
    const first = entries.map(scrollAnchorFor).find(Boolean);
    if (!first || typeof IntersectionObserver === 'undefined') return;
    const container = scrollContainerFor(first);
    positionObserver = new IntersectionObserver(queuePositionUpdate, {
      root: container === document.scrollingElement ? null : container, rootMargin: '-16px 0px 0px 0px'
    });
    for (const entry of entries) {
      const anchor = scrollAnchorFor(entry);
      if (anchor) positionObserver.observe(anchor);
    }
  }

  function scrollAnchorFor(entry) {
    // 搜索单元可能是 display: contents：它可用于去重，但没有可滚动的布局盒。
    if (!entry.message?.isConnected || !entry.target?.isConnected) return null;
    if (entry.message.closest('aside, nav, [role="dialog"], [hidden], [aria-hidden="true"], [inert]') ||
        entry.message.closest(ASSISTANT_SELECTOR) || getComputedStyle(entry.message).visibility === 'hidden') return null;
    if (entry.signature) {
      if (signatureFor(entry.message) !== entry.signature) return null;
      const identity = identityFor(entry.target, entry.message);
      if (entry.messageId && identity.messageId && entry.messageId !== identity.messageId &&
          (identity.messageIdKind === 'message' || entry.source !== 'data')) return null;
    }
    const bubble = entry.message.querySelector('[data-user-message-bubble="true"]');
    const candidates = [bubble, entry.message, entry.target];
    for (const node of candidates) {
      if (!node?.isConnected) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return node;
    }
    return null;
  }

  function scrollContainerFor(anchor) {
    for (let node = anchor.parentElement; node; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (node.scrollHeight > node.clientHeight + 1 &&
          /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement;
  }

  function scrollViewport(container) {
    return !container || container === document.scrollingElement
      ? { top: 0, height: innerHeight }
      : { top: container.getBoundingClientRect().top + container.clientTop, height: container.clientHeight };
  }

  function goTo(key, { keepPreview = false } = {}) {
    cancelHistory(false);
    navigationNotice = '';
    if (!keepPreview) hideTooltip();
    scanNow();
    if (entries.some(entry => entry.key === key)) seekEntry(key);
  }

  function jumpToAnchor(anchor, index) {
    const container = scrollContainerFor(anchor);
    // 平滑滚动期间虚拟列表会回收节点；立即定位后再核验、校正实际消息的位置。
    const behavior = 'instant';
    if (container) {
      const viewport = scrollViewport(container);
      // 将提问放在聊天可视区域上部，同时避免滚动外层页面或侧边栏。
      const top = container.scrollTop + anchor.getBoundingClientRect().top - viewport.top -
        Math.min(80, viewport.height * 0.15);
      container.scrollTo({ top: Math.max(0, top), behavior });
    } else {
      anchor.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
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
    if (historyTask?.kind === 'seek') return;
    let firstAnchor = null;
    for (const entry of entries) {
      firstAnchor = scrollAnchorFor(entry);
      if (firstAnchor) break;
    }
    if (!firstAnchor) return;
    const container = scrollContainerFor(firstAnchor);
    const viewport = scrollViewport(container);
    if (container && container.scrollHeight > viewport.height + 2 &&
        container.scrollTop >= container.scrollHeight - viewport.height - 2) {
      setActive(entries.length - 1);
      return;
    }
    const line = viewport.top + viewport.height * 0.37;
    let current = activeIndex < 0 ? 0 : activeIndex;
    for (let i = 0; i < entries.length; i++) {
      const anchor = scrollAnchorFor(entries[i]);
      if (!anchor) continue;
      const r = anchor.getBoundingClientRect();
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
    if (disposed) return;
    window.clearTimeout(scanTimer);
    scanTimer = 0;
    const recreated = ensureRail();
    updateTheme();
    const routeChanged = location.href !== lastUrl;
    const nextRoot = currentConversationRoot();
    const rootChanged = conversationRoot && nextRoot && conversationRoot !== nextRoot;
    const containerChanged = cachedContainer && !cachedContainer.isConnected;
    if (routeChanged || rootChanged || containerChanged) {
      cancelHistory(false);
      // SPA 会先更新 URL，再异步替换旧聊天 DOM。旧节点未移除前不能计入新对话。
      staleTargets = new Map(entries.filter(entry => entry.message?.isConnected).map(entry =>
        [entry.target, { message: entry.message, signature: entry.signature }]));
      lastUrl = location.href;
      entries = [];
      historyEnabled = false;
      historyComplete = false;
      cachedContainer = null;
      if (routeChanged) resetDataRoute();
      hideTooltip();
    }
    conversationRoot = nextRoot;
    for (const [target] of staleTargets) if (!target?.isConnected) staleTargets.delete(target);
    const found = findEntries();
    const next = dataSnapshot ? bindDataEntries(found) : mergeEntries(found);
    if (historyTask?.kind === 'index') for (const item of found) historyTask.seen.add(item.key);
    const changed = recreated || routeChanged || rootChanged || containerChanged || next.length !== entries.length || next.some((item, i) =>
      item.key !== entries[i]?.key || item.preview !== entries[i]?.preview
    );
    const anchorsChanged = next.some((item, i) => item.message !== entries[i]?.message);
    entries = next;
    host.dataset.source = dataSnapshot ? 'conversation' : 'page';
    host.dataset.history = nativeHistoryState;
    if (changed) {
      renderRail();
    } else {
      if (anchorsChanged) observePositions();
      if (hoverIndex >= 0 && !tooltip.hidden) {
        const response = tooltip.querySelector('.tooltip-response');
        if (response) response.textContent = entries[hoverIndex]?.response || '暂无回答预览';
      }
      queuePositionUpdate();
    }
    updateHistoryControl();
    // 页面状态可能晚于内容脚本挂载。重试只读数据发现，不滚动聊天收集目录。
    if (!dataSnapshot && Model && Date.now() - lastSourceRequest > 2000) {
      lastSourceRequest = Date.now();
      requestSnapshot();
    }
  }

  function currentConversationRoot() {
    const roots = [...document.querySelectorAll('main, [role="main"]')];
    return roots.find(node => !node.closest('[hidden], [aria-hidden="true"], [inert]') && node.getBoundingClientRect().height > 0) || roots[0] || null;
  }

  function historyContainer() {
    for (const entry of entries) {
      const anchor = scrollAnchorFor(entry);
      if (!anchor) continue;
      const container = scrollContainerFor(anchor);
      const viewport = scrollViewport(container);
      if (container && container.scrollHeight > viewport.height * 1.5) {
        cachedContainer = container;
        return container;
      }
    }
    if (cachedContainer?.isConnected) return cachedContainer;
    if (dataSnapshot) {
      const scope = currentConversationRoot();
      const answer = scope?.querySelector(ASSISTANT_SELECTOR);
      if (answer) return cachedContainer = scrollContainerFor(answer);
      const candidates = scope ? [scope, ...scope.querySelectorAll('div, section')].slice(0, 2000) : [];
      const candidate = candidates.filter(node => node.clientHeight > innerHeight * 0.25 &&
        node.scrollHeight > node.clientHeight + 2 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (candidate) return cachedContainer = candidate;
      if (document.scrollingElement.scrollHeight > innerHeight + 2) return document.scrollingElement;
    }
    return null;
  }

  function updateHistoryControl() {
    if (!historyControl) return;
    historyControl.hidden = !entries.length || (!dataSnapshot && !historyEnabled && !historyTask && !historyContainer());
    const nativeLoading = nativeHistoryState === 'loading' && !historyComplete;
    const label = nativeLoading ? `正在读取历史（${entries.length}）· 点击暂停`
      : historyTask
      ? (historyTask.kind === 'index' ? `正在补全 ${entries.length} 个 · 暂停` : '正在定位问题 · 取消')
      : (historyComplete ? `${entries.length} 个问题 · ${dataSnapshot ? '刷新目录' : '重新补全'}` : Model ? `重试读取历史（${entries.length}）· Shift+点击滚动补全` : `页面完整数据暂不可用 · 点击滚动补全历史（${entries.length}）`);
    historyControl.dataset.state = nativeLoading ? 'native' : historyTask ? historyTask.kind : historyComplete ? 'complete' : 'idle';
    historyControl.textContent = nativeLoading ? 'Ⅱ' : historyTask ? historyTask.kind === 'index' ? 'Ⅱ' : '…' : historyComplete ? String(entries.length) : '↻';
    historyControl.setAttribute('aria-label', label);
    historyControl.title = `${navigationNotice ? navigationNotice + '。' : ''}${label}。右键查看诊断。Alt+↑/↓ 切换问题，拖动横线快速定位；悬停预览并收藏。`;
    historyControl.style.top = `${Math.min(innerHeight - 38, (rail?.getBoundingClientRect().bottom || innerHeight / 2) + 8)}px`;
  }

  function cancelHistory(restore) {
    window.clearTimeout(historyTimer);
    historyTimer = 0;
    if (historyTask) {
      historyTask.cancelled = true;
      historyTask.restore = restore;
      historyTask = null;
    }
    updateHistoryControl();
  }

  function taskActive(task) {
    return !disposed && !task.cancelled && historyTask === task && task.url === location.href && task.container.isConnected &&
      (!task.deadline || Date.now() < task.deadline);
  }

  async function settleHistory(task, delay = 100) {
    await new Promise(resolve => window.setTimeout(resolve, delay));
    if (!taskActive(task)) return false;
    scanNow();
    return taskActive(task);
  }

  function rememberPosition(container) {
    const viewport = scrollViewport(container);
    let anchor = null;
    let key = null;
    for (const entry of entries) {
      const node = scrollAnchorFor(entry);
      if (node && node.getBoundingClientRect().bottom >= viewport.top) { anchor = node; key = entry.key; break; }
    }
    return { anchor, key, signature: anchor && signatureFor(anchor), offset: anchor?.getBoundingClientRect().top - viewport.top,
      top: container.scrollTop, height: container.scrollHeight,
      bottom: container.scrollHeight - container.scrollTop - viewport.height < 4 };
  }

  function restorePosition(task) {
    if (disposed || task.url !== location.href || !task.container.isConnected) return;
    const { container, saved } = task;
    const top = saved.anchor?.isConnected && signatureFor(saved.anchor) === saved.signature
      ? container.scrollTop + saved.anchor.getBoundingClientRect().top - scrollViewport(container).top - saved.offset
      : saved.bottom ? container.scrollHeight : (entries.find(entry => entry.key === saved.key)?.position - saved.offset) ||
        saved.top + Math.max(0, container.scrollHeight - saved.height);
    container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  }

  async function startHistoryIndex() {
    if (dataSnapshot?.complete) { requestSnapshot(); return; }
    manualHistoryIndex = true;
    if (dataSnapshot) dataSnapshot = null;
    scanNow();
    const container = historyContainer();
    if (!container || historyTask || disposed) return;
    window.clearTimeout(historyTimer);
    historyTimer = 0;
    historyEnabled = true;
    historyComplete = false;
    const task = { kind: 'index', container, url: location.href, seen: new Set(entries.filter(entry => scrollAnchorFor(entry)).map(entry => entry.key)),
      saved: rememberPosition(container), restore: true, cancelled: false };
    historyTask = task;
    if (Model) cancelNativeHistory();
    updateHistoryControl();
    try {
      // 顶部可能按页补载历史；等高度和问题索引稳定后再向下遍历虚拟列表。
      let stable = 0;
      let signature = '';
      const started = Date.now();
      for (let step = 0; step < 300 && taskActive(task); step++) {
        container.scrollTo({ top: 0, behavior: 'instant' });
        if (!await settleHistory(task, 300)) return;
        const next = `${container.scrollHeight}:${entries.length}`;
        const busy = container.querySelector('[aria-busy="true"], [role="progressbar"]');
        stable = container.scrollTop < 2 && !busy && next === signature ? stable + 1 : 0;
        signature = next;
        if (stable >= 4) break;
        if (Date.now() - started > 90000) return;
      }
      for (let step = 0; step < 3000 && taskActive(task); step++) {
        const viewport = scrollViewport(container);
        const max = Math.max(0, container.scrollHeight - viewport.height);
        if (container.scrollTop >= max - 2) {
          if (!await settleHistory(task, 300)) return;
          if (container.scrollTop >= container.scrollHeight - scrollViewport(container).height - 2) {
            historyComplete = true;
            entries = entries.filter(entry => task.seen.has(entry.key));
            renderRail();
            break;
          }
        }
        container.scrollTo({ top: Math.min(max, container.scrollTop + viewport.height * 0.8), behavior: 'instant' });
        if (!await settleHistory(task)) return;
        if (Date.now() - started > 90000) return;
      }
    } finally {
      // 用户点击导航或手动滚动时，取消的旧任务不能再覆盖新的位置。
      if (task.restore && (!historyTask || historyTask === task)) restorePosition(task);
      if (historyTask === task) historyTask = null;
      updateHistoryControl();
      queuePositionUpdate();
    }
  }

  async function seekEntry(key) {
    const entry = entries.find(item => item.key === key);
    if (!entry) return;
    const initialAnchor = scrollAnchorFor(entry);
    const container = initialAnchor ? scrollContainerFor(initialAnchor) : historyContainer();
    if (!container) return;
    const task = { kind: 'seek', container, url: location.href, cancelled: false, restore: false, deadline: Date.now() + 30000 };
    historyTask = task;
    updateHistoryControl();
    try {
      if (initialAnchor && await alignEntry(task, key)) return;
      if (!taskActive(task)) return;
      if (dataSnapshot && await seekDataEntry(task, key)) return;
      if (!taskActive(task)) return;
      const height = scrollViewport(container).height;
      // 优先使用已记录的位置，使卸载的问题重新进入页面 DOM。
      for (const offset of [0, -1, 1, -2, 2]) {
        if (!taskActive(task)) return;
        container.scrollTo({ top: Math.max(0, entry.position + offset * height - 60), behavior: 'instant' });
        if (!await settleHistory(task, 150)) return;
        if (await alignEntry(task, key)) return;
      }
      // 动态高度发生较大变化时，顺序寻找目标；始终只操作当前聊天。
      if (!taskActive(task)) return;
      container.scrollTo({ top: 0, behavior: 'instant' });
      for (let step = 0; step < 3000 && taskActive(task); step++) {
        if (!await settleHistory(task)) return;
        if (await alignEntry(task, key)) return;
        if (!taskActive(task)) return;
        const viewport = scrollViewport(container);
        if (container.scrollTop >= container.scrollHeight - viewport.height - 2) {
          if (!dataSnapshot) {
            entries = entries.filter(item => item.key !== key);
            historyComplete = false;
            renderRail();
          }
          navigationNotice = '该问题暂时未显示在页面中，可刷新聊天后重试';
          return;
        }
        container.scrollTo({ top: container.scrollTop + viewport.height * 0.8, behavior: 'instant' });
      }
    } finally {
      if (!task.cancelled && Date.now() >= task.deadline) navigationNotice = '定位超时，可刷新聊天或补全历史后重试';
      if (historyTask === task) historyTask = null;
      updateHistoryControl();
    }
  }

  async function seekDataEntry(task, key) {
    const wanted = entries.find(entry => entry.key === key);
    if (!wanted) return false;
    const viewport = scrollViewport(task.container);
    let low = 0, high = Math.max(0, task.container.scrollHeight - viewport.height);
    let position = wanted.positionKnown ? wanted.position : wanted.ordinal / Math.max(1, entries.length - 1) * high;
    for (let attempt = 0; attempt < 18 && taskActive(task); attempt++) {
      task.container.scrollTo({ top: Math.max(low, Math.min(high, position)), behavior: 'instant' });
      if (!await settleHistory(task, 150)) return false;
      if (await alignEntry(task, key)) return true;
      if (!taskActive(task)) return false;
      const live = entries.filter(entry => scrollAnchorFor(entry));
      if (live.length) {
        const first = live[0].ordinal, last = live.at(-1).ordinal;
        if (wanted.ordinal < first) high = Math.min(high, task.container.scrollTop);
        else if (wanted.ordinal > last) low = Math.max(low, task.container.scrollTop);
        else break;
      } else if (position >= high - 2) high = position;
      else { low = Math.max(low, position - viewport.height); high = Math.min(high, position + viewport.height); }
      const next = (low + high) / 2;
      if (high - low < viewport.height * 0.5 || Math.abs(next - position) < 2) break;
      position = next;
    }
    return false;
  }

  function onKeyboardNavigation(event) {
    if (event.key === 'Escape') { hideTooltip(); cancelHistory(false); if (nativeHistoryState === 'loading') cancelNativeHistory(); return; }
    if (event.defaultPrevented || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !['ArrowUp', 'ArrowDown'].includes(event.key) || !entries.length) return;
    event.preventDefault();
    const start = activeIndex >= 0 ? activeIndex : 0;
    const index = Math.max(0, Math.min(entries.length - 1, start + (event.key === 'ArrowUp' ? -1 : 1)));
    goTo(entries[index].key);
  }

  async function alignEntry(task, key) {
    for (let attempt = 0; attempt < 6 && taskActive(task); attempt++) {
      const index = entries.findIndex(entry => entry.key === key);
      const anchor = index >= 0 && scrollAnchorFor(entries[index]);
      if (!anchor) return false;
      jumpToAnchor(anchor, index);
      if (!await settleHistory(task, 120)) return false;
      const currentIndex = entries.findIndex(entry => entry.key === key);
      const current = currentIndex >= 0 && scrollAnchorFor(entries[currentIndex]);
      if (!current) continue;
      const viewport = scrollViewport(task.container);
      const rect = current.getBoundingClientRect();
      const max = Math.max(0, task.container.scrollHeight - viewport.height);
      const desired = Math.min(max, Math.max(0, task.container.scrollTop + rect.top - viewport.top - Math.min(80, viewport.height * 0.15)));
      if (rect.bottom > viewport.top && rect.top < viewport.top + viewport.height && Math.abs(desired - task.container.scrollTop) < 3) {
        setActive(currentIndex);
        return true;
      }
    }
    return false;
  }

  function onUserInput(event) {
    if (event.composedPath().includes(host)) return;
    pressedKey = null;
    const manualScroll = event.type === 'wheel' || event.type === 'touchstart' ||
      (event.type === 'keydown' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key));
    cancelHistory(!manualScroll);
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
        if (!tooltip?.hidden && mutation.target.parentElement?.closest(ASSISTANT_SELECTOR)) needsScan = true;
        continue;
      }
      if (!tooltip?.hidden && mutation.target.nodeType === Node.ELEMENT_NODE && mutation.target.closest?.(ASSISTANT_SELECTOR)) needsScan = true;
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

  window.addEventListener('message', onSnapshot);
  window.addEventListener('keydown', onKeyboardNavigation);
  resetDataRoute();
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
  window.addEventListener('resize', onResize, { passive: true });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, onUserInput, { capture: true, passive: true });
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('hashchange', scheduleScan);
  window.addEventListener('pageshow', scheduleScan);
  // ChatGPT 使用客户端路由：URL 变化时清空上一段对话的内存索引。
  const routeTimer = window.setInterval(() => {
    if (location.href !== lastUrl || (host && !host.isConnected)) scheduleScan();
  }, 1200);
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  colorScheme.addEventListener('change', updateTheme);

  function onResize() {
    fitRail();
    queuePositionUpdate();
  }

  function dispose() {
    disposed = true;
    cancelHistory(false);
    hideTooltip();
    for (const timer of sourceTimers) window.clearTimeout(timer);
    positionObserver?.disconnect();
    observer.disconnect();
    window.clearTimeout(scanTimer);
    window.clearTimeout(diagnosticTimer);
    window.clearInterval(routeTimer);
    window.cancelAnimationFrame(scrollFrame);
    window.removeEventListener('scroll', queuePositionUpdate, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('message', onSnapshot);
    window.removeEventListener('keydown', onKeyboardNavigation);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, onUserInput, true);
    window.removeEventListener('popstate', scheduleScan);
    window.removeEventListener('hashchange', scheduleScan);
    window.removeEventListener('pageshow', scheduleScan);
    colorScheme.removeEventListener('change', updateTheme);
  }

  window.__chatgptRightRailLoaded = { version: VERSION, refresh: scanNow, dispose };
})();
