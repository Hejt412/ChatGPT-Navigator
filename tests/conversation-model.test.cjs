const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../conversation-model.js');

function conversation(id = 'sample') {
  const mapping = {};
  function add(nodeId, parent, role, text, extras = {}) {
    mapping[nodeId] = { id: nodeId, parent, children: [], message: {
      id: `message-${nodeId}`, author: { role }, content: { content_type: 'text', parts: [text] }, ...extras
    } };
    if (parent) mapping[parent].children.push(nodeId);
  }
  add('root', null, 'system', '不能显示的系统内容');
  add('q1', 'root', 'user', '同一个问题');
  add('a1', 'q1', 'assistant', '第一条回答');
  add('q2', 'a1', 'user', '继续');
  add('a2', 'q2', 'assistant', '当前分支的回答');
  add('other', 'a1', 'user', '其他分支的问题');
  add('other-answer', 'other', 'assistant', '其他分支的回答');
  return { id, current_node: 'a2', mapping };
}

test('indexes only the active branch and pairs each question with its response', () => {
  const snapshot = model.projectConversation(conversation(), 'sample');
  const entries = model.entriesFromSnapshot(snapshot);
  assert.deepEqual(entries.map(entry => entry.messageId), ['message-q1', 'message-q2']);
  assert.deepEqual(entries.map(entry => entry.response), ['第一条回答', '当前分支的回答']);
  assert.equal(snapshot.nodes.find(node => node.id === 'root').text, '');
});

test('visible real message IDs select another branch without merging branches', () => {
  const snapshot = model.projectConversation(conversation(), 'sample');
  const entries = model.entriesFromSnapshot(snapshot, ['message-q1', 'message-other']);
  assert.deepEqual(entries.map(entry => entry.messageId), ['message-q1', 'message-other']);
  assert.equal(entries[1].response, '其他分支的回答');
});

test('identical prompts retain distinct identities, attachments retain names without URLs', () => {
  const payload = conversation();
  payload.mapping.q2.message.content.parts = ['同一个问题', { content_type: 'image_asset_pointer', asset_pointer: 'private-image-url' }];
  payload.mapping.q2.message.metadata = { attachments: [{ name: '<script>.pdf', url: 'private-file-url', id: 'attachment-id' }] };
  const snapshot = model.projectConversation(payload, 'sample');
  const entries = model.entriesFromSnapshot(snapshot);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].key, entries[1].key);
  assert.equal(entries[0].signature, entries[1].signature);
  assert.deepEqual(entries[1].attachments.map(file => file.name), ['<script>.pdf', '图片']);
  assert.ok(!JSON.stringify(snapshot).includes('private-'));
});

test('hidden user context, analysis and tool-directed assistant messages are excluded', () => {
  const payload = conversation();
  payload.mapping.q1.message.content.content_type = 'user_editable_context';
  payload.mapping.a1.message.channel = 'analysis';
  payload.mapping.a2.message.recipient = 'python';
  const entries = model.entriesFromSnapshot(model.projectConversation(payload, 'sample'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].preview, '继续');
  assert.equal(entries[0].response, '');
});

test('rejects another conversation and malformed duplicate identities', () => {
  assert.equal(model.projectConversation(conversation('other'), 'sample'), null);
  const snapshot = model.projectConversation(conversation(), 'sample');
  snapshot.nodes.push({ ...snapshot.nodes[0] });
  assert.equal(model.normalizeSnapshot(snapshot, 'sample'), null);
});

test('bootstrap discovery skips credentials and accessors', () => {
  let accessed = false;
  const root = { props: { data: conversation() }, session: { accessToken: 'never-read' } };
  Object.defineProperty(root, 'secret', { get() { accessed = true; throw new Error('credential getter'); } });
  const snapshot = model.snapshotIn(root, 'sample');
  assert.equal(snapshot.conversationId, 'sample');
  assert.equal(accessed, false);
  assert.ok(!JSON.stringify(snapshot).includes('never-read'));
});

test('supports project conversation routes and bounds cyclic ancestry', () => {
  assert.equal(model.conversationId('https://chatgpt.com/g/project/c/abc-123?model=test'), 'abc-123');
  assert.equal(model.conversationId('https://chatgpt.com/'), null);
  const payload = conversation();
  payload.mapping.q1.parent = 'a2';
  assert.ok(model.entriesFromSnapshot(model.projectConversation(payload, 'sample')).length <= 2);
});

test('partial ancestry stays incomplete, older graph pages merge while preserving the latest active leaf', () => {
  const all=conversation();
  const last={id:'sample',current_node:'a2',mapping:{q2:all.mapping.q2,a2:all.mapping.a2}};
  const first={id:'sample',current_node:'a1',mapping:{root:all.mapping.root,q1:all.mapping.q1,a1:all.mapping.a1}};
  const partial=model.projectConversation(last,'sample');
  assert.equal(partial.complete,false);
  const merged=model.mergeSnapshots(partial,model.projectConversation(first,'sample'));
  assert.equal(merged.currentNode,'a2');assert.equal(merged.complete,true);
  assert.deepEqual(model.entriesFromSnapshot(merged).map(item=>item.messageId),['message-q1','message-q2']);
  all.current_node='other-answer';
  const switched=model.mergeSnapshots(merged,model.projectConversation(all,'sample'));
  assert.deepEqual(model.entriesFromSnapshot(switched).map(item=>item.messageId),['message-q1','message-other']);
});
