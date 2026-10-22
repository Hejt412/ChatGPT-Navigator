/* 复用网页的历史加载器：只触发当前对话的分页观察回调，不读取认证信息、不滚动正文。 */
(() => {
  'use strict';
  const VERSION = '2.2.1';
  if (window.__chatgptRailHistory?.version === VERSION) return;
  window.__chatgptRailHistory?.dispose();
  const NativeObserver = window.IntersectionObserver;
  const records = new Set(), contexts = new WeakMap();
  let disposed = false, task = null, finishedId = null, pausedId = null, lastRun = null;
  const currentId = () => window.__chatgptRailModel?.conversationId(location.href);
  const scope = element => element?.isConnected && element.closest?.('main, [role="main"]') &&
    !element.closest('[hidden], [aria-hidden="true"], [inert], [data-message-author-role], [data-turn], [data-content-search-unit-key], [data-chatgpt-search-unit-key], aside, nav');
  const loadingLabel = element => /^(?:Loading (?:older|earlier) messages|正在加载(?:更早|较早|之前)的消息|正在載入較早的訊息|載入較早的訊息)[.…。\s]*$/i.test(element.textContent?.trim() || '');
  const isLoader = element => scope(element) &&
    (element.matches('[role="status"]') || element.querySelector('[role="status"]')) && loadingLabel(element);

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
        const record = { observer: this, target, context, called: false, id: currentId() };
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
    const loaders = [...records].filter(record => record.id === run.id && isLoader(record.target));
    if (!loaders.length) {
      const retry = [...records].some(record => record.id === run.id && scope(record.target) && /^(?:Try again|重试|再试一次)\s*$/.test(record.target.textContent?.trim() || ''));
      if (retry) { stop('error'); return; }
      if (run.pages && now - run.lastCall > 900) { stop('complete'); return; }
      if (!run.pages && now - run.started > 5500) { stop('unavailable'); return; }
    } else {
      const next = loaders.find(record => !record.called);
      if (next && now - run.lastCall > 400) {
        next.called = true; run.pages++; run.lastCall = now;
        run.onStatus?.('loading');
        const rect = next.target.getBoundingClientRect();
        try {
          // 与用户滚到历史占位符时执行同一回调；网页负责认证、分页和更新消息图。
          Reflect.apply(next.context.callback, next.observer, [[{
            target: next.target, isIntersecting: true, intersectionRatio: 1,
            boundingClientRect: rect, intersectionRect: rect,
            rootBounds: next.context.root?.getBoundingClientRect() || null,
            time: performance.now()
          }], next.observer]);
        } catch { stop('error'); return; }
      }
      if (run.pages && now - run.lastCall > 15000) { stop('error'); return; }
    }
    if (now - run.started > 90000 || run.pages >= 200) { stop('error'); return; }
    run.timer = window.setTimeout(() => step(run), 250);
  }

  window.__chatgptRailHistory = {
    version: VERSION,
    diagnostics(id) {
      const current = [...records].filter(record => record.id === id && scope(record.target));
      return { observerHookActive: window.IntersectionObserver === Observed,
        observedPageTargets: current.length, recognizedHistoryTargets: current.filter(record => isLoader(record.target)).length,
        pagesTriggered: task?.id === id ? task.pages : lastRun?.id === id ? lastRun.pages : 0,
        running: task?.id === id, paused: pausedId === id, stopped: finishedId === id };
    },
    start(id, onStatus, onProgress, force = false) {
      if (force) { finishedId = null; pausedId = null; for (const record of records) record.called = false; }
      if (disposed || !Observed || id !== currentId() || finishedId === id || pausedId === id || task?.id === id) return;
      if (task) stop('cancelled');
      const run = { id, onStatus, onProgress, started: Date.now(), lastCall: 0, pages: 0, timer: 0 };
      task = run; step(run);
    },
    cancel(id) { pausedId = id; if (task?.id === id) stop('cancelled'); },
    dispose() {
      disposed = true; stop('cancelled'); records.clear();
      if (Observed && window.IntersectionObserver === Observed) window.IntersectionObserver = NativeObserver;
    }
  };
})();
