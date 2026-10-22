/* 复用网页的历史加载器：只触发当前对话的分页观察回调，不读取认证信息、不滚动正文。 */
(() => {
  'use strict';
  const VERSION = '2.4.0';
  if (window.__chatgptRailHistory?.version === VERSION) return;
  window.__chatgptRailHistory?.dispose();
  const NativeObserver = window.IntersectionObserver;
  const records = new Set(), contexts = new WeakMap();
  let disposed = false, task = null, finishedId = null, pausedId = null, lastRun = null;
  const currentId = () => window.__chatgptRailModel?.conversationId(location.href);
  const scope = element => element?.isConnected && element.closest?.('main, [role="main"]') &&
    !element.closest('[hidden], [aria-hidden="true"], [inert], [data-message-author-role], [data-turn], [data-content-search-unit-key], [data-chatgpt-search-unit-key], aside, nav');
  const loadingLabel = element => /^(?:Loading (?:older|earlier) messages|正在加载(?:更早|较早|之前)的消息|正在載入較早的訊息|載入較早的訊息)[.…。\s]*$/i.test(
    element.getAttribute('aria-label') || element.textContent?.trim() || '');
  const isLoader = element => {
    if (!scope(element)) return false;
    // 观察目标可以是提示的内层 sentinel；不依赖提示文字必须在 target 自身。
    for (let node = element, depth = 0; node && depth < 3 && scope(node); node = node.parentElement, depth++) {
      if (/^(?:history-loader|load-older-messages|conversation-history-loader)$/.test(node.getAttribute('data-testid') || '') ||
          (node.matches('[role="status"]') || node.querySelector('[role="status"]')) && loadingLabel(node)) return true;
    }
    return false;
  };

  const Observed = NativeObserver && class extends NativeObserver {
    constructor(callback, options) {
      super(callback, options);
      contexts.set(this, { callback, root: options?.root, targets: new Map() });
    }
    observe(target) {
      super.observe(target);
      const context = contexts.get(this);
      // React 可能先注册观察，再挂载文字或插入 DOM。识别工作延后到 step，避免漏掉加载器。
      if (!disposed && context) {
        const record = { observer: this, target, context, revision: null, id: currentId() };
        const old = context.targets.get(target);
        if (old) records.delete(old);
        context.targets.set(target, record); records.add(record);
      }
    }
    unobserve(target) {
      super.unobserve(target);
      const context = contexts.get(this), record = context?.targets.get(target);
      if (record) { records.delete(record); context.targets.delete(target); }
    }
    disconnect() {
      super.disconnect();
      const context = contexts.get(this);
      for (const record of context?.targets.values() || []) records.delete(record);
      context?.targets.clear();
    }
  };
  if (Observed) window.IntersectionObserver = Observed;

  function stop(state) {
    const previous = task;
    if (!previous) return;
    task = null;
    lastRun = { id: previous.id, pages: previous.pages };
    window.clearTimeout(previous.timer);
    if (state === 'complete' || state === 'error') finishedId = previous.id;
    previous.onProgress?.();
    previous.onStatus?.(state);
  }

  function step(run) {
    if (disposed || task !== run || run.id !== currentId()) { if (task === run) stop('cancelled'); return; }
    const now = Date.now();
    if (run.onProgress?.() === true) { stop('complete'); return; }
    if (task !== run) return;
    const revision = run.readRevision?.() || '';
    if (revision !== run.revision) { run.revision = revision; run.lastProgress = now; }
    let pager;
    try { pager = window.__chatgptRailPageState?.controls(document, run.id).pager; } catch { /* 状态尚未挂载。 */ }
    const loaders = [...records].filter(record => (record.id === run.id || !record.id) && isLoader(record.target));
    if (pager?.error) { stop('error'); return; }
    if (pager?.hasMore && !pager.busy) {
      // 晚注入时也可使用页面已经提交的分页回调；等待 Promise 和数据变化后才取下一页。
      if (!run.pending && run.pagerRevision !== revision && now - run.lastCall > 400) {
        run.pagerRevision = revision; run.pages++; run.lastCall = now; run.pending = true;
        run.onStatus?.('loading');
        try {
          Promise.resolve(Reflect.apply(pager.call, pager.owner, [])).then(
            () => { run.pending = false; }, () => { if (task === run) stop('error'); });
        } catch { stop('error'); return; }
      }
    } else if (!pager && loaders.length) {
      const next = loaders.find(record => record.revision !== revision);
      if (next && now - run.lastCall > 400) {
        next.id = run.id; next.revision = revision; run.pages++; run.lastCall = now;
        run.onStatus?.('loading');
        const rect = next.target.getBoundingClientRect();
        try {
          // 同一观察器可跨页复用；只有索引确实前进后才允许再次触发，防止空转请求。
          Reflect.apply(next.context.callback, next.observer, [[{
            target: next.target, isIntersecting: true, intersectionRatio: 1,
            boundingClientRect: rect, intersectionRect: rect,
            rootBounds: next.context.root?.getBoundingClientRect() || null,
            time: performance.now()
          }], next.observer]);
        } catch { stop('error'); return; }
      }
    } else if (!pager?.busy && !run.pending) {
      const retry = [...records].some(record => record.id === run.id && scope(record.target) && /^(?:Try again|重试|再试一次)\s*$/.test(record.target.textContent?.trim() || ''));
      if (retry) { stop('error'); return; }
      // 提示暂时卸载不代表读完；只由完整消息图确认完成。
      if (run.pages && now - Math.max(run.lastProgress, run.lastCall) > 5500) { stop('unavailable'); return; }
      if (!run.pages && now - run.started > 5500) { stop('unavailable'); return; }
    }
    if (run.pages && now - Math.max(run.lastProgress, run.lastCall) > 15000) { stop('error'); return; }
    if (now - run.started > 90000 || run.pages >= 200) { stop('error'); return; }
    run.timer = window.setTimeout(() => step(run), 250);
  }

  window.__chatgptRailHistory = {
    version: VERSION,
    diagnostics(id) {
      const current = [...records].filter(record => (record.id === id || !record.id) && scope(record.target));
      let controls;
      try { controls = window.__chatgptRailPageState?.controls(document, id); } catch { /* 未就绪。 */ }
      return { observerHookActive: window.IntersectionObserver === Observed,
        nativePagerAvailable: !!controls?.pager, nativeNavigationAvailable: !!controls?.navigator,
        observedPageTargets: current.length, recognizedHistoryTargets: current.filter(record => isLoader(record.target)).length,
        pagesTriggered: task?.id === id ? task.pages : lastRun?.id === id ? lastRun.pages : 0,
        running: task?.id === id, paused: pausedId === id, stopped: finishedId === id };
    },
    start(id, onStatus, onProgress, force = false, readRevision = null) {
      if (force) { finishedId = null; pausedId = null; for (const record of records) record.revision = null; }
      if (disposed || id !== currentId() || finishedId === id || pausedId === id || task?.id === id) return;
      if (task) stop('cancelled');
      const run = { id, onStatus, onProgress, readRevision, started: Date.now(), lastProgress: Date.now(),
        lastCall: 0, pages: 0, timer: 0, revision: '', pagerRevision: null, pending: false };
      task = run; step(run);
    },
    cancel(id) { pausedId = id; if (task?.id === id) stop('cancelled'); },
    dispose() {
      disposed = true; stop('cancelled'); records.clear();
      if (Observed && window.IntersectionObserver === Observed) window.IntersectionObserver = NativeObserver;
    }
  };
})();
