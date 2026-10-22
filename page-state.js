/* 读取已提交的 React 状态；只暴露当前对话明确命名的分页 / 消息定位动作。 */
(function (root, factory) {
  'use strict';
  const reader = factory();
  if (typeof module === 'object' && module.exports) module.exports = reader;
  else root.__chatgptRailPageState = reader;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function own(object, key) {
    try { return object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined; }
    catch { return undefined; }
  }

  function collect(document, id, report = null) {
    if (!id || !document?.querySelectorAll) return [];
    const seeds = [], fibers = [], visited = new Set();
    const elements = [...document.querySelectorAll('main, [role="main"], #root, #__next, [data-message-author-role="user"], [data-user-message-bubble]')].slice(0, 18);
    elements.push(...[...(document.body?.children || [])].slice(0, 12));
    for (const element of elements) {
      for (const key of Object.getOwnPropertyNames(element)) {
        if (!/^__react(?:Fiber|Container|Props)\$/.test(key)) continue;
        const value = own(element, key);
        if (key.startsWith('__reactProps$')) seeds.push(value);
        else {
          // 优先收集每个可见节点的整条祖先链，防止大量消息子节点耗尽遍历预算。
          const chain = new Set();
          for (let fiber = own(value, 'current') || value, depth = 0; fiber && depth < 80 && !chain.has(fiber); fiber = own(fiber, 'return'), depth++) {
            chain.add(fiber); fibers.push(fiber);
          }
        }
      }
    }
    if (report) report.reactAnchors = fibers.length;
    // 从可见气泡沿父链找到虚拟列表和对话 Provider，而不是只读当前渲染的几条消息。
    for (let at = 0; at < fibers.length && at < 360; at++) {
      const fiber = fibers[at];
      if (!fiber || typeof fiber !== 'object' || visited.has(fiber)) continue;
      visited.add(fiber);
      // 只读已经提交到页面的状态，不使用并发渲染中的 pendingProps / baseState。
      const props = own(fiber, 'memoizedProps');
      seeds.push(props);
      const ownerId = own(props, 'conversationId') || own(props, 'conversation_id');
      const hookSeen = new Set();
      for (let hook = own(fiber, 'memoizedState'), count = 0; hook && count < 40 && !hookSeen.has(hook); hook = own(hook, 'next'), count++) {
        hookSeen.add(hook);
        const value = own(hook, 'memoizedState');
        seeds.push(ownerId === id ? { conversationId: id, history: value } : value);
        if (!Object.prototype.hasOwnProperty.call(hook, 'next')) seeds.push(hook);
      }
      let context = own(own(fiber, 'dependencies'), 'firstContext');
      for (let count = 0; context && count < 20; count++, context = own(context, 'next')) seeds.push(own(context, 'memoizedValue'));
      for (const key of ['return', 'child', 'sibling']) {
        const next = own(fiber, key);
        if (next && fibers.length < 900) fibers.push(next);
      }
    }
    if (report) { report.fibersInspected = visited.size; report.stateSeeds = seeds.filter(Boolean).length; }
    return seeds.filter(Boolean);
  }

  function read(model, document, id, report = null) {
    return model.snapshotIn(collect(document, id, report), id, report);
  }

  function controls(document, id) {
    const queue = collect(document, id).map(value => ({ value, bound: false })), seen = new Map();
    const result = { pager: null, navigator: null };
    for (let at = 0; at < queue.length && at < 1600; at++) {
      const { value, bound } = queue[at];
      if (!value || typeof value !== 'object' || seen.get(value)?.has(bound)) continue;
      if (!seen.has(value)) seen.set(value, new Set());
      seen.get(value).add(bound);
      const ownerId = own(value, 'conversationId') || own(value, 'conversation_id');
      if (ownerId && ownerId !== id) continue;
      const scoped = ownerId === id || bound;
      if (scoped) {
        for (const name of ['fetchPreviousPage', 'loadOlderMessages', 'loadEarlierMessages', 'onLoadOlderMessages']) {
          const call = own(value, name);
          const hasMore = own(value, 'hasPreviousPage') ?? own(value, 'hasMore') ?? own(value, 'has_more');
          // 没有明确的分页状态就不调用。避免误触普通查询、提交或重新生成。
          if (typeof call === 'function' && typeof hasMore === 'boolean' && !result.pager) {
            result.pager = { owner: value, call, hasMore,
              busy: own(value, 'isFetchingPreviousPage') === true || own(value, 'isLoadingOlderMessages') === true,
              error: own(value, 'isFetchPreviousPageError') === true };
          }
        }
        for (const name of ['scrollToMessage', 'scrollToMessageId', 'onScrollToMessage']) {
          const call = own(value, name);
          if (typeof call === 'function' && !result.navigator) result.navigator = { owner: value, call };
        }
      }
      // 身份只沿明确的当前对话动作字段传播，不传播到任意缓存 / 其他对话。
      let fields;
      try { fields = Object.getOwnPropertyDescriptors(value); } catch { continue; }
      for (const [key, descriptor] of Object.entries(fields)) {
        if (/token|auth|session|cookie|secret|password/i.test(key) ||
            /^(?:mapping|nodes|children|return|sibling|alternate|stateNode|_owner|ownerDocument|parentNode)$/.test(key)) continue;
        if (descriptor.value && typeof descriptor.value === 'object' && queue.length < 3200) {
          queue.push({ value: descriptor.value, bound: scoped && /^(?:history|pagination|navigation|current)$/.test(key) });
        }
      }
    }
    return result;
  }

  return Object.freeze({ read, controls });
});
