const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../conversation-model.js');
const memory = require('../navigation-memory.js');
const origin = 'https://chatgpt.com';

function input(id = 'chat') {
  const snapshot = model.normalizeSnapshot({ conversationId: id, currentNode: 'a', complete: true, nodes: [
    { id: 'root', parent: null, children: ['q'], role: '', text: 'hidden-system-secret' },
    { id: 'q', parent: 'root', children: ['a', 'alt'], messageId: 'user-1', role: 'user', text: '问题'.repeat(200),
      attachments: [{ name: '结果.pdf', type: 'pdf', url: 'private-file-url' }] },
    { id: 'a', parent: 'q', children: [], role: 'assistant', text: '回答'.repeat(800) },
    { id: 'alt', parent: 'q', children: [], role: 'user', text: 'inactive-branch-secret' }
  ] }, id);
  return { origin, id, snapshot, entries: model.entriesFromSnapshot(snapshot).map(item => ({ ...item, source: 'data', position: 360, positionKnown: true })), complete: true };
}
function storage() {
  const data = {};
  return { data,
    async get(key) { return structuredClone(key === null ? data : { [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
}

test('persistent records retain message identities and positions, limit previews and exclude private metadata and inactive branches', () => {
  const record = memory.encode(model, input(), 1000);
  const value = JSON.stringify(record);
  assert.equal(record.entries[0].position, 360);
  assert.equal(record.entries[0].messageId, 'user-1');
  assert.ok(record.entries[0].response.length <= 800);
  assert.ok(record.snapshot.nodes.find(node => node.id === 'q').text.length <= 200);
  assert.equal(record.snapshot.nodes.find(node => node.id === 'q').signature, input().snapshot.nodes.find(node => node.id === 'q').signature);
  for (const secret of ['private-file-url', 'hidden-system-secret', 'inactive-branch-secret']) assert.ok(!value.includes(secret));
});

test('a new instance restores the saved directory and validates conversation, origin, schema and expiration', async () => {
  const local = storage(), now = 100000;
  await memory.create(model, local, () => now).save(input());
  const restored = await memory.create(model, local, () => now + 1000).load(origin, 'chat');
  assert.equal(restored.complete, true);
  assert.equal(restored.entries.length, 1);
  assert.equal(await memory.create(model, local, () => now).load(origin, 'other'), null);
  assert.equal(memory.decode(model, restored, 'https://chat.openai.com', 'chat', now), null);
  assert.equal(memory.decode(model, { ...restored, version: 99 }, origin, 'chat', now), null);
  assert.equal(await memory.create(model, local, () => now + memory.limits.TTL + 1).load(origin, 'chat'), null);
  assert.equal(Object.keys(local.data).length, 0, 'expired records are removed');
});

test('manual DOM indexes persist without inventing a conversation graph', () => {
  const value = input(); value.snapshot = null; value.entries[0].source = 'page';
  const restored = memory.decode(model, memory.encode(model, value, 1000), origin, 'chat', 2000);
  assert.equal(restored.snapshot, null);
  assert.equal(restored.complete, true);
  assert.equal(restored.entries[0].positionKnown, true);
});

test('eviction bounds saved conversations and leaves bookmarks untouched', async () => {
  const local = storage(); let now = 100000;
  local.data['question-bookmarks:chat'] = ['message:user-1'];
  const controller = memory.create(model, local, () => now++);
  for (let i = 0; i < memory.limits.MAX_CONVERSATIONS + 2; i++) await controller.save(input('chat-' + i));
  assert.equal(Object.keys(local.data).filter(key => key.startsWith('question-memory:')).length, memory.limits.MAX_CONVERSATIONS);
  assert.equal(await controller.load(origin, 'chat-0'), null);
  assert.ok(await controller.load(origin, 'chat-51'));
  assert.deepEqual(local.data['question-bookmarks:chat'], ['message:user-1']);
});

test('clear is serialized after pending writes, with independent per-conversation and all-memory deletion', async () => {
  const local = storage(), controller = memory.create(model, local);
  local.data['question-bookmarks:chat'] = ['message:user-1'];
  const first = controller.save(input('one')), second = controller.save(input('two'));
  await controller.clear(origin, 'one'); await first; await second;
  assert.equal(await controller.load(origin, 'one'), null);
  assert.ok(await controller.load(origin, 'two'));
  await controller.clearAll();
  assert.deepEqual(local.data, { 'question-bookmarks:chat': ['message:user-1'] });
});
