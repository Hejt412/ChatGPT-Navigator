/* MAIN world：观察当前聊天 JSON，协调网页自身的历史加载器；不读取认证信息。 */
(() => {
  'use strict';
  const VERSION = '2.5.1';
  const model = window.__chatgptRailModel;
  if (!model) return;
  if (window.__chatgptRailBridge?.version === VERSION) return;
  window.__chatgptRailBridge?.dispose();
  const CHANNEL = 'chatgpt-navigator-v2';
  let nonce = null, requestedId = null, cached = null, cacheSource = '', disposed = false;
  let knownUserIds = new Set();
  let requestSequence = 0, acceptedSequence = 0;
  const originalFetch = window.fetch;
  const ResponseType = window.Response;
  const originalJson = ResponseType?.prototype.json;
  const XhrType = window.XMLHttpRequest;
  const originalOpen = XhrType?.prototype.open;
  const xhrRequests = new WeakMap();
  const responseRequests = new WeakMap();
  let lastPageProbe = 0;
  const counters = { currentResponses: 0, parsedSnapshots: 0, lastHttpStatus: null };

  function currentRequest(url, method) {
    if (method !== 'GET' || url.origin !== location.origin) return null;
    const match = url.pathname.match(/^\/backend-(?:api|anon)\/conversation\/([a-zA-Z0-9_-]+)(?:\/messages)?\/?$/);
    return match && match[1] === model.conversationId(location.href) ? match[1] : null;
  }

  function accept(payload, id, sequence) {
    if (disposed || id !== model.conversationId(location.href) ||
        (cached?.conversationId === id && sequence < acceptedSequence)) return;
    counters.currentResponses++;
    let snapshot = model.projectConversation(payload, id) ||
      model.snapshotIn({ conversationId: id, conversation: payload, data: payload }, id);
    if (snapshot && cached?.conversationId === id) snapshot = model.mergeSnapshots(cached, snapshot);
    if (snapshot) { counters.parsedSnapshots++; acceptedSequence = sequence; publish(snapshot, 'response'); }
  }

  function publish(snapshot, source = cacheSource) {
    const currentId = model.conversationId(location.href);
    if (disposed || !snapshot || snapshot.conversationId !== currentId) return;
    cached = snapshot;
    cacheSource = source;
    if (nonce && requestedId === currentId) window.postMessage({ channel: CHANNEL, type: 'snapshot', nonce, snapshot }, location.origin);
  }

  async function inspect(response, url, method, sequence) {
    try {
      const id = currentRequest(url, method);
      if (!id) return;
      counters.lastHttpStatus = response.status;
      if (!response.ok) return;
      if (response.url && currentRequest(new URL(response.url), method) !== id) return;
      if (!/application\/json/i.test(response.headers.get('content-type') || '')) return;
      const clone = response.clone();
      const payload = await (originalJson ? Reflect.apply(originalJson, clone, []) : clone.json());
      accept(payload, id, sequence);
    } catch { /* 响应取消或格式改变时，由页面扫描接替。 */ }
  }

  const wrappedFetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    let url, method;
    try {
      const request = args[0];
      url = new URL(typeof request === 'string' || request instanceof URL ? String(request) : request.url, location.href);
      method = String(args[1]?.method || request?.method || 'GET').toUpperCase();
    } catch { return result; }
    // 原请求与原响应保持原样；只在符合条件时克隆一份 JSON。
    const sequence = ++requestSequence;
    result.then(response => { responseRequests.set(response, { method, sequence }); return inspect(response, url, method, sequence); }, () => {});
    return result;
  };
  window.fetch = wrappedFetch;

  // 覆盖页面在安装前保存的 fetch 引用：观察应用自己调用的 json()，原 Promise / 数据不变。
  const wrappedJson = function (...args) {
    const result = Reflect.apply(originalJson, this, args);
    let id = null;
    const request = responseRequests.get(this);
    try { if (this.ok && /application\/json/i.test(this.headers.get('content-type') || '')) id = currentRequest(new URL(this.url), request?.method || 'GET'); }
    catch { /* 合成 Response 没有请求地址。 */ }
    if (id) {
      const sequence = request?.sequence || ++requestSequence;
      result.then(value => { try { accept(value, id, sequence); } catch { /* 不影响网页消费者。 */ } }, () => {});
    }
    return result;
  };
  if (originalJson) ResponseType.prototype.json = wrappedJson;

  const wrappedOpen = function (method, url, ...args) {
    const result = Reflect.apply(originalOpen, this, [method, url, ...args]);
    let id = null;
    try { id = currentRequest(new URL(String(url), location.href), String(method).toUpperCase()); } catch { /* 无效地址由原实现处理。 */ }
    const record = { id, sequence: ++requestSequence };
    xhrRequests.set(this, record);
    if (id) this.addEventListener('load', () => {
      if (xhrRequests.get(this) !== record || disposed) return;
      counters.lastHttpStatus = this.status;
      if (this.status < 200 || this.status >= 300) return;
      try {
        if (this.responseURL && currentRequest(new URL(this.responseURL), 'GET') !== id) return;
        if (!/application\/json/i.test(this.getResponseHeader('content-type') || '')) return;
        const value = this.responseType === 'json' ? this.response :
          !this.responseType || this.responseType === 'text' ? JSON.parse(this.responseText) : null;
        if (value) accept(value, id, record.sequence);
      } catch { /* 仅支持当前对话 JSON，不读取其他响应。 */ }
    }, { once: true });
    return result;
  };
  if (originalOpen) XhrType.prototype.open = wrappedOpen;

  function notifyStatus(id, state) {
    if (!disposed && nonce && requestedId === id && id === model.conversationId(location.href)) {
      window.postMessage({ channel: CHANNEL, type: 'status', nonce, conversationId: id, state }, location.origin);
    }
  }

  function discover(id) {
    const committed = window.__chatgptRailPageState?.read(model, document, id);
    let snapshot = committed || model.snapshotIn(window.__reactRouterContext?.state?.loaderData, id) || model.snapshotIn(window.__NEXT_DATA__, id);
    if (!snapshot) {
      const script = document.getElementById('__NEXT_DATA__');
      if (script?.textContent) {
        try { snapshot = model.snapshotIn(JSON.parse(script.textContent), id); } catch { /* 非 JSON 不执行。 */ }
      }
    }
    // 初始注水数据可能已经过时，不能覆盖网络响应；已提交组件状态可以校正编辑和分支。
    if (!committed && cached?.conversationId === id && cacheSource === 'response' && cached.complete) return true;
    if (snapshot) publish(snapshot.complete ? snapshot : model.mergeSnapshots(cached, snapshot), 'bootstrap');
    return cached?.conversationId === id && cached.complete;
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || !['request', 'cancel', 'diagnose', 'navigate'].includes(message.type) ||
        typeof message.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(message.nonce)) return;
    const id = model.conversationId(location.href);
    if (!id || message.conversationId !== id) return;
    if (requestedId !== id) {
      if (requestedId) { counters.currentResponses = 0; counters.parsedSnapshots = 0; counters.lastHttpStatus = null; }
      if (cached?.conversationId !== id) { cached = null; cacheSource = ''; }
      requestedId = id;
      knownUserIds = new Set();
    }
    nonce = message.nonce;
    if (message.type === 'navigate') {
      // 只允许定位当前消息图的可见用户消息；网页自己的动作负责挂载目标。
      if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(message.requestId) ||
          typeof message.messageId !== 'string' || (!knownUserIds.has(message.messageId) &&
            (!cached || !model.entriesFromSnapshot(cached).some(entry => entry.messageId === message.messageId)))) return;
      const replyNonce = nonce;
      const reply = handled => {
        if (!disposed && nonce === replyNonce && model.conversationId(location.href) === id) window.postMessage({
          channel: CHANNEL, type: 'navigation', nonce: replyNonce, conversationId: id, requestId: message.requestId, handled
        }, location.origin);
      };
      try {
        const navigator = window.__chatgptRailPageState?.controls(document, id).navigator;
        if (navigator) Promise.resolve(Reflect.apply(navigator.call, navigator.owner, [message.messageId])).then(() => reply(true), () => reply(false));
        else reply(false);
      } catch { reply(false); }
      return;
    }
    if (message.type === 'diagnose') {
      const state = {};
      try { window.__chatgptRailPageState?.read(model, document, id, state); } catch { state.probeFailed = true; }
      window.postMessage({ channel: CHANNEL, type: 'diagnostics', nonce, conversationId: id, diagnostics: {
        bridgeVersion: VERSION, cachedSource: cacheSource || 'none', cachedNodes: cached?.conversationId === id ? cached.nodes.length : 0,
        cachedComplete: cached?.conversationId === id && cached.complete, ...counters, state,
        history: window.__chatgptRailHistory?.diagnostics(id) || { installed: false }
      } }, location.origin);
      return;
    }
    if (message.type === 'cancel') { window.__chatgptRailHistory?.cancel(id); return; }
    if (Array.isArray(message.knownMessageIds) && message.knownMessageIds.length <= 10000) {
      knownUserIds = new Set(message.knownMessageIds.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 240));
    }
    if (cached?.conversationId === id && cacheSource === 'response' && cached.complete) {
      discover(id); publish(cached); return;
    }
    if (discover(id)) return;
    if (cached?.conversationId === id) publish(cached);
    // 完整本地目录已恢复时，只核对网页现有数据；不再次逐页读取全部旧历史。
    if (message.skipHistory === true && message.force !== true) return;
    window.__chatgptRailHistory?.start(id, state => notifyStatus(id, state), () => {
      if (Date.now() - lastPageProbe > 700) { lastPageProbe = Date.now(); discover(id); }
      return cached?.conversationId === id && cached.complete;
    }, message.force === true, () => cached?.conversationId === id ? `${cached.nodes.length}:${cached.currentNode}` : '');
  }

  window.addEventListener('message', onMessage);
  window.__chatgptRailBridge = { version: VERSION, dispose() {
    disposed = true;
    window.removeEventListener('message', onMessage);
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (originalJson && ResponseType.prototype.json === wrappedJson) ResponseType.prototype.json = originalJson;
    if (originalOpen && XhrType.prototype.open === wrappedOpen) XhrType.prototype.open = originalOpen;
    cached = null; nonce = null;
  } };
})();
