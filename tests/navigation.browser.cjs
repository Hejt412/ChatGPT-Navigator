const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { fixture } = require('./data.browser.cjs');
const project = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(project, file), 'utf8');
const host = '#chatgpt-right-rail-extension';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: ['conversation-model.js', 'history-loader.js', 'page-state.js', 'page-bridge.js'].map(source).join('\n') });
    await page.route('https://chatgpt.com/**', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ contentType: 'text/html', body: fixture(id, true) });
    });
    const marks = page.locator(host + ' .mark');
    async function load(id) {
      await page.goto('https://chatgpt.com/c/' + id);
      await page.evaluate(source('content.js'));
      await page.waitForFunction(() => document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark').length === 40);
      await page.evaluate(() => {
        window.scrollCommands = [];
        const scroller = document.getElementById('chat-scroll'), native = scroller.scrollTo;
        scroller.scrollTo = function (...args) { window.scrollCommands.push(args[0].top); return native.apply(this, args); };
      });
    }
    async function target(id) {
      await page.waitForFunction(id => {
        const node = document.querySelector(`[data-message-id="${id}"]`);
        const root = document.getElementById('chatgpt-right-rail-extension').shadowRoot;
        const scroller = document.getElementById('chat-scroll').getBoundingClientRect();
        const rect = node?.getBoundingClientRect();
        return rect && rect.top >= scroller.top && rect.bottom <= scroller.bottom && root.querySelector('[aria-current]')?.dataset.key === 'message:' + id &&
          root.querySelector('.history-control').dataset.state !== 'seek';
      }, id, { timeout: 10000 });
    }

    await load('native-jump');
    await page.evaluate(() => {
      window.nativeJumps = [];
      document.querySelector('main')['__reactFiber$navigation'] = { memoizedProps: {
        conversationId: 'native-jump', scrollToMessage: async id => {
          window.nativeJumps.push(id);
          // 原生虚拟列表动作可能异步挂载；中途收到新快照不能取消这次定位。
          await new Promise(resolve => setTimeout(resolve, 350));
          const scroller = document.getElementById('chat-scroll');
          scroller.scrollTop = window.rows.findIndex(row => row.id === id) * 360;
          window.renderRows();
        }
      } };
      window.addEventListener('message', event => {
        if (event.data?.type === 'navigate') setTimeout(() => window.__chatgptRightRailLoaded.refresh(), 80);
      });
    });
    await marks.nth(10).click();
    await target('user-10');
    assert.deepEqual(await page.evaluate(() => window.nativeJumps), ['user-10']);
    assert.ok((await page.evaluate(() => window.scrollCommands.length)) <= 3, '原生定位只需核验及微调');
    console.log('PASS: offscreen duplicate prompt uses its real message ID and waits for the asynchronous native navigation action');

    await load('snapshot-during-seek');
    await page.evaluate(() => {
      // 响应索引在定位期间重复发布（网页翻页或状态更新），原来的点击应继续生效。
      window.addEventListener('message', event => {
        if (event.data?.type === 'navigate') {
          const { nonce, conversationId } = event.data;
          setTimeout(() => window.postMessage({ channel: 'chatgpt-navigator-v2', type: 'request', nonce, conversationId }, location.origin), 40);
        }
      });
    });
    await marks.nth(20).click();
    await target('user-20');
    assert.equal(await marks.count(), 40);
    console.log('PASS: a new conversation snapshot during seeking preserves the selected target and full index');

    await load('unavailable-target');
    const top = await page.locator('#chat-scroll').evaluate(node => node.scrollTop);
    await page.evaluate(() => {
      const scroller = document.getElementById('chat-scroll');
      scroller.removeEventListener('scroll', window.renderRows);
      window.renderRows = () => { document.getElementById('turns').textContent = '目标暂时未挂载，只有长回答'; };
      scroller.addEventListener('scroll', window.renderRows);
    });
    await marks.nth(20).click();
    await page.waitForFunction(() => {
      const button = document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control');
      return button.dataset.state !== 'seek' && button.title.includes('保留阅读位置');
    }, null, { timeout: 12000 });
    assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), top);
    assert.equal(await marks.count(), 40, '暂时无法挂载不能删除目录项');
    const commands = await page.evaluate(() => window.scrollCommands);
    assert.ok(commands.length <= 4, `失败必须有限停止，实际滚动 ${commands.length} 次`);
    assert.ok(commands.every(value => value > 0), '失败不得跳到开头遍历全对话');
    console.log('PASS: an unavailable target stops after bounded probes, restores reading position, retains all questions and never sweeps from the beginning');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
