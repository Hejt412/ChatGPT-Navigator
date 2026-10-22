const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { conversation, fixture, cachedStateFixture } = require('./data.browser.cjs');
const { nativeFixture, historyPage } = require('./native-history.browser.cjs');
const project = path.resolve(__dirname, '..');
const outputs = path.join(project, 'test-results');
fs.mkdirSync(outputs, { recursive: true });
const profile = fs.mkdtempSync(path.join(outputs, 'extension-profile-'));

(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${project}`, `--load-extension=${project}`]
  });
  try {
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://chatgpt.com/**', route => {
      const url=new URL(route.request().url()),pathname = url.pathname;
      if(pathname==='/backend-api/conversation/extension-native') return route.fulfill({contentType:'application/json',body:JSON.stringify(historyPage('extension-native',Number(url.searchParams.get('before'))))});
      if (pathname.startsWith('/backend-api/conversation/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(conversation('extension')) });
      if(pathname.endsWith('/extension-native')) return route.fulfill({contentType:'text/html',body:nativeFixture('extension-native')});
      return route.fulfill({ contentType: 'text/html', body: pathname.endsWith('/extension-state') ? cachedStateFixture('extension-state') : fixture('extension') });
    });
    await page.goto('https://chatgpt.com/c/extension');
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.dataset.source === 'conversation', null, { timeout: 15000 });
    const marks = page.locator('#chatgpt-right-rail-extension .mark');
    assert.equal(await marks.count(), 40);
    await page.locator('#chatgpt-right-rail-extension .history-control').click({button:'right'});
    const diagnosticText=page.locator('#chatgpt-right-rail-extension .diagnostics pre');
    await page.waitForFunction(()=>{
      const text=document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.diagnostics pre')?.textContent;
      return text && JSON.parse(text).bridge.connected===true;
    });
    const diagnostic=JSON.parse(await diagnosticText.innerText());
    assert.equal(diagnostic.navigatorVersion,'2.5.1');
    assert.equal(diagnostic.indexedQuestions,40);
    assert.equal(diagnostic.bridge.bridgeVersion,'2.5.1');
    assert.ok(!JSON.stringify(diagnostic).includes('must-not-be-forwarded'));
    assert.ok(!JSON.stringify(diagnostic).includes('https://'));
    assert.ok(!JSON.stringify(diagnostic).includes('数据问题'));
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    console.log('PASS: diagnostic panel confirms both execution worlds and exports only counts and versions, no chat text, URL or credentials');
    await page.goto('https://chatgpt.com/c/extension-state');
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.dataset.source === 'conversation');
    assert.equal(await marks.count(), 40);
    assert.ok(await page.locator('[data-message-author-role=user]').count()<6);
    assert.equal(await page.evaluate(() => window.__chatgptRightRailLoaded), undefined, '导航控制器应留在扩展隔离上下文');
    assert.equal(await page.evaluate(() => window.chrome.storage), undefined, '网页不能访问扩展的本地书签存储');
    await marks.nth(10).hover();
    await page.locator('#chatgpt-right-rail-extension .tooltip').waitFor({ state: 'visible' });
    await page.locator('#chatgpt-right-rail-extension .bookmark-button').click();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark')[10].dataset.bookmarked === 'true');
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.waitForFunction?.(() => true);
    const saved = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(saved['question-bookmarks:extension-state'], ['message:user-10']);
    assert.ok(!JSON.stringify(saved['question-bookmarks:extension-state']).includes('第 11 个问题'));
    assert.ok(!JSON.stringify(saved).includes('must-not-be-forwarded'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark')[10]?.dataset.bookmarked === 'true');
    assert.equal(await marks.count(), 40);
    assert.deepEqual(errors, []);
    console.log('PASS: actual MV3 extension, MAIN/ISOLATED bridge, page cannot access storage, native chrome.storage bookmarks survive reload');
    await page.goto('https://chatgpt.com/c/extension-native');
    await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark').length===40&&document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').dataset.state==='complete',null,{timeout:15000});
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: packaged MV3 starts the native history observer at document_start and indexes all 40 questions without scrolling');
    const memoryKey = 'question-memory:v1:https://chatgpt.com:extension-native';
    const memoryDeadline = Date.now() + 5000;
    while (!(await worker.evaluate(async key => (await chrome.storage.local.get(key))[key]?.complete, memoryKey))) {
      if (Date.now() > memoryDeadline) throw new Error('navigation memory was not persisted');
      await page.waitForTimeout(50);
    }
    await page.reload();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.dataset.memory === 'restored');
    assert.equal(await marks.count(), 40);
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => window.nativeHistoryCalls), 0, '恢复完整目录后不能重新读取七页旧历史');
    assert.equal(await page.evaluate(() => window.chatScrollCommands), 0);
    await marks.nth(10).hover();
    await page.locator('#chatgpt-right-rail-extension .tooltip').waitFor({state:'visible'});
    assert.equal(await page.locator('#chatgpt-right-rail-extension .tooltip-text').innerText(), '继续');
    assert.ok((await page.locator('#chatgpt-right-rail-extension .tooltip-response').innerText()).includes('第 11 个问题'));
    assert.equal(await page.evaluate(() => window.__chatgptRailMemory), undefined, '记忆模块留在扩展隔离上下文');
    assert.deepEqual(errors, []);
    console.log('PASS: actual MV3 reload restores all 40 questions and previews from local memory with zero repeated history pages or body scrolls');

    const settings = await context.newPage();
    settings.on('pageerror', error => errors.push(error.message));
    const extensionOrigin = worker.url().slice(0, worker.url().lastIndexOf('/'));
    await settings.goto(extensionOrigin + '/settings.html');
    await settings.locator('#location').filter({hasText:'浏览器本地存储'}).waitFor();
    assert.equal(await settings.evaluate(()=>typeof window.showDirectoryPicker),'function');
    // 用真实 OPFS 目录句柄替代系统选择器，验证句柄跨页面 / 后台的 IndexedDB 序列化。
    // 真正 D 盘写入由 folder-storage.test.cjs 验证；真实浏览器授权留给用户点击系统窗口。
    await settings.evaluate(() => { window.showDirectoryPicker = () => navigator.storage.getDirectory(); });
    await settings.getByRole('button',{name:'选择保存文件夹',exact:true}).click();
    await settings.locator('#status').filter({hasText:'已切换到所选文件夹'}).waitFor();
    const diskRecords = () => settings.evaluate(async () => {
      const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('navigator-data'),result=[];
      for await(const entry of dir.values()) if(entry.kind==='file'&&entry.name.endsWith('.json')) {
        const record=JSON.parse(await(await entry.getFile()).text());result.push({name:entry.name,count:record.entries.length});
      }
      return result;
    });
    assert.equal((await diskRecords()).length,3);
    assert.ok((await diskRecords()).every(value=>value.count===40));
    const afterMigration=await worker.evaluate(()=>chrome.storage.local.get(null));
    assert.equal(Object.keys(afterMigration).filter(key=>key.startsWith('question-memory:')).length,0,'迁移后不在浏览器保留目录正文副本');
    assert.deepEqual(afterMigration['question-bookmarks:extension-state'],['message:user-10']);
    await settings.screenshot({path:path.join(outputs,'folder-settings-2.5.1.png'),fullPage:true});
    await page.bringToFront();
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension')?.dataset.memory==='restored');
    assert.equal(await marks.count(),40);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),0);
    await marks.nth(10).click();
    await page.waitForFunction(()=>{
      const root=document.getElementById('chatgpt-right-rail-extension').shadowRoot;
      return root.querySelector('[aria-current]')?.dataset.key==='message:user-10'&&root.querySelector('.history-control').dataset.state!=='seek';
    },null,{timeout:10000}).catch(async error=>{
      console.error('folder navigation state',await page.evaluate(()=>({
        active:document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.dataset.key,
        status:document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').title,
        scroll:document.getElementById('chat-scroll').scrollTop,
        live:[...document.querySelectorAll('[data-message-id]')].map(node=>node.dataset.messageId)
      })));throw error;
    });
    await page.waitForTimeout(700);
    assert.equal(Object.keys(await worker.evaluate(()=>chrome.storage.local.get(null))).filter(key=>key.startsWith('question-memory:')).length,0);
    console.log('PASS: settings migration serializes a real directory handle; content scripts restore and save through the service worker without browser copies');

    await settings.getByRole('button',{name:'使用浏览器存储',exact:true}).click();
    await settings.locator('#status').filter({hasText:'已切回浏览器存储'}).waitFor();
    assert.equal((await diskRecords()).length,3,'切回浏览器保留文件夹中的副本');
    assert.equal(Object.keys(await worker.evaluate(()=>chrome.storage.local.get(null))).filter(key=>key.startsWith('question-memory:')).length,3);
    await settings.getByRole('button',{name:'选择保存文件夹',exact:true}).click();
    await settings.locator('#status').filter({hasText:'已切换到所选文件夹'}).waitFor();
    await page.locator('#chatgpt-right-rail-extension .history-control').click({button:'right'});
    await page.getByRole('button',{name:'清除全部导航记忆',exact:true}).click();
    const clearedDeadline=Date.now()+5000;
    while((await diskRecords()).length){if(Date.now()>clearedDeadline)throw new Error('folder memory was not cleared');await page.waitForTimeout(50);}
    assert.deepEqual((await worker.evaluate(()=>chrome.storage.local.get(null)))['question-bookmarks:extension-state'],['message:user-10']);
    assert.deepEqual(errors,[]);
    console.log('PASS: settings can switch back, and clear-all removes only folder memory while preserving bookmarks');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
