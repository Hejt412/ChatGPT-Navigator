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
const fixture = messages => `<!doctype html><html><head><meta charset="UTF-8"><style>article { min-height: 360px; padding: 24px; } body { margin: 0; }</style></head><body><main>${messages}</main></body></html>`;

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
      for (const sample of samples) for (let i = 0; i < sample.length; i++) {
        assert.equal(sample[i].right, expected[i].right, '动效应固定右端点，不移动点击区域');
        assert.equal(sample[i].height, 2);
        assert.ok(sample[i].width >= 5.9 && sample[i].width < 27);
      }
    }

    await load(classic('旧对话第一个问题', 0) + classic('旧对话第二个问题', 2));
    await expectCount(2);
    assert.equal(await marks.nth(0).getAttribute('aria-label'), '第 1 个问题：旧对话第一个问题');
    assert.equal(await marks.nth(0).evaluate(button => getComputedStyle(button).height), '10px');
    const stationaryDashes = await dashGeometry();
    await marks.nth(1).hover();
    await expectStableDashes(stationaryDashes);
    await page.waitForFunction(() => {
      const nodes=document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.dash');
      return nodes[1].getBoundingClientRect().width>25 && nodes[0].getBoundingClientRect().width>19;
    });
    const expandedDashes = await dashGeometry();
    assert.ok(expandedDashes[1].width > 25 && expandedDashes[0].width > 19);
    await page.locator(`${hostSelector} .tooltip`).waitFor({ state: 'visible' });
    assert.ok((await page.locator(`${hostSelector} .tooltip`).innerText()).includes('旧对话第二个问题'));
    await marks.nth(1).click();
    assert.equal(await marks.nth(1).getAttribute('aria-current'), 'location');
    await expectStableDashes(stationaryDashes);
    await page.mouse.move(30, 30);
    await marks.nth(1).evaluate(button => button.blur());
    await expectStableDashes(stationaryDashes);
    console.log('PASS: existing classic chat, visible rail, tooltip and click target');
    console.log('PASS: Codex-style expanding dash and neighboring dash preserve right anchor and 2px thickness');

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
    await marks.nth(1).click();
    assert.equal(await marks.nth(1).getAttribute('aria-current'), 'location');
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
    assert.equal(await page.locator(hostSelector).getAttribute('data-version'), '2.2.1');
    console.log('PASS: upgrade replaces the legacy refresh handler and reuses its host');

    await load(classic('恢复已有导航 DOM', 0));
    await page.evaluate(() => { window.__chatgptRightRailLoaded = undefined; });
    await page.evaluate(source);
    assert.equal(await page.locator(hostSelector).count(), 1);
    await expectCount(1);
    console.log('PASS: orphan navigation from a previous extension context is replaced');

    // 必须验证真实滚动：display: contents 搜索单元没有布局盒，
    // 对它调用 scrollIntoView 不会移动聊天，即使点击回调已经执行。
    async function expectRealScroll(wrapperDisplay, reducedMotion) {
      await page.emulateMedia({ reducedMotion });
      const messages = Array.from({ length: 3 }, (_, index) =>
        searchUnit(`实际滚动问题 ${index + 1}`, index) + '<section class="answer">很长的助手回复</section>'
      ).join('');
      await load(`<style>
        html, body { height: 100%; overflow: hidden; }
        main { position: fixed; top: 80px; bottom: 100px; width: 100%; }
        #chat-scroll { height: 100%; overflow-y: auto; }
        [data-chatgpt-search-unit-key], [data-content-search-unit-key] { display: ${wrapperDisplay}; }
        [data-user-message-bubble] { padding: 20px; margin: 12px; }
        .answer { height: 1000px; }
      </style><div id="chat-scroll"><div>${messages}</div></div>`);
      await expectCount(3);
      const scroller = page.locator('#chat-scroll');
      await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
      async function expectVisible(index) {
        await page.waitForFunction(index => {
          const scroller = document.getElementById('chat-scroll');
          const bubble = scroller.querySelectorAll('[data-user-message-bubble]')[index];
          const rect = bubble.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          const current = document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelectorAll('.mark')[index];
          return rect.top >= viewport.top && rect.bottom <= viewport.bottom &&
            current.getAttribute('aria-current') === 'location';
        }, index, { timeout: 4000 });
      }
      for (const index of [0, 2, 1, 0]) {
        await marks.nth(index).click();
        await expectVisible(index);
      }
      assert.equal(await page.evaluate(() => window.scrollY), 0, '只应滚动聊天容器');
      assert.ok(await scroller.evaluate(node => node.scrollTop < 100), '首条问题应回到聊天顶部');
      console.log(`PASS: real nested scrolling, ${wrapperDisplay} wrappers, ${reducedMotion} motion, correct active mark`);
    }
    await expectRealScroll('contents', 'reduce');
    await expectRealScroll('contents', 'no-preference');
    await expectRealScroll('block', 'no-preference');

    const historyControl = page.locator(`${hostSelector} .history-control`);
    const scrollStyles = `<style>
      html, body { height: 100%; overflow: hidden; }
      main { position: fixed; top: 80px; bottom: 100px; width: 100%; }
      #chat-scroll { height: 100%; overflow-y: auto; overflow-anchor: none; }
      [data-chatgpt-search-unit-key], [data-content-search-unit-key] { display: contents; }
      [data-user-message-bubble] { height: 60px; padding: 20px; }
      .virtual-row { height: 360px; }
      #chat-space { position: relative; }
      #chat-window { position: absolute; width: 100%; }
    </style>`;
    async function loadVirtualChat(total, recycle = false) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await load(`${scrollStyles}<div id="chat-scroll"><div id="chat-space"><div id="chat-window"></div></div></div>`);
      const messages = Array.from({ length: total }, (_, index) =>
        `<div class="virtual-row">${searchUnit(index === 10 || index === 30 ? '继续' : `历史问题 ${index + 1}`, index)}</div>`);
      await page.evaluate(({ messages, recycle }) => {
        const container = document.getElementById('chat-scroll');
        const space = document.getElementById('chat-space');
        const windowNode = document.getElementById('chat-window');
        space.style.height = `${messages.length * 360}px`;
        function render() {
          const from = Math.max(0, Math.floor(container.scrollTop / 360) - 1);
          const to = Math.min(messages.length, Math.ceil((container.scrollTop + container.clientHeight) / 360) + 1);
          windowNode.style.top = `${from * 360}px`;
          if (!recycle) windowNode.innerHTML = messages.slice(from, to).join('');
          else {
            if (!windowNode.children.length) windowNode.innerHTML = messages.slice(0, 6).join('');
            [...windowNode.children].forEach((row, offset) => {
              const index = from + offset;
              row.hidden = index >= messages.length;
              row.querySelector('[data-chatgpt-search-unit-key]').setAttribute('data-chatgpt-search-unit-key', `fallback-turn-${index}:0:user`);
              row.querySelector('[data-content-search-unit-key]').setAttribute('data-content-search-unit-key', `fallback-turn-${index}:0:user`);
              const bubble = row.querySelector('[data-user-message-bubble]');
              bubble.dataset.messageId = `stable-message-${index}`;
              bubble.textContent = index === 10 || index === 30 ? '继续' : `历史问题 ${index + 1}`;
            });
            windowNode.style.marginTop = window.shiftFirstTarget && from === 0 ? '180px' : '0px';
          }
        }
        container.addEventListener('scroll', render);
        container.scrollTop = container.scrollHeight;
        render();
        window.__chatgptRightRailLoaded.refresh();
      }, { messages, recycle });
    }
    async function expectHistoryComplete(total) {
      if (await historyControl.getAttribute('data-state') === 'idle') await historyControl.click();
      await page.waitForFunction(total => {
        const root = document.getElementById('chatgpt-right-rail-extension').shadowRoot;
        return root.querySelectorAll('.mark').length === total && root.querySelector('.history-control').dataset.state === 'complete';
      }, total, { timeout: 25000 });
    }
    async function expectVirtualQuestion(index) {
      await page.waitForFunction(index => {
        const container = document.getElementById('chat-scroll');
        const bubble = container.querySelector(`[data-chatgpt-search-unit-key="fallback-turn-${index}:0:user"] [data-user-message-bubble]`);
        if (!bubble) return false;
        const rect = bubble.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        const root = document.getElementById('chatgpt-right-rail-extension').shadowRoot;
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom &&
          root.querySelectorAll('.mark')[index]?.getAttribute('aria-current') === 'location';
      }, index, { timeout: 8000 }).catch(async error => {
        console.error('Virtual navigation failure:', index, await page.evaluate(() => ({
          scrollTop: document.getElementById('chat-scroll').scrollTop,
          live: [...document.querySelectorAll('[data-chatgpt-search-unit-key]')].map(node => node.getAttribute('data-chatgpt-search-unit-key')),
          active: document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.getAttribute('aria-label'),
          status: document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').textContent
        })));
        throw error;
      });
    }

    await loadVirtualChat(60);
    assert.ok(await marks.count() < 10, '虚拟列表最初只渲染最后几个问题');
    const originalReadingTop = await page.locator('#chat-scroll').evaluate(node => {
      node.scrollTop = 24 * 360 + 80;
      return node.scrollTop;
    });
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), originalReadingTop, '默认不得滚动整段对话补全');
    assert.ok(await marks.count() < 10);
    await expectHistoryComplete(60);
    await page.waitForFunction(expected => {
      const node = document.getElementById('chat-scroll');
      return Math.abs(node.scrollTop - expected) < 2;
    }, originalReadingTop);
    assert.ok((await marks.nth(0).getAttribute('aria-label')).includes('历史问题 1'));
    assert.ok((await marks.nth(59).getAttribute('aria-label')).includes('历史问题 60'));
    assert.equal(await marks.nth(10).getAttribute('aria-label'), '第 11 个问题：继续');
    assert.equal(await marks.nth(30).getAttribute('aria-label'), '第 31 个问题：继续');
    const railGeometry = await page.locator(`${hostSelector} .rail`).evaluate(rail => ({
      allFit: rail.scrollHeight <= rail.clientHeight,
      count: [...rail.children].filter(node => {
        const rect = node.getBoundingClientRect();
        const viewport = rail.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      }).length
    }));
    assert.equal(railGeometry.allFit, true);
    assert.equal(railGeometry.count, 60, '60 个横线应同时显示');
    for (const index of [0, 59, 30, 10]) {
      await marks.nth(index).click();
      await expectVirtualQuestion(index);
      await expectCount(60);
    }
    await page.locator('#chat-window').evaluate(node => { node.innerHTML = '<div>仅渲染助手回复的片段</div>'; });
    await page.evaluate(() => window.__chatgptRightRailLoaded.refresh());
    await expectCount(60);
    await marks.nth(0).click();
    await expectVirtualQuestion(0);
    console.log('PASS: all 60 virtualized questions indexed in order, duplicate text retained, reading position restored, dense rail and unloaded targets navigable');
    console.log('PASS: question index and navigation survive an assistant-only viewport');

    // 分页加载更早消息时页面会调整 scrollTop；补全必须持续回到顶部，直到历史稳定。
    await load(`${scrollStyles}<div id="chat-scroll"><div id="lazy-turns"></div></div>`);
    await page.evaluate(messages => {
      const container = document.getElementById('chat-scroll');
      const turns = document.getElementById('lazy-turns');
      let first = messages.length - 6;
      let loading = false;
      turns.innerHTML = messages.slice(first).join('');
      container.addEventListener('scroll', () => {
        if (container.scrollTop > 2 || !first || loading) return;
        loading = true;
        container.setAttribute('aria-busy', 'true');
        setTimeout(() => {
          const previous = first;
          first = Math.max(0, first - 6);
          turns.insertAdjacentHTML('afterbegin', messages.slice(first, previous).join(''));
          container.scrollTop += (previous - first) * 360;
          loading = false;
          container.removeAttribute('aria-busy');
        }, 350);
      });
      container.scrollTop = container.scrollHeight;
      window.__chatgptRightRailLoaded.refresh();
    }, Array.from({ length: 30 }, (_, index) => `<div class="virtual-row">${searchUnit(`分页问题 ${index + 1}`, index)}</div>`));
    await expectHistoryComplete(30);
    await page.waitForFunction(() => {
      const node = document.getElementById('chat-scroll');
      return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
    });
    assert.ok((await marks.nth(0).getAttribute('aria-label')).includes('分页问题 1'));
    assert.ok((await marks.nth(29).getAttribute('aria-label')).includes('分页问题 30'));
    console.log('PASS: lazy history pagination fully indexed and original bottom position restored');

    await loadVirtualChat(80);
    await historyControl.click();
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').dataset.state === 'index');
    await page.mouse.move(600, 350);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').dataset.state !== 'index');
    assert.notEqual(await historyControl.getAttribute('data-state'), 'index');
    await page.evaluate(html => {
      history.pushState({}, '', '/c/different-chat');
      document.querySelector('main').innerHTML = html;
    }, searchUnit('新对话只有这一个问题', 0));
    await expectCount(1, '新对话只有这一个问题');
    // 等待已取消任务的最长单次等待结束，验证它不会恢复旧位置或重写新对话索引。
    await page.waitForTimeout(450);
    await expectCount(1, '新对话只有这一个问题');
    assert.equal(await historyControl.isHidden(), true);
    console.log('PASS: user wheel interrupts history indexing and SPA navigation clears cached history');

    // URL 已变化但聊天 DOM 尚未切换：旧问题必须暂时消失，不能缓存到新聊天。
    await loadVirtualChat(18);
    await expectHistoryComplete(18);
    await page.evaluate(() => {
      history.pushState({}, '', '/c/route-before-dom');
      window.__chatgptRightRailLoaded.refresh();
    });
    await expectCount(0);
    assert.ok(await page.locator('[data-user-message-bubble]').count() > 0, '旧聊天 DOM 此时仍在页面中');
    await page.waitForTimeout(1000);
    await expectCount(0);
    await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, searchUnit('新聊天中真实存在的问题', 0));
    await expectCount(1, '新聊天中真实存在的问题');
    console.log('PASS: delayed SPA DOM transition cannot pollute the new conversation index');

    await load(searchUnit('正文中的唯一问题', 0) +
      `<div hidden>${searchUnit('隐藏副本不是问题', 1)}</div>` +
      `<div style="visibility:hidden">${searchUnit('不可见副本不是问题', 2)}</div>` +
      `<div data-turn="assistant">${searchUnit('助手内部标记不是问题', 3)}</div>` +
      `<div role="dialog">${searchUnit('弹窗搜索结果不是问题', 4)}</div>`);
    await page.locator('body').evaluate((body, html) => { body.insertAdjacentHTML('beforeend', `<aside>${html}</aside>`); }, searchUnit('侧边栏条目不是问题', 5));
    await expectCount(1, '正文中的唯一问题');
    console.log('PASS: sidebar, hidden copies, assistant content and dialog results are excluded');

    // 同一提问在重渲染后换节点，以及稍后补上 message-id，不能产生额外横线。
    const unkeyedMessages = Array.from({ length: 13 }, (_, index) => modern(`无永久标识的问题 ${index + 1}`)).join('');
    await load(unkeyedMessages);
    await expectHistoryComplete(13);
    const firstKey = await marks.nth(0).getAttribute('data-key');
    await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, unkeyedMessages);
    await page.evaluate(() => window.__chatgptRightRailLoaded.refresh());
    await expectCount(13);
    await page.locator('[data-turn="user"]').evaluateAll(nodes => nodes.forEach((node, index) => { node.dataset.messageId = `hydrated-${index}`; }));
    await page.evaluate(() => window.__chatgptRightRailLoaded.refresh());
    await expectCount(13);
    assert.equal(await marks.nth(0).getAttribute('data-key'), firstKey);
    const controlGeometry = await historyControl.evaluate(button => {
      const rail = button.getRootNode().querySelector('.rail').getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return { width: rect.width, railWidth: rail.width, right: rect.right, railRight: rail.right, height: rect.height, text: button.textContent };
    });
    assert.equal(controlGeometry.width, controlGeometry.railWidth);
    assert.equal(controlGeometry.right, controlGeometry.railRight);
    assert.equal(controlGeometry.height, 24);
    assert.equal(controlGeometry.text, '13');
    assert.ok((await historyControl.getAttribute('aria-label')).includes('重新补全'));
    fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'rail-1.0.6.png'), clip: { x: 1200, y: 260, width: 240, height: 400 } });
    console.log('PASS: unkeyed remounts and identity hydration do not create ghost questions; compact control aligns with rail');

    // 浏览器滚动后复用同一批节点显示不同消息，不能继续把旧节点当作原来的问题。
    await loadVirtualChat(24, true);
    await expectHistoryComplete(24);
    await page.evaluate(() => { window.shiftFirstTarget = true; });
    for (const index of [0, 23, 10, 3]) {
      await marks.nth(index).click();
      await expectVirtualQuestion(index);
      await expectCount(24);
      if (index === 0) {
        await page.waitForFunction(() => {
          const bubble = document.querySelector('[data-message-id="stable-message-0"]');
          const viewport = document.getElementById('chat-scroll').getBoundingClientRect();
          return Math.abs(bubble.getBoundingClientRect().top - viewport.top - 80) < 3;
        });
      }
    }
    await marks.nth(4).click();
    await marks.nth(23).click();
    await expectVirtualQuestion(23);
    console.log('PASS: recycled DOM nodes and post-scroll layout shifts are verified against the actual target message');
    console.log('PASS: a new navigation cancels the previous target correction');

    await load(Array.from({ length: 3 }, (_, index) => classic(`点击前已有的问题 ${index + 1}`, index)).join(''));
    const clickedKey = await marks.nth(1).getAttribute('data-key');
    const clickedBox = await marks.nth(1).boundingBox();
    await page.mouse.move(clickedBox.x + clickedBox.width / 2, clickedBox.y + clickedBox.height / 2);
    await page.mouse.down();
    await page.locator('main').evaluate((main, html) => { main.insertAdjacentHTML('afterbegin', html); }, Array.from({ length: 3 }, (_, index) => classic(`刚加载的问题 ${index + 1}`, index + 100)).join(''));
    await page.evaluate(() => window.__chatgptRightRailLoaded.refresh());
    await page.mouse.up();
    await page.waitForFunction(key => document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.dataset.key === key, clickedKey);
    assert.ok((await page.locator(`${hostSelector} [aria-current]`).getAttribute('aria-label')).includes('点击前已有的问题 2'));
    console.log('PASS: question list updates between pointer-down and click retain the selected message identity');
    assert.deepEqual(failures, []);
    console.log('PASS: no browser script errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
