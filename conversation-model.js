/* 当前分支的只读数据模型；不请求网络、不保存消息。 */
(function (root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.__chatgptRailModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_NODES = 20000;
  const MAX_TEXT = 24000;
  const normalize = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  function signature(text) {
    const value = normalize(text);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return `${value.length}:${hash >>> 0}`;
  }

  function conversationId(url) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\/(?:c)\/([a-zA-Z0-9_-]{1,128})(?:\/|$)/);
      return match ? match[1] : null;
    } catch { return null; }
  }

  function textFrom(content) {
    if (typeof content === 'string') return content;
    if (!content || typeof content !== 'object') return '';
    if (Array.isArray(content.parts)) return content.parts.filter(part => typeof part === 'string').join('\n');
    return typeof content.text === 'string' ? content.text : '';
  }

  function attachmentsFrom(message) {
    const attachments = message.metadata?.attachments;
    const files = Array.isArray(attachments) ? attachments.slice(0, 20).map(file => ({
      name: String(file?.name || file?.filename || '附件').slice(0, 240),
      type: String(file?.mime_type || file?.type || 'file').slice(0, 80)
    })) : [];
    for (const part of message.content?.parts || []) {
      if (part && typeof part === 'object' && /image/.test(String(part.content_type || part.type || ''))) {
        if (files.length < 20) files.push({ name: '图片', type: 'image' });
      }
    }
    return files;
  }

  function projectConversation(payload, expectedId) {
    if (!payload || typeof payload !== 'object' || !payload.mapping || typeof payload.mapping !== 'object') return null;
    const id = payload.conversation_id || payload.conversationId || payload.id;
    if (typeof id !== 'string' || id !== expectedId) return null;
    let mapping;
    try { mapping = [...Map.prototype.entries.call(payload.mapping)]; }
    catch { mapping = Object.entries(payload.mapping); }
    if (!mapping.length || mapping.length > MAX_NODES) return null;
    const nodes = mapping.map(([key, value]) => {
      const node = value && typeof value === 'object' ? value : {};
      const message = node.message || {};
      const role = message.author?.role;
      const visible = (role === 'user' || role === 'assistant') &&
        !message.metadata?.is_visually_hidden_from_conversation &&
        !['analysis', 'commentary'].includes(message.channel) &&
        (!message.recipient || message.recipient === 'all') &&
        message.content?.content_type !== 'user_editable_context';
      const raw = visible ? textFrom(message.content) : '';
      return {
        id: String(node.id || key), parent: typeof node.parent === 'string' ? node.parent : null,
        children: Array.isArray(node.children) ? node.children.filter(child => typeof child === 'string').slice(0, MAX_NODES) : [],
        messageId: typeof message.id === 'string' ? message.id : String(node.id || key),
        role: visible ? role : '', text: raw.slice(0, MAX_TEXT), signature: signature(raw),
        attachments: visible && role === 'user' ? attachmentsFrom(message) : []
      };
    });
    const currentNode = payload.current_node || payload.currentNode;
    const byId = new Map(nodes.map(node => [node.id, node]));
    let node = byId.get(currentNode), rooted = false;
    const ancestry = new Set();
    while (node && !ancestry.has(node.id)) {
      ancestry.add(node.id);
      if (!node.parent) { rooted = true; break; }
      node = byId.get(node.parent);
    }
    return normalizeSnapshot({ conversationId: id, currentNode,
      complete: payload.has_more !== true && payload.is_partial !== true && rooted, nodes }, expectedId);
  }

  function normalizeSnapshot(value, expectedId) {
    if (!value || value.conversationId !== expectedId || !Array.isArray(value.nodes) ||
        !value.nodes.length || value.nodes.length > MAX_NODES) return null;
    const seen = new Set();
    const nodes = [];
    for (const node of value.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 240 || seen.has(node.id)) return null;
      seen.add(node.id);
      const role = node.role === 'user' || node.role === 'assistant' ? node.role : '';
      const text = role && typeof node.text === 'string' ? node.text.slice(0, MAX_TEXT) : '';
      nodes.push({ id: node.id, parent: typeof node.parent === 'string' ? node.parent : null,
        children: Array.isArray(node.children) ? node.children.filter(id => typeof id === 'string').slice(0, MAX_NODES) : [],
        messageId: typeof node.messageId === 'string' && node.messageId.length <= 240 ? node.messageId : node.id,
        role, text, signature: typeof node.signature === 'string' && /^\d+:\d+$/.test(node.signature) ? node.signature : signature(text),
        attachments: role === 'user' && Array.isArray(node.attachments) ? node.attachments.slice(0, 20).map(file => ({
          name: String(file?.name || '附件').slice(0, 240), type: String(file?.type || 'file').slice(0, 80)
        })) : [] });
    }
    const currentNode = typeof value.currentNode === 'string' && seen.has(value.currentNode) ? value.currentNode : nodes.at(-1).id;
    return { conversationId: expectedId, currentNode, complete: value.complete === true, nodes };
  }

  function entriesFromSnapshot(snapshot, visibleIds = []) {
    if (!snapshot) return [];
    const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
    const byMessage = new Map(snapshot.nodes.map(node => [node.messageId, node.id]));
    const pathFor = id => {
      const path = [], visited = new Set();
      for (let node = byId.get(id); node && !visited.has(node.id); node = byId.get(node.parent)) {
        visited.add(node.id); path.push(node);
      }
      return path.reverse();
    };
    let path = pathFor(snapshot.currentNode);
    const requested = visibleIds.map(id => byMessage.get(id) || (byId.has(id) ? id : null)).filter(Boolean);
    if (requested.some(id => !path.some(node => node.id === id))) {
      // 仅由真实消息 ID 选择分支；相同问题文本不能替代分支身份。
      const required = new Set(requested);
      let best = -1;
      for (const node of snapshot.nodes) {
        if (node.children.some(id => byId.has(id))) continue;
        const candidate = pathFor(node.id);
        const score = candidate.reduce((count, item) => count + (required.has(item.id) ? 1 : 0), 0);
        if (score > best) { best = score; path = candidate; }
      }
    }
    const result = [];
    for (const node of path) {
      if (node.role === 'user') {
        result.push({ key: `message:${node.messageId}`, messageId: node.messageId, aliases: [node.messageId, node.id],
          nodeId: node.id, signature: node.signature, prompt: normalize(node.text),
          preview: normalize(node.text).slice(0, 200) || (node.attachments.length ? '（图片或附件）' : '（空白消息）'),
          response: '', attachments: node.attachments, ordinal: result.length });
      } else if (node.role === 'assistant' && result.length && node.text.trim()) {
        const entry = result.at(-1);
        entry.response = (entry.response ? entry.response + '\n' : '') + node.text.slice(0, 1600);
        entry.response = entry.response.slice(0, 2400);
      }
    }
    return result;
  }

  function mergeSnapshots(previous, next) {
    if (!previous || previous.conversationId !== next.conversationId) return next;
    const nodes = new Map(previous.nodes.map(node => [node.id, node]));
    for (const node of next.nodes) nodes.set(node.id, node);
    if (nodes.size > MAX_NODES) return next;
    const isAncestor = (ancestor, leaf) => {
      const seen = new Set();
      for (let node = nodes.get(leaf); node && !seen.has(node.id); node = nodes.get(node.parent)) {
        if (node.id === ancestor) return true;
        seen.add(node.id);
      }
      return false;
    };
    // 较早分页的叶节点属于当前路径时，保留已有的最新叶节点。分支切换则用新快照。
    if (!isAncestor(next.currentNode, previous.currentNode)) return next;
    const currentNode = previous.currentNode;
    let rooted = false;
    const seen = new Set();
    for (let node = nodes.get(currentNode); node && !seen.has(node.id); node = nodes.get(node.parent)) {
      seen.add(node.id);
      if (!node.parent) { rooted = true; break; }
    }
    return normalizeSnapshot({ conversationId: next.conversationId, currentNode, nodes: [...nodes.values()],
      complete: rooted && (previous.complete || next.complete) }, next.conversationId);
  }

  function snapshotIn(root, expectedId, report = null) {
    const queue = [root], visited = new Set();
    let best = null;
    const remember = result => {
      if (result && (!best || Number(result.complete) > Number(best.complete))) best = result;
    };
    for (let at = 0; at < queue.length && at < 2500; at++) {
      const value = queue[at];
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      if (report) report.inspectedObjects = visited.size;
      // React 的查询数据可能保留在类实例或 Map 中；只看自有数据字段，不调用方法或 getter。
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { continue; }
      if (typeof descriptors.nodeType?.value === 'number' || typeof descriptors.then?.value === 'function') continue;
      if (descriptors.conversationId?.value === expectedId && Array.isArray(descriptors.nodes?.value)) {
        try { remember(normalizeSnapshot(value, expectedId)); } catch { /* 非普通缓存值。 */ }
      }
      if (descriptors.mapping?.value) {
        if (report) {
          report.graphCandidates = (report.graphCandidates || 0) + 1;
          const candidateId = descriptors.conversationId?.value || descriptors.conversation_id?.value || descriptors.id?.value;
          if (!candidateId) report.graphsWithoutIdentity = (report.graphsWithoutIdentity || 0) + 1;
          else if (candidateId === expectedId) report.graphsWithCurrentIdentity = (report.graphsWithCurrentIdentity || 0) + 1;
        }
        const plain = Object.fromEntries(Object.entries(descriptors).filter(([, item]) => 'value' in item).map(([key, item]) => [key, item.value]));
        try { remember(projectConversation(plain, expectedId)); } catch { /* 不执行不可读的缓存对象。 */ }
        // 消息图已经规范化，不再遍历全部消息对象。
        continue;
      }
      // 页面组件将身份和消息图分开传入：{ conversationId, conversation: { current_node, mapping } }。
      // 只绑定这个明确的直属字段，不向整个缓存树传播身份。
      const ownerId = descriptors.conversationId?.value || descriptors.conversation_id?.value;
      const conversation = descriptors.conversation?.value;
      if (ownerId === expectedId && conversation && typeof conversation === 'object') {
        if (report) report.boundConversationFields = (report.boundConversationFields || 0) + 1;
        try {
          const fields = Object.getOwnPropertyDescriptors(conversation);
          const childId = fields.conversationId?.value || fields.conversation_id?.value || fields.id?.value;
          if (!childId || childId === expectedId) {
            const graph = Object.fromEntries(Object.entries(fields).filter(([, item]) => 'value' in item).map(([key, item]) => [key, item.value]));
            remember(projectConversation({ ...graph, conversation_id: expectedId }, expectedId));
          }
        } catch { /* 不调用缓存访问器。 */ }
      }
      try {
        for (const child of Map.prototype.values.call(value)) {
          if (child && typeof child === 'object' && queue.length < 5000) queue.push(child);
        }
      } catch { /* 普通对象没有 Map 内部槽。 */ }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (/token|auth|session|cookie|secret|password/i.test(key) ||
            /^(?:children|return|sibling|alternate|stateNode|_owner|ownerDocument|parentNode)$/.test(key)) continue;
        const child = descriptor.value;
        if (child && typeof child === 'object' && queue.length < 5000) queue.push(child);
      }
    }
    if (report) { report.acceptedNodes = best?.nodes.length || 0; report.acceptedComplete = best?.complete === true; }
    return best;
  }

  return Object.freeze({ normalize, signature, conversationId, projectConversation, normalizeSnapshot, entriesFromSnapshot, mergeSnapshots, snapshotIn });
});
