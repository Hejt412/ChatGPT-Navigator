const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { fixture, conversation } = require('./data.browser.cjs');
const model = require('../conversation-model.js');
const memory = require('../navigation-memory.js');
const project = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(project, file), 'utf8');
const origin = 'https://chatgpt.com', host = '#chatgpt-right-rail-extension';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const storage = {}, errors = [];
    let mode = 'full', rejectWrites = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeBinding('memoryGet', (_, key) => structuredClone(key === null ? storage : { [key]: storage[key] }));
    await page.exposeBinding('memorySet', (_, values) => { if (rejectWrites) throw new Error('storage unavailable'); Object.assign(storage, structuredClone(values)); });
    await page.exposeBinding('memoryRemove', (_, keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; });
    await page.addInitScript({ content: `window.chrome={storage:{local:{get:key=>window.memoryGet(key),set:value=>window.memorySet(value),remove:keys=>window.memoryRemove(keys)}}};` +
      ['conversation-model.js', 'history-loader.js', 'page-state.js', 'page-bridge.js'].map(source).join('\n') });
    await page.route(origin + '/**', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      const extra = mode === 'partial' ? `const graph=window.__NEXT_DATA__.props.pageProps.conversation;graph.mapping=Object.fromEntries(Object.entries(graph.mapping).filter(([id])=>/node-(?:user|answer)-(3[5-9])$/.test(id)));graph.has_more=true;`
        : mode === 'none' ? 'delete window.__NEXT_DATA__;'
        : mode === 'branch' ? `window.__NEXT_DATA__.props.pageProps.conversation.current_node='alternative-answer';window.alternative=true;window.renderRows();scroll.scrollTop=scroll.scrollHeight;window.renderRows();` : '';
      return route.fulfill({ contentType: 'text/html', body: fixture(id, true).replace('</script>', extra + '</script>') });
    });
    const marks = page.locator(host + ' .mark'), control = page.locator(host + ' .history-control');
    async function load(id, nextMode) {
      mode = nextMode;
      await page.goto(origin + '/c/' + id);
      await page.evaluate(source('navigation-memory.js') + '\n' + source('content.js'));
    }
    async function count(value) {
      await page.waitForFunction(value => document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark').length === value, value, {timeout:8000}).catch(async error => {
        console.error('Memory browser state', await page.evaluate(() => ({
          count:document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark').length,
          source:document.getElementById('chatgpt-right-rail-extension')?.dataset.source,
          cache:document.getElementById('chatgpt-right-rail-extension')?.dataset.memory,
          graph:window.__NEXT_DATA__?.props?.pageProps?.conversation?.current_node,
          installed:!!window.__chatgptRailMemory,
          chrome:typeof window.chrome?.storage?.local?.remove
        })), {keys:Object.keys(storage),errors}); throw error;
      });
    }
    async function saved(id, total) {
      const deadline = Date.now() + 5000;
      while (storage[memory.scopeKey(origin, id)]?.entries.length !== total) {
        if (Date.now() > deadline) throw new Error('memory did not persist ' + id + ': ' + total);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    await load('remembered', 'full'); await count(40); await saved('remembered', 40);
    assert.equal(storage[memory.scopeKey(origin, 'remembered')].complete, true);
    assert.ok(!JSON.stringify(storage).includes('must-not-be-forwarded'));
    mode = 'partial'; await page.reload();
    await page.evaluate(source('navigation-memory.js') + '\n' + source('content.js'));
    await count(40);
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').dataset.memory === 'restored');
    await page.waitForTimeout(1100);
    assert.equal(await marks.count(), 40, '只含最后五条的网页状态不能覆盖完整目录');
    const reading = await page.locator('#chat-scroll').evaluate(node => node.scrollTop);
    await marks.nth(10).hover();
    await page.locator(host + ' .tooltip').waitFor({state:'visible'});
    assert.equal(await page.locator(host + ' .tooltip-text').innerText(), '继续');
    assert.ok((await page.locator(host + ' .tooltip-response').innerText()).includes('第 11 个问题'));
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), reading);
    console.log('PASS: full question index and previews survive reload; a partial tail cannot shrink the restored directory or move the reading position');

    const expanded = conversation('remembered', 41);
    await page.evaluate(graph => {
      window.__NEXT_DATA__.props.pageProps.conversation = graph;
      window.rows.push({id:'user-40',prompt:'数据问题 41',response:'新增回答'});
      window.renderRows();
    }, expanded);
    await control.click(); await count(41); await saved('remembered', 41);
    await load('remembered', 'branch'); await count(3); await saved('remembered', 3);
    assert.ok((await marks.last().getAttribute('aria-label')).includes('另一个分支的真实问题'));
    console.log('PASS: new messages update memory and an authoritative branch change removes the previous branch suffix');

    const graph = model.projectConversation(conversation('manual'), 'manual');
    storage[memory.scopeKey(origin, 'manual')] = memory.encode(model, { origin, id:'manual', snapshot:null,
      entries:model.entriesFromSnapshot(graph).map(item => ({...item,source:'page',position:item.ordinal*360,positionKnown:true})), complete:true });
    await load('manual', 'partial'); await count(40); await page.waitForTimeout(1000); await count(40);
    await marks.nth(10).click();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.getAttribute('aria-label').includes('第 11 个'));
    console.log('PASS: a manually collected index also survives a reload and partial native data, with unloaded targets still navigable');

    storage['question-bookmarks:manual'] = ['message:user-10'];
    await control.click({button:'right'});
    await page.getByRole('button',{name:'清除此对话记忆',exact:true}).click();
    await page.waitForTimeout(1000);
    assert.equal(storage[memory.scopeKey(origin, 'manual')], undefined);
    assert.equal(await marks.count(), 40);
    await page.getByRole('button',{name:'恢复保存记忆',exact:true}).click(); await saved('manual',40);
    await page.getByRole('button',{name:'清除全部导航记忆',exact:true}).click();
    await page.waitForTimeout(800);
    assert.equal(Object.keys(storage).filter(key=>key.startsWith('question-memory:')).length,0);
    assert.deepEqual(storage['question-bookmarks:manual'],['message:user-10']);
    console.log('PASS: clear-current, resume and clear-all work without deleting bookmarks or immediately recreating cleared memory');

    rejectWrites = true;
    await load('write-failure', 'full'); await count(40); await page.waitForTimeout(1100);
    assert.equal(await marks.count(),40);
    assert.equal(storage[memory.scopeKey(origin, 'write-failure')],undefined);
    assert.deepEqual(errors,[]);
    console.log('PASS: storage failure leaves live navigation usable without page script errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
