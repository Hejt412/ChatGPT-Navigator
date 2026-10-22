/* 读取页面已挂载的 React 状态；不调用组件、store 方法、getter 或网络。 */
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

  function read(model, document, id, report = null) {
    if (!id || !document?.querySelectorAll) return null;
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
      seeds.push(own(fiber, 'memoizedProps'));
      const hookSeen = new Set();
      for (let hook = own(fiber, 'memoizedState'), count = 0; hook && count < 40 && !hookSeen.has(hook); hook = own(hook, 'next'), count++) {
        hookSeen.add(hook);
        seeds.push(own(hook, 'memoizedState'));
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
    return model.snapshotIn(seeds.filter(Boolean), id, report);
  }

  return Object.freeze({ read });
});
