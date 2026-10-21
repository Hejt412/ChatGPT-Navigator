const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup({ tabs = [], failTab, queryError } = {}) {
  const listeners = {};
  const queries = [];
  const injections = [];
  const warnings = [];
  vm.runInNewContext(source, {
    console: { warn: (...args) => warnings.push(args) },
    chrome: {
      runtime: { onInstalled: { addListener: fn => { listeners.installed = fn; } } },
      action: { onClicked: { addListener: fn => { listeners.clicked = fn; } } },
      tabs: {
        query: async query => {
          queries.push(query);
          if (queryError) throw new Error('query failed');
          return tabs;
        }
      },
      scripting: {
        executeScript: async options => {
          injections.push(options);
          if (options.target.tabId === failTab) throw new Error('tab closed');
        }
      }
    }
  });
  return { listeners, queries, injections, warnings };
}

test('install/update injects content into already open chats and skips discarded tabs', async () => {
  const app = setup({ tabs: [{ id: 1 }, { id: 2, discarded: true }, { id: 3 }, {}] });
  await app.listeners.installed({ reason: 'install' });
  assert.deepEqual(Array.from(app.queries[0].url), ['https://chatgpt.com/*', 'https://chat.openai.com/*']);
  assert.deepEqual(app.injections.map(item => item.target.tabId), [1, 3]);
  assert.ok(app.injections.every(item => item.files.length === 1 && item.files[0] === 'content.js'));
  app.injections.length = 0;
  await app.listeners.installed({ reason: 'update' });
  assert.deepEqual(app.injections.map(item => item.target.tabId), [1, 3]);
});

test('a closed or inaccessible tab does not stop injection into other chats', async () => {
  const app = setup({ tabs: [{ id: 1 }, { id: 2 }], failTab: 1 });
  await app.listeners.installed();
  assert.deepEqual(app.injections.map(item => item.target.tabId), [1, 2]);
  assert.equal(app.warnings.length, 1);
});

test('query errors are handled without an unhandled rejection', async () => {
  const app = setup({ queryError: true });
  await app.listeners.installed();
  assert.equal(app.injections.length, 0);
  assert.equal(app.warnings.length, 1);
});

test('toolbar click reinjects only on supported ChatGPT origins', async () => {
  const app = setup();
  for (const url of ['https://chatgpt.com/c/old', 'https://chat.openai.com/c/old']) {
    await app.listeners.clicked({ id: 5, url });
  }
  for (const url of ['https://example.com/', 'https://chatgpt.com.example.com/', 'http://chatgpt.com/', 'edge://extensions/', undefined]) {
    await app.listeners.clicked({ id: 5, url });
  }
  await app.listeners.clicked({ url: 'https://chatgpt.com/' });
  assert.deepEqual(app.injections.map(item => item.target.tabId), [5, 5]);
});

test('toolbar injection errors are handled', async () => {
  const app = setup({ failTab: 5 });
  await app.listeners.clicked({ id: 5, url: 'https://chatgpt.com/' });
  assert.equal(app.warnings.length, 1);
});

test('manifest declares injection and toolbar entry points with site-scoped permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.action.default_title);
  assert.deepEqual(manifest.permissions, ['scripting']);
  assert.deepEqual(manifest.host_permissions, manifest.content_scripts[0].matches);
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
});
