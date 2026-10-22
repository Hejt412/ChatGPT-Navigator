const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../conversation-model.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'page-bridge.js'), 'utf8');
const payload = text => ({ id: 'chat', current_node: 'user', mapping: {
  user: { id: 'user', parent: null, children: [], message: { id: 'user-id', author: { role: 'user' }, content: { parts: [text] } } }
} });
const response = text => new Response(JSON.stringify(payload(text)), { headers: { 'content-type': 'application/json' } });

function setup() {
  const pending = [], messages = [], listeners = new Set();
  class PageResponse extends Response { json(...args) { return super.json(...args); } }
  class PageXHR extends EventTarget {
    open(method,url) { this.method=method;this.url=url; }
    getResponseHeader() { return 'application/json'; }
    finish(value,type='json') { this.status=200;this.responseType=type;this.response=value;this.responseText=JSON.stringify(value);this.dispatchEvent(new Event('load')); }
  }
  const window = { __chatgptRailModel: model, location: { href: 'https://chatgpt.com/c/chat', origin: 'https://chatgpt.com' },
    Response:PageResponse,XMLHttpRequest:PageXHR,
    fetch: function (...args) { return new Promise(resolve => pending.push({ resolve, args, receiver: this })); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    postMessage(message, origin) { messages.push({ message, origin }); }
  };
  const original = window.fetch;
  vm.runInNewContext(source, { window, location: window.location, document: { getElementById: () => null }, URL });
  const request = () => [...listeners].forEach(fn => fn({ source: window, origin: window.location.origin,
    data: { channel: 'chatgpt-navigator-v2', type: 'request', nonce: 'valid-session-12345678', conversationId: 'chat' } }));
  return { window, original, pending, messages, listeners, request };
}
async function waitFor(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('bridge condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('captures a pre-handshake response without changing its consumer, then serves cached data', async () => {
  const app = setup();
  const promise = app.window.fetch('/backend-api/conversation/chat');
  const originalResponse = response('实际问题');
  app.pending[0].resolve(originalResponse);
  assert.equal(await promise, originalResponse);
  assert.equal((await originalResponse.json()).id, 'chat');
  await new Promise(resolve => setTimeout(resolve, 30));
  app.request();
  await waitFor(() => app.messages.length === 1);
  assert.equal(app.messages[0].message.snapshot.nodes[0].text, '实际问题');
  assert.equal(app.messages[0].origin, 'https://chatgpt.com');
  assert.equal(app.pending[0].receiver, app.window);
  assert.equal(app.pending.length, 1);
});

test('observes JSON consumed through a fetch reference saved before injection, without issuing a replacement request', async () => {
  const app=setup();app.request();
  const promise=app.original.call(app.window,'/backend-api/conversation/chat');
  const result=new app.window.Response(JSON.stringify(payload('缓存 fetch 的问题')), {headers:{'content-type':'application/json'}});
  Object.defineProperty(result,'url',{value:'https://chatgpt.com/backend-api/conversation/chat'});
  app.pending[0].resolve(result);
  assert.equal((await (await promise).json()).id,'chat');
  await waitFor(()=>app.messages.length===1);
  assert.equal(app.messages[0].message.snapshot.nodes[0].text,'缓存 fetch 的问题');
  assert.equal(app.pending.length,1);
});

test('observes native XHR JSON/text and uses the exact current GET URL to bind an id-less graph', async () => {
  const app=setup();app.request();
  for(const type of ['json','text']) {
    const xhr=new app.window.XMLHttpRequest();xhr.open('GET','/backend-api/conversation/chat?before=5');
    const graph=payload('XHR-'+type);delete graph.id;xhr.finish(graph,type);
  }
  assert.equal(app.messages.length,2);
  assert.equal(app.messages.at(-1).message.snapshot.nodes[0].text,'XHR-text');
  const xhr=new app.window.XMLHttpRequest();xhr.open('POST','/backend-api/conversation/chat');xhr.finish(payload('不能读取'));
  assert.equal(app.messages.length,2);
  app.window.__chatgptRailBridge.dispose();
  const after=new app.window.XMLHttpRequest();after.open('GET','/backend-api/conversation/chat');after.finish(payload('已退出'));
  assert.equal(app.messages.length,2);
});

test('a late old response cannot overwrite a newer conversation snapshot', async () => {
  const app = setup();
  app.request();
  const first = app.window.fetch('/backend-api/conversation/chat');
  const second = app.window.fetch('/backend-api/conversation/chat');
  app.pending[1].resolve(response('较新问题'));
  await second;
  await waitFor(() => app.messages.length === 1);
  app.pending[0].resolve(response('过时问题'));
  await first;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].message.snapshot.nodes[0].text, '较新问题');
});

