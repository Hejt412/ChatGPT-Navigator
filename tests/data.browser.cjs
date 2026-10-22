// PLAYWRIGHT_MODULE / EDGE_PATH 可指向现有的 Playwright 和 Edge。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const project = path.join(__dirname, '..');
const modelSource = fs.readFileSync(path.join(project, 'conversation-model.js'), 'utf8');
const historySource = fs.readFileSync(path.join(project, 'history-loader.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(project, 'page-state.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(project, 'page-bridge.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(project, 'content.js'), 'utf8');
const host = '#chatgpt-right-rail-extension';
const storage = {};

function conversation(id, total = 40) {
  const mapping = { root: { id: 'root', parent: null, children: [] } };
  let parent = 'root';
  for (let i = 0; i < total; i++) {
    const user = `node-user-${i}`, answer = `node-answer-${i}`;
    const prompt = i === 0 ? '<img src=x onerror="window.previewXss=true"> 这是文字' : i === 10 || i === 20 ? '继续' : `数据问题 ${i + 1}`;
    mapping[parent].children.push(user);
    mapping[user] = { id: user, parent, children: [answer], message: { id: `user-${i}`, author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] }, metadata: i === 10 ? {
        attachments: [{ name: '实验结果.pdf', url: 'https://private.example/file' }]
      } : {} } };
    mapping[answer] = { id: answer, parent: user, children: [], message: { id: `answer-${i}`, author: { role: 'assistant' },
      content: { content_type: 'text', parts: [`第 ${i + 1} 个问题的回答预览。用消息身份配对，避免串到其他问题。`] } } };
    parent = answer;
  }
  mapping['node-answer-1'].children.push('alternative');
  mapping.alternative = { id: 'alternative', parent: 'node-answer-1', children: ['alternative-answer'], message: {
    id: 'alternative-user', author: { role: 'user' }, content: { content_type: 'text', parts: ['另一个分支的真实问题'] }
  } };
  mapping['alternative-answer'] = { id: 'alternative-answer', parent: 'alternative', children: [], message: {
    id: 'alternative-response', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['另一分支的回答'] }
  } };
  return { id, current_node: parent, mapping, access_token: 'must-not-be-forwarded' };
}

