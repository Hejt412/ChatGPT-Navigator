// npm install --no-save playwright-core, then: node tests/content.browser.cjs
// EDGE_PATH / PLAYWRIGHT_MODULE may point to an existing local installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const hostSelector = '#chatgpt-right-rail-extension';
const classic = (text, index) => `<article data-testid="conversation-turn-${index}"><div data-message-author-role="user"><div class="whitespace-pre-wrap">${text}</div></div></article>`;
const modern = text => `<article data-turn="user"><div class="whitespace-pre-wrap">${text}</div></article>`;
// 真实页面上的新版结构：不再包含 role/user 或 conversation-turn 标记。
const searchUnit = (text, index, role = 'user') => `<div data-chatgpt-search-unit-key="fallback-turn-${index}:0:${role}"><div data-content-search-unit-key="fallback-turn-${index}:0:${role}"><div class="group/${role}-message"><div ${role === 'user' ? 'data-user-message-bubble="true"' : ''}>${text}</div></div><div><button aria-label="编辑消息"></button></div></div></div>`;
const fixture = messages => `<!doctype html><html><head><style>article { min-height: 360px; padding: 24px; } body { margin: 0; }</style></head><body><main>${messages}</main></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true
  });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture('') }));
    const marks = page.locator(`${hostSelector} .mark`);
    async function expectCount(count, preview = '') {
      await page.waitForFunction(({ expected, preview }) => {
        const root = document.getElementById('chatgpt-right-rail-extension')?.shadowRoot;
        return root?.querySelectorAll('.mark').length === expected && root.querySelector('.rail').hidden === (expected === 0) &&
          (!preview || root.querySelector('.mark')?.getAttribute('aria-label').includes(preview));
      }, { expected: count, preview });
    }
    async function load(messages) {
      await page.goto('https://chatgpt.com/c/old');
      await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, messages);
      await page.evaluate(source);
    }
    async function dashGeometry() {
      return page.locator(`${hostSelector} .dash`).evaluateAll(nodes => nodes.map(node => {
        const { left, right, width, height } = node.getBoundingClientRect();
        return { left, right, width, height };
      }));
    }
    async function expectStableDashes(expected) {
      const samples = await page.locator(`${hostSelector} .dash`).evaluateAll(async nodes => {
        const samples = [];
        for (let frame = 0; frame < 12; frame++) {
          await new Promise(requestAnimationFrame);
          samples.push(nodes.map(node => {
            const { left, right, width, height } = node.getBoundingClientRect();
            return { left, right, width, height };
          }));
        }
        return samples;
      });
      for (const sample of samples) assert.deepEqual(sample, expected, '横线在悬停、聚焦和高亮切换时应保持几何尺寸不变');
    }

    await load(classic('旧对话第一个问题', 0) + classic('旧对话第二个问题', 2));
    await expectCount(2);
    assert.equal(await marks.nth(0).getAttribute('aria-label'), '第 1 个问题：旧对话第一个问题');
    assert.equal(await marks.nth(0).evaluate(button => getComputedStyle(button).height), '17px');
    const stationaryDashes = await dashGeometry();
    await marks.nth(1).hover();
    await expectStableDashes(stationaryDashes);
    assert.ok((await page.locator(`${hostSelector} .tooltip`).innerText()).includes('旧对话第二个问题'));
    await page.evaluate(() => {
      Element.prototype.scrollIntoView = function (options) { window.lastJump = { text: this.textContent, options }; };
    });
    await marks.nth(1).click();
    assert.equal(await page.evaluate(() => window.lastJump.text), '旧对话第二个问题');
    await expectStableDashes(stationaryDashes);
    await page.mouse.move(30, 30);
    await marks.nth(1).evaluate(button => button.blur());
    await expectStableDashes(stationaryDashes);
    console.log('PASS: existing classic chat, visible rail, tooltip and click target');
    console.log('PASS: dash endpoints and thickness stay fixed across hover, focus, active changes and blur');

    await page.evaluate(source);
    assert.equal(await page.locator(hostSelector).count(), 1);
    await expectCount(2);
    console.log('PASS: reinjection refreshes without duplicate hosts');

    await page.locator(hostSelector).evaluate(host => host.remove());
    await expectCount(2);
    console.log('PASS: removed navigation is recreated with its entries');

    await page.evaluate(() => {
      history.pushState({}, '', '/');
      document.querySelector('main').replaceChildren();
    });
    await expectCount(0);
    await page.evaluate(html => {
      history.pushState({}, '', '/c/another-old-chat');
      document.querySelector('main').innerHTML = html;
    }, modern('另一个旧对话'));
    await expectCount(1);
    assert.ok((await marks.nth(0).getAttribute('aria-label')).includes('另一个旧对话'));
    console.log('PASS: SPA navigation clears empty chats and loads another old chat');

    await page.locator('main').evaluate(main => {
      main.innerHTML = '<article data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">嵌套用户标记</div></div></article><article data-turn="assistant"><div data-message-author-role="assistant">助手回复</div></article>';
    });
    await expectCount(1, '嵌套用户标记');
    assert.ok((await marks.nth(0).getAttribute('aria-label')).includes('嵌套用户标记'));
    await page.locator('main').evaluate(main => {
      main.insertAdjacentHTML('beforeend', '<article id="hydrated"><div class="whitespace-pre-wrap">延迟加载的问题</div></article>');
    });
    await page.locator('#hydrated').evaluate(node => node.setAttribute('data-turn', 'user'));
    await expectCount(2);
    console.log('PASS: modern user turns, nested deduplication, assistant exclusion and delayed attributes');

    await page.locator('#hydrated .whitespace-pre-wrap').evaluate(node => { node.firstChild.data = '编辑后的问题'; });
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark')[1].getAttribute('aria-label').includes('编辑后的问题'));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').dataset.dark === 'true');
    console.log('PASS: edited preview and dark theme');

    await load(searchUnit('真实新版结构的第一个问题', 0) + searchUnit('助手回复不能列为问题', 1, 'assistant') + searchUnit('真实新版结构的第二个问题', 2));
    await expectCount(2, '真实新版结构的第一个问题');
    assert.equal(await page.locator('[data-message-author-role], [data-author-role], [data-turn], [data-testid^="conversation-turn-"]').count(), 0);
    assert.equal(await marks.nth(1).getAttribute('aria-label'), '第 2 个问题：真实新版结构的第二个问题');
    await page.evaluate(() => {
      Element.prototype.scrollIntoView = function () { window.jumpUnit = this.getAttribute('data-chatgpt-search-unit-key'); };
    });
    await marks.nth(1).click();
    assert.equal(await page.evaluate(() => window.jumpUnit), 'fallback-turn-2:0:user');
    console.log('PASS: actual new page markers, three nested user markers deduplicated, assistant exclusion and jump');

    await page.locator('main').evaluate(main => { main.innerHTML = '<div id="new-bubble">异步显示的新版提问</div>'; });
    await expectCount(0);
    await page.locator('#new-bubble').evaluate(node => node.setAttribute('data-user-message-bubble', 'true'));
    await expectCount(1, '异步显示的新版提问');
    await page.locator('#new-bubble').evaluate(node => { node.firstChild.data = '修改后的新版提问'; });
    await expectCount(1, '修改后的新版提问');
    console.log('PASS: standalone new bubble marker, delayed attribute and edited preview');

    await page.evaluate(html => {
      history.pushState({}, '', '/c/new-structure-old-chat');
      document.querySelector('main').innerHTML = html;
    }, searchUnit('切换到另一个新版结构的旧对话', 0));
    await expectCount(1, '切换到另一个新版结构的旧对话');
    console.log('PASS: SPA navigation between chats using actual new page markers');

    await page.evaluate(() => {
      window.__chatgptRightRailLoaded.dispose();
      const host = document.getElementById('chatgpt-right-rail-extension');
      host.dataset.version = '1.0.1';
      host.shadowRoot.querySelector('nav').replaceChildren();
      host.shadowRoot.querySelector('nav').hidden = true;
      window.legacyHost = host;
      window.__chatgptRightRailLoaded = { refresh() { throw new Error('旧版本不应继续扫描'); } };
    });
    await page.evaluate(source);
    await expectCount(1, '切换到另一个新版结构的旧对话');
    assert.equal(await page.evaluate(() => document.getElementById('chatgpt-right-rail-extension') === window.legacyHost), true);
    assert.equal(await page.locator(hostSelector).getAttribute('data-version'), '1.0.3');
    console.log('PASS: upgrade replaces the legacy refresh handler and reuses its host');

    await load(classic('恢复已有导航 DOM', 0));
    await page.evaluate(() => { window.__chatgptRightRailLoaded = undefined; });
    await page.evaluate(source);
    assert.equal(await page.locator(hostSelector).count(), 1);
    await expectCount(1);
    console.log('PASS: orphan navigation from a previous extension context is replaced');
    assert.deepEqual(failures, []);
    console.log('PASS: no browser script errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
