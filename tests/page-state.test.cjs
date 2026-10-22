const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../conversation-model.js');
const reader = require('../page-state.js');

function data(id = 'chat') {
  return { conversationId: id, current_node: 'answer', mapping: new Map([
    ['question', { id: 'question', parent: null, children: ['answer'], message: {
      id: 'q', author: { role: 'user' }, content: { parts: ['完整状态里的问题'] }
    } }],
    ['answer', { id: 'answer', parent: 'question', children: [], message: {
      id: 'a', author: { role: 'assistant' }, content: { parts: ['配对回答'] }
    } }]
  ]) };
}
const doc = element => ({ querySelectorAll: () => [element], body: { children: [] } });

test('late injection reads the parent provider hook, class cache and Map without scrolling or requests', () => {
  class Cache { constructor() { this.queries = new Map([['active', { state: { data: data() } }]]); } }
  const provider = { memoizedState: { memoizedState: new Cache(), next: null } };
  const leaf = { return: provider, memoizedProps: { children: '仅有当前可视消息' } };
  const element = { '__reactFiber$test': leaf };
  const snapshot = reader.read(model, doc(element), 'chat');
  assert.equal(snapshot.complete, true);
  assert.deepEqual(model.entriesFromSnapshot(snapshot).map(item => [item.prompt, item.response]), [['完整状态里的问题', '配对回答']]);
});

test('reads root containers and context values, excludes other conversations and does not call getters', () => {
  let reads = 0;
  const context = { memoizedValue: { other: data('other'), active: data() }, next: null };
  const fiber = { dependencies: { firstContext: context } };
  fiber.return = fiber; fiber.child = fiber;
  const element = { '__reactContainer$test': { current: fiber } };
  Object.defineProperty(element, '__reactFiber$getter', { get() { reads++; throw new Error('getter'); } });
  Object.defineProperty(context.memoizedValue, 'nodeType', { get() { reads++; } });
  Object.defineProperty(context.memoizedValue, 'session', { get() { reads++; } });
  assert.equal(reader.read(model, doc(element), 'chat').conversationId, 'chat');
  assert.equal(reader.read(model, doc(element), 'missing'), null);
  assert.equal(reads, 0);
});

test('a snapshot requires its own conversation identity, never guesses from question-like DOM text', () => {
  const element = { '__reactProps$test': { mapping: data().mapping, children: '伪造问题' } };
  assert.equal(reader.read(model, doc(element), 'chat'), null);
});

test('ignores uncommitted React state and prefers complete data over a partial query result', () => {
  const partial = data(); partial.has_more = true;
  const pending = data(); pending.mapping.get('question').message.content.parts = ['尚未提交的错误问题'];
  const fiber = { memoizedProps: { data: [partial, data()] }, pendingProps: { data: pending },
    memoizedState: { baseState: pending, next: null } };
  const result = reader.read(model, doc({ '__reactFiber$test': fiber }), 'chat');
  assert.equal(result.complete, true);
  assert.equal(model.entriesFromSnapshot(result)[0].prompt, '完整状态里的问题');
});

test('binds a message graph to the explicit conversationId of its component without borrowing identities across caches', () => {
  const graph=data();delete graph.conversationId;
  const element={'__reactFiber$test':{memoizedProps:{conversationId:'chat',conversation:graph}}};
  assert.equal(reader.read(model,doc(element),'chat').complete,true);
  element['__reactFiber$test'].memoizedProps={conversationId:'other',conversation:graph};
  assert.equal(reader.read(model,doc(element),'chat'),null);
  element['__reactFiber$test'].memoizedProps={conversationId:'chat',conversation:data('other')};
  assert.equal(reader.read(model,doc(element),'chat'),null);
  element['__reactFiber$test'].memoizedProps={conversationId:'chat',cache:{conversation:graph}};
  assert.equal(reader.read(model,doc(element),'chat'),null);
});