test('ignores other conversations, foreign origins, POST responses and route changes', async () => {
  const app = setup();
  app.request();
  for (const [url, options] of [
    ['/backend-api/conversation/other', {}], ['https://example.com/backend-api/conversation/chat', {}],
    ['/backend-api/conversation/chat', { method: 'POST' }], ['/api/auth/session', {}]
  ]) {
    const promise = app.window.fetch(url, options);
    app.pending.at(-1).resolve(response('不应读取'));
    await promise;
  }
  const late = app.window.fetch('/backend-api/conversation/chat');
  app.window.location.href = 'https://chatgpt.com/c/other';
  app.pending.at(-1).resolve(response('原对话的延迟响应'));
  await late;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.messages.length, 0);
});

test('reinjection is idempotent and disposal restores only the wrapper it owns', () => {
  const app = setup();
  const wrapped = app.window.fetch;
  vm.runInNewContext(source, { window: app.window });
  assert.equal(app.window.fetch, wrapped);
  assert.equal(app.listeners.size, 1);
  app.window.__chatgptRailBridge.dispose();
  assert.equal(app.window.fetch, app.original);
  assert.equal(app.listeners.size, 0);
});

test('diagnostics disclose only sanitized counters and do not start history loading or requests', () => {
  const app=setup();let started=0;
  app.window.__chatgptRailHistory={start(){started++;},diagnostics(){return{pagesTriggered:0,running:false};}};
  [...app.listeners].forEach(fn=>fn({source:app.window,origin:app.window.location.origin,data:{
    channel:'chatgpt-navigator-v2',type:'diagnose',nonce:'valid-session-12345678',conversationId:'chat'
  }}));
  assert.equal(started,0);
  assert.equal(app.pending.length,0);
  assert.equal(app.messages[0].message.type,'diagnostics');
  assert.equal(app.messages[0].message.diagnostics.bridgeVersion,'2.4.0');
  assert.equal(app.messages[0].message.diagnostics.history.pagesTriggered,0);
});

test('native navigation validates the current user message and acknowledges only after the native action completes', async () => {
  const app=setup();
  const pending=app.window.fetch('/backend-api/conversation/chat');
  app.pending[0].resolve(response('实际问题'));await pending;
  await new Promise(resolve=>setTimeout(resolve,30));app.request();
  const calls=[];let finish;
  const owner={scrollToMessage(id){calls.push({id,owner:this});return new Promise(resolve=>{finish=resolve;});}};
  app.window.__chatgptRailPageState={controls:()=>({navigator:{owner,call:owner.scrollToMessage}})};
  const send=messageId=>[...app.listeners].forEach(fn=>fn({source:app.window,origin:app.window.location.origin,data:{
    channel:'chatgpt-navigator-v2',type:'navigate',nonce:'valid-session-12345678',conversationId:'chat',
    messageId,requestId:'native-request-12345678'
  }}));
  send('unknown-user');assert.equal(calls.length,0);
  send('user-id');assert.equal(calls.length,1);assert.equal(calls[0].owner,owner);
  assert.equal(app.messages.filter(item=>item.message.type==='navigation').length,0);
  finish();await waitFor(()=>app.messages.some(item=>item.message.type==='navigation'));
  assert.equal(app.messages.at(-1).message.handled,true);
  assert.equal(app.messages.at(-1).message.requestId,'native-request-12345678');
});

test('a previously complete response does not hide newly committed page data when revalidating a restored directory', async () => {
  const app=setup();
  const pending=app.window.fetch('/backend-api/conversation/chat');app.pending[0].resolve(response('旧问题'));await pending;
  await new Promise(resolve=>setTimeout(resolve,30));app.request();
  app.window.__NEXT_DATA__={conversation:payload('过时的初始化内容')};app.request();
  assert.equal(app.messages.at(-1).message.snapshot.nodes[0].text,'旧问题');
  app.window.__chatgptRailPageState={read:()=>model.projectConversation(payload('已编辑的问题'),'chat')};
  app.request();
  assert.equal(app.messages.at(-1).message.snapshot.nodes[0].text,'已编辑的问题');
  assert.equal(app.pending.length,1,'核对已有页面状态不应增加网络请求');
});
