/* 扩展隔离上下文的本地导航记忆；只持久化经过裁剪的目录，不请求网络。 */
(function (root, factory) {
  'use strict';
  const memory = factory();
  if (typeof module === 'object' && module.exports) module.exports = memory;
  else root.__chatgptRailMemory = memory;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const PREFIX = 'question-memory:v1:';
  const TTL = 90 * 24 * 60 * 60 * 1000;
  const MAX_RECORD = 1024 * 1024, MAX_TOTAL = 6 * 1024 * 1024, MAX_CONVERSATIONS = 50;
  const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 240 ? value : '';
  const scopeKey = (origin, id) => /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/.test(origin) &&
    typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? `${PREFIX}${origin}:${id}` : null;

  function cleanEntries(values) {
    if (!Array.isArray(values) || !values.length || values.length > 10000) return null;
    const seen = new Set(), entries = [];
    for (const item of values) {
      const key = identifier(item?.key);
      if (!key || seen.has(key) || !/^\d+:\d+$/.test(item.signature || '')) return null;
      seen.add(key);
      const messageId = identifier(item.messageId), nodeId = identifier(item.nodeId);
      entries.push({ key, messageId, nodeId,
        messageIdKind: ['message', 'turn'].includes(item.messageIdKind) ? item.messageIdKind : messageId ? 'message' : 'none',
        aliases: Array.isArray(item.aliases) ? item.aliases.map(identifier).filter(Boolean).slice(0, 4) : [messageId, nodeId].filter(Boolean),
        identifiers: Array.isArray(item.identifiers) ? item.identifiers.map(identifier).filter(Boolean).slice(0, 6) : [messageId, nodeId].filter(Boolean),
        unitKey: typeof item.unitKey === 'string' ? item.unitKey.slice(0, 300) : '',
        signature: item.signature, prompt: String(item.prompt || item.preview || '').slice(0, 200),
        preview: String(item.preview || '').slice(0, 201), response: String(item.response || '').slice(0, 800),
        attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 5).map(file => ({
          name: String(file?.name || '附件').slice(0, 120), type: String(file?.type || 'file').slice(0, 80)
        })) : [],
        position: Number.isFinite(item.position) ? Math.max(0, Math.min(1e9, item.position)) : 0,
        positionKnown: item.positionKnown === true || item.source !== 'data',
        source: ['data', 'live'].includes(item.source) ? item.source : 'page', ordinal: entries.length });
    }
    return entries;
  }

  function activeSnapshot(model, snapshot, entries, id) {
    const normalized = model?.normalizeSnapshot(snapshot, id);
    if (!normalized) return null;
    const byId = new Map(normalized.nodes.map(node => [node.id, node]));
    const required = new Set(entries.filter(entry => entry.source === 'data').map(entry => entry.nodeId));
    const pathFor = leaf => {
      const path = [], seen = new Set();
      for (let node = byId.get(leaf); node && !seen.has(node.id); node = byId.get(node.parent)) {
        seen.add(node.id); path.push(node);
      }
      return path.reverse();
    };
    let path = pathFor(normalized.currentNode);
    const score = values => values.reduce((total, node) => total + Number(required.has(node.id)), 0);
    let best = score(path);
    if (best < required.size) for (const node of normalized.nodes) {
      if (node.children.some(child => byId.has(child))) continue;
      const candidate = pathFor(node.id), value = score(candidate);
      if (value > best) { path = candidate; best = value; }
    }
    if (!path.length) return null;
    return { conversationId: id, currentNode: path.at(-1).id, complete: normalized.complete && !path[0].parent,
      nodes: path.map((node, index) => ({ ...node, children: path[index + 1] ? [path[index + 1].id] : [],
        text: node.text.slice(0, node.role === 'user' ? 200 : 800),
        attachments: node.attachments.slice(0, 5).map(file => ({ name: file.name.slice(0, 120), type: file.type.slice(0, 80) })) })) };
  }

  function encode(model, { origin, id, snapshot, entries, complete }, now = Date.now()) {
    if (!scopeKey(origin, id)) return null;
    const cleaned = cleanEntries(entries);
    if (!cleaned) return null;
    const graph = activeSnapshot(model, snapshot, cleaned, id);
    const record = { version: 1, origin, conversationId: id, updatedAt: now,
      complete: graph ? graph.complete : complete === true, snapshot: graph, entries: cleaned };
    return size(record) <= MAX_RECORD ? record : null;
  }

  function decode(model, record, origin, id, now = Date.now()) {
    if (!record || record.version !== 1 || !scopeKey(origin, id) || record.origin !== origin || record.conversationId !== id ||
        !Number.isFinite(record.updatedAt) || record.updatedAt > now + 60000 || now - record.updatedAt > TTL || size(record) > MAX_RECORD) return null;
    const result = encode(model, { origin, id, snapshot: record.snapshot, entries: record.entries, complete: record.complete }, record.updatedAt);
    if (record.snapshot && !result?.snapshot) return null;
    return result;
  }

  function create(model, storage, clock = Date.now) {
    let pending = Promise.resolve();
    const enqueue = action => { const result = pending.catch(() => {}).then(action); pending = result; return result; };
    return {
      available: !!storage?.get && !!storage?.set && !!storage?.remove,
      key: scopeKey,
      load(origin, id) {
        const key = scopeKey(origin, id);
        if (!storage?.get || !key) return Promise.resolve(null);
        return enqueue(async () => {
          const value = (await storage.get(key))[key];
          const record = decode(model, value, origin, id, clock());
          if (value && !record) await storage.remove(key);
          return record;
        });
      },
      save(input) {
        const key = scopeKey(input.origin, input.id), record = encode(model, input, clock());
        if (!storage?.set || !storage?.remove || !key || !record) return Promise.resolve(null);
        // 后台单次完成写入及淘汰，页面关闭后仍可继续，不依赖内容脚本完成多轮消息。
        if (storage.saveRecord) return storage.saveRecord(key, record);
        return enqueue(async () => {
          const all = await storage.get(null), remove = [];
          const records = [{ key, updatedAt: record.updatedAt, bytes: size(record) }];
          for (const [name, value] of Object.entries(all)) {
            if (!name.startsWith(PREFIX) || name === key) continue;
            if (!value || value.version !== 1 || !Number.isFinite(value.updatedAt) || clock() - value.updatedAt > TTL) remove.push(name);
            else records.push({ key: name, updatedAt: value.updatedAt, bytes: size(value) });
          }
          records.sort((a, b) => Number(b.key === key) - Number(a.key === key) || b.updatedAt - a.updatedAt);
          let bytes = 0;
          records.forEach((item, index) => {
            if (index >= MAX_CONVERSATIONS || bytes + item.bytes > MAX_TOTAL) remove.push(item.key);
            else bytes += item.bytes;
          });
          if (remove.length) await storage.remove(remove);
          await storage.set({ [key]: record });
          return record;
        });
      },
      clear(origin, id) {
        const key = scopeKey(origin, id);
        return enqueue(async () => { if (key && storage?.remove) await storage.remove(key); });
      },
      clearAll() {
        return enqueue(async () => {
          if (!storage?.get || !storage?.remove) return;
          const keys = Object.keys(await storage.get(null)).filter(key => key.startsWith(PREFIX));
          if (keys.length) await storage.remove(keys);
        });
      }
    };
  }

  function storage(local, runtime) {
    if (!runtime?.sendMessage) return local;
    const send = async (action, value) => {
      const result = await runtime.sendMessage({ channel: 'chatgpt-navigator-memory', action, value });
      if (!result?.ok) {
        const error = new Error(result?.error || '本地记忆后台未连接，请重新加载扩展');
        error.name = result?.name || 'MemoryStorageError'; throw error;
      }
      return result.value;
    };
    return { get: key => send('get', key), set: values => send('set', values), remove: keys => send('remove', keys),
      saveRecord: (key, record) => send('save-record', { key, record }),
      status: () => send('status'), openSettings: () => send('open-settings') };
  }

  return Object.freeze({ create, encode, decode, scopeKey, storage, limits: Object.freeze({ TTL, MAX_RECORD, MAX_TOTAL, MAX_CONVERSATIONS }) });
});