function fixture(id, bootstrap = false) {
  const payload = conversation(id);
  const rows = Object.values(payload.mapping).filter(node => node.message?.author.role === 'user' && node.id !== 'alternative').map(node => ({
    id: node.message.id, prompt: node.message.content.parts[0], response: payload.mapping[node.children[0]].message.content.parts[0]
  }));
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    body { margin:0; font-family:Arial,sans-serif; } main { position:fixed;top:65px;bottom:90px;width:100%; }
    #chat-scroll { height:100%;overflow-y:auto;overflow-anchor:none; } #space { position:relative; } #turns { position:absolute;width:100%; }
    article { height:360px; box-sizing:border-box;padding:0 220px 0 180px; } [data-message-author-role=user] { height:65px;box-sizing:border-box;padding:20px;background:#eef6ff; }
    .markdown { padding:20px;line-height:1.6; } #prompt { position:fixed;bottom:20px;left:180px;width:900px; }
  </style></head><body><main><div id="chat-scroll"><div id="space"><div id="turns"></div></div></div></main><textarea id="prompt" aria-label="消息输入框"></textarea><script>
    window.rows=${JSON.stringify(rows).replace(/</g, '\\u003c')};
    window.alternative=false;
    const scroll=document.getElementById('chat-scroll'),space=document.getElementById('space'),turns=document.getElementById('turns');
    window.renderRows=function(){
      const rows=window.alternative ? window.rows.slice(0,2).concat({id:'alternative-user',prompt:'另一个分支的真实问题',response:'另一分支的回答'}) : window.rows;
      space.style.height=rows.length*360+'px';
      const from=Math.max(0,Math.floor(scroll.scrollTop/360)-1),to=Math.min(rows.length,Math.ceil((scroll.scrollTop+scroll.clientHeight)/360)+1);
      turns.style.top=from*360+'px';turns.replaceChildren();
      for(let i=from;i<to;i++){
        const row=document.createElement('article');if(!rows[i].noIds)row.dataset.turnId='turn-'+i;
        const user=document.createElement('div');user.dataset.messageAuthorRole='user';if(!rows[i].noIds)user.dataset.messageId=rows[i].id;user.dataset.userMessageBubble='true';
        user.textContent=rows[i].prompt;
        const answer=document.createElement('div');answer.dataset.messageAuthorRole='assistant';
        const text=document.createElement('div');text.className='markdown';text.textContent=rows[i].response;answer.append(text);row.append(user,answer);turns.append(row);
      }
    };
    scroll.addEventListener('scroll',window.renderRows);window.renderRows();scroll.scrollTop=scroll.scrollHeight;window.renderRows();
    ${bootstrap ? `window.__NEXT_DATA__={props:{pageProps:{conversation:${JSON.stringify(payload).replace(/</g, '\\u003c')},session:{accessToken:'must-not-be-forwarded'}}}};` : `window.nativeLoad=fetch('/backend-api/conversation/${id}').then(response=>response.json()).then(value=>{window.nativeResult=value.id;});`}
  </script></body></html>`;
}

function cachedStateFixture(id, delay = 0) {
  return fixture(id, true).replace('</script>', `
    const cachedConversation=window.__NEXT_DATA__.props.pageProps.conversation;
    delete window.__NEXT_DATA__;
    class QueryState { constructor(){this.queries=new Map([['conversation',{state:{data:cachedConversation}}]]);} }
    setTimeout(()=>{
      const provider={memoizedState:{memoizedState:new QueryState(),next:null}};
      document.querySelector('main')['__reactFiber$fixture']={return:provider,memoizedProps:{children:'虚拟列表'}};
    },${delay});
  </script>`);
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const failures = [], requests = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('request', request => { if (request.url().includes('/backend-') || request.url().includes('/api/auth')) requests.push(request.url()); });
    await page.exposeBinding('testStorageGet', (_, key) => ({ [key]: storage[key] }));
    await page.exposeBinding('testStorageSet', (_, value) => { Object.assign(storage, value); });
    await page.addInitScript({ content: `window.chrome={storage:{local:{get:key=>window.testStorageGet(key),set:value=>window.testStorageSet(value)}}};window.receivedSnapshots=[];window.addEventListener('message',event=>{if(event.data?.type==='snapshot')window.receivedSnapshots.push(event.data);});${modelSource}\n${historySource}\n${stateSource}\n${bridgeSource}` });
    await page.route('https://chatgpt.com/**', route => {
      const url = new URL(route.request().url());
      const api = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
      if (api) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(conversation(api[1])) });
      const id = url.pathname.split('/').at(-1);
      return route.fulfill({ contentType: 'text/html', body: id === 'state' ? cachedStateFixture(id, 1500) : fixture(id, id === 'bootstrap') });
    });
    async function load(id) {
      await page.goto(`https://chatgpt.com/c/${id}`);
      if (id !== 'bootstrap') await page.evaluate(() => window.nativeLoad);
      await page.evaluate(contentSource);
      await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.dataset.source === 'conversation');
    }
    const marks = page.locator(`${host} .mark`);
    const tooltip = page.locator(`${host} .tooltip`);
    async function expectTarget(id) {
      await page.waitForFunction(id => {
        const bubble = document.querySelector(`[data-message-id="${id}"]`);
        const container = document.getElementById('chat-scroll').getBoundingClientRect();
        if (!bubble) return false;
        const rect = bubble.getBoundingClientRect();
        const active = document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]');
        return rect.top >= container.top && rect.bottom <= container.bottom && active?.dataset.key === 'message:'+id;
      }, id, { timeout: 10000 });
    }

    await load('model');
    assert.equal(await marks.count(), 40);
    assert.ok(await page.locator('[data-message-author-role=user]').count() < 6);
    assert.equal(await page.evaluate(() => window.nativeResult), 'model', '网页仍可正常消费原始响应');
    const readingPosition = await page.locator('#chat-scroll').evaluate(node => node.scrollTop);
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), readingPosition, '完整数据索引不应自动滚动聊天');
    assert.equal(requests.length, 1, '扩展不能主动请求历史或登录令牌');
    assert.equal(await page.evaluate(() => JSON.stringify(window.receivedSnapshots).includes('must-not-be-forwarded')), false);
    console.log('PASS: 40-question data index from native response, no auto scroll, no extra requests, no credentials forwarded');

    await marks.nth(10).hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await page.locator(`${host} .tooltip-text`).innerText(), '继续');
    assert.ok((await page.locator(`${host} .tooltip-response`).innerText()).includes('第 11 个问题'));
    assert.equal(await page.locator(`${host} .attachment`).innerText(), '📎 实验结果.pdf');
    await page.locator(`${host} .bookmark-button`).click();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark')[10].dataset.bookmarked === 'true');
    assert.deepEqual(storage['question-bookmarks:model'], ['message:user-10']);
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), readingPosition, '收藏不能触发跳转');
    await marks.nth(0).hover();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.tooltip-text').textContent.includes('<img'));
    assert.equal(await page.locator(`${host} .tooltip img`).count(), 0);
    assert.equal(await page.evaluate(() => window.previewXss === true), false);
    console.log('PASS: question/response pairing, attachments, bookmark persistence, preview content rendered as plain text');

    for (const index of [0, 39, 10, 20]) {
      await marks.nth(index).click();
      await expectTarget(`user-${index}`);
      assert.equal(await marks.count(), 40);
    }
    await page.keyboard.press('Alt+ArrowUp');
    await expectTarget('user-19');
    await page.keyboard.press('Alt+ArrowDown');
    await expectTarget('user-20');
    const first = await marks.nth(20).boundingBox(), last = await marks.nth(22).boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 5 });
    await page.mouse.up();
    await expectTarget('user-22');
    console.log('PASS: unloaded data targets, identical prompts, Alt+Up/Down, pointer scrubbing');

    await page.evaluate(() => {
      window.rows.push({ noIds: true, prompt: '尚未进入对话响应的新问题', response: '新问题正在生成的回答' });
      window.renderRows(); const scroll=document.getElementById('chat-scroll');scroll.scrollTop=scroll.scrollHeight;window.renderRows();
    });
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark').length === 41);
    const liveKey = await marks.nth(40).getAttribute('data-key');
    await marks.nth(40).click();
    await page.waitForFunction(key => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.dataset.key === key, liveKey, {timeout:5000}).catch(async error => {
      console.error('Live navigation failure', liveKey, await page.evaluate(() => {
        const root=document.getElementById('chatgpt-right-rail-extension').shadowRoot;
        return {last:root.querySelector('.mark:last-child')?.dataset.key,active:root.querySelector('[aria-current]')?.dataset.key,status:root.querySelector('.history-control').getAttribute('aria-label'),scroll:document.getElementById('chat-scroll').scrollTop};
      })); throw error;
    });
    assert.equal(await marks.nth(40).getAttribute('data-key'), liveKey);
    await marks.nth(40).hover();
    await tooltip.waitFor({state:'visible'});
    await page.locator('[data-message-author-role=assistant] .markdown').last().evaluate(node => { node.firstChild.data='已完成的新回答'; });
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.tooltip-response').textContent.includes('已完成的新回答'));
    await marks.nth(20).click();
    await expectTarget('user-20');
    assert.equal(await marks.count(), 41, '新消息卸载后仍应保留在当前分支的目录中');
    await marks.nth(40).click();
    await page.waitForFunction(key => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.dataset.key === key, liveKey);
    await page.evaluate(() => { window.rows.pop();window.renderRows(); });
    console.log('PASS: newly sent prompts without IDs keep stable navigation and refresh their streaming preview');

    await page.evaluate(() => { window.alternative = true; const scroll = document.getElementById('chat-scroll'); scroll.scrollTop = 0; window.renderRows(); });
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark').length === 3);
    assert.ok((await marks.nth(2).getAttribute('aria-label')).includes('另一个分支的真实问题'));
    assert.equal(await marks.locator('[data-key="message:user-39"]').count(), 0);
    await page.locator('[data-message-id]').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('data-message-id')));
    await page.evaluate(() => window.__chatgptRightRailLoaded.refresh());
    assert.equal(await marks.count(), 3);
    console.log('PASS: branch switching rebuilds the authoritative index without stale branch questions');

    await load('other');
    assert.equal(await marks.nth(10).getAttribute('data-bookmarked'), 'false');
    await load('model');
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark')[10].dataset.bookmarked === 'true');
    assert.deepEqual(Object.keys(storage), ['question-bookmarks:model']);
    await page.evaluate(() => window.postMessage({ channel: 'chatgpt-navigator-v2', type: 'snapshot', nonce: 'invalid-session-nonce', snapshot: {
      conversationId: 'model', currentNode: 'ghost', complete: true, nodes: [{ id: 'ghost', role: 'user', text: '伪造条目' }]
    } }, location.origin));
    await page.waitForTimeout(100);
    assert.equal(await marks.count(), 40);
    console.log('PASS: bookmarks remain scoped per conversation and stale/mismatched messages are rejected');

    const beforeBootstrap = requests.length;
    await load('bootstrap');
    assert.equal(await marks.count(), 40);
    assert.equal(requests.length, beforeBootstrap);
    assert.ok((await marks.nth(1).getAttribute('aria-label')).includes('数据问题 2'));
    await marks.nth(10).hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await page.locator(`${host} .tooltip-text`).innerText(), '继续');
    const beforeState = requests.length;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('https://chatgpt.com/c/state');
    const statePosition = await page.locator('#chat-scroll').evaluate(node => {
      window.indexingScrollEvents=0;node.addEventListener('scroll',()=>window.indexingScrollEvents++);return node.scrollTop;
    });
    // 数据请求早已结束、React 状态又延后挂载：仍应在原阅读位置发现完整目录。
    await page.evaluate(contentSource);
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.dataset.source === 'conversation');
    assert.equal(await marks.count(), 40);
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), statePosition);
    assert.equal(await page.evaluate(() => window.indexingScrollEvents), 0);
    assert.equal(requests.length, beforeState);
    await marks.nth(10).hover();
    await tooltip.waitFor({ state: 'visible' });
    await page.waitForTimeout(220);
    const widths=await page.locator(`${host} .dash`).evaluateAll(nodes=>nodes.slice(10,15).map(node=>node.getBoundingClientRect().width));
    for(let i=0;i<widths.length;i++) assert.ok(Math.abs(widths[i]-[26,20,14,10,6][i])<.2, '悬停及相邻三条横线按距离展开');
    await marks.nth(11).hover();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.tooltip-text').textContent==='数据问题 12');
    await page.waitForTimeout(200);
    assert.ok(await tooltip.isVisible());
    fs.mkdirSync(path.join(project, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'test-results', 'navigator-2.3.0.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator(`${host} .dash`).first().evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.deepEqual(failures, []);
    console.log('PASS: delayed React cache yields all 40 entries with zero indexing scrolls and zero requests; Codex-style hover wave, follow preview, reduced motion');
    console.log('PASS: bootstrap fallback, no browser errors; preview saved to test-results/navigator-2.3.0.png');
  } finally { await browser.close(); }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { conversation, fixture, cachedStateFixture };
