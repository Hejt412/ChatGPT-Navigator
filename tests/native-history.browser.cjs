const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { conversation, fixture } = require('./data.browser.cjs');
const project = path.resolve(__dirname, '..');

function nativeFixture(id) {
  return fixture(id, true).replace('</script>', `
    const nativeGraph=window.__NEXT_DATA__.props.pageProps.conversation;
    delete window.__NEXT_DATA__;
    let firstKnown=35,inFlight=false,historyObserver;
    const known=Object.fromEntries(Object.entries(nativeGraph.mapping).filter(([key])=>/node-(?:user|answer)-(3[5-9])$/.test(key)));
    const provider={memoizedProps:{conversationId:${JSON.stringify(id)},conversation:{current_node:nativeGraph.current_node,mapping:known}}};
    document.querySelector('main')['__reactFiber$native']={return:provider};
    const sentinel=document.createElement('div');sentinel.id='native-history-loader';sentinel.setAttribute('role','status');
    sentinel.textContent=${JSON.stringify(id === 'late-label' ? '' : '正在加载更早的消息…')};sentinel.style.cssText='position:absolute;top:0;left:0;height:20px';
    ${id === 'late-label' ? "setTimeout(()=>{sentinel.textContent='正在加载更早的消息…';space.append(sentinel);},150);" : 'space.append(sentinel);'}
    window.nativeHistoryCalls=0;window.chatScrollCommands=0;window.unrelatedVisibleCallbacks=0;
    const originalScrollTo=scroll.scrollTo;
    scroll.scrollTo=function(...args){window.chatScrollCommands++;return originalScrollTo.apply(this,args);};
    const unrelated=document.createElement('div');unrelated.textContent='正在加载图片';unrelated.setAttribute('role','status');
    unrelated.style.cssText='position:absolute;top:0;left:0;height:10px';space.append(unrelated);
    new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting))window.unrelatedVisibleCallbacks++;},{root:scroll}).observe(unrelated);
    function armHistory(){
      if(${JSON.stringify(id)}==='react-pager'){
        provider.memoizedProps.history={hasPreviousPage:firstKnown>0,isFetchingPreviousPage:inFlight,fetchPreviousPage:loadOlder};
        sentinel.remove();return;
      }
      if(${JSON.stringify(id)}==='reused-observer'&&historyObserver){if(!firstKnown)sentinel.remove();return;}
      historyObserver?.disconnect();
      if(!firstKnown){sentinel.remove();return;}
      historyObserver=new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting))loadOlder();},{root:scroll,rootMargin:'80px 0px 0px 0px'});
      historyObserver.observe(sentinel);
    }
    function loadOlder(){
      if(inFlight||!firstKnown)return;
      inFlight=true;window.nativeHistoryCalls++;
      if(provider.memoizedProps.history)provider.memoizedProps.history.isFetchingPreviousPage=true;
      const xhr=new XMLHttpRequest();xhr.open('GET','/backend-api/conversation/${id}?before='+firstKnown);xhr.responseType='json';
      xhr.onload=()=>{
        if(xhr.status!==200){inFlight=false;sentinel.textContent='重试';return;}
        Object.assign(known,xhr.response.mapping);firstKnown=Math.max(0,firstKnown-5);
        provider.memoizedProps={conversationId:${JSON.stringify(id)},conversation:{current_node:nativeGraph.current_node,mapping:known}};
        inFlight=false;armHistory();
      };xhr.send();
    }
    armHistory();
  </script>`);
}

function historyPage(id, before) {
  const all = conversation(id);
  const first = Math.max(0, before - 5);
  const mapping = {};
  if (!first) mapping.root = all.mapping.root;
  for (let i = first; i < before; i++) for (const role of ['user', 'answer']) mapping[`node-${role}-${i}`] = all.mapping[`node-${role}-${i}`];
  // 与组件形态一致：图本身不带对话 ID，通过当前 GET 地址或组件的 conversationId 绑定。
  return { current_node: `node-answer-${before - 1}`, mapping, has_more: first > 0 };
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const scripts = ['conversation-model.js', 'history-loader.js', 'page-state.js', 'page-bridge.js'].map(file=>fs.readFileSync(path.join(project,file),'utf8')).join('\n');
    await page.addInitScript({ content: scripts });
    await page.route('https://chatgpt.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/backend-api/conversation/')) {
        requests.push(url.pathname);
        const id=url.pathname.split('/').at(-1),before=Number(url.searchParams.get('before'));
        await new Promise(resolve=>setTimeout(resolve,id==='pause'&&before===35?800:30));
        return route.fulfill({status:id==='error'?500:200,contentType:'application/json',body:JSON.stringify(historyPage(id,before))});
      }
      return route.fulfill({ contentType: 'text/html', body: nativeFixture(url.pathname.split('/').at(-1)) });
    });
    const host='#chatgpt-right-rail-extension';
    async function load(id) {
      await page.goto('https://chatgpt.com/c/'+id);
      const top=await page.locator('#chat-scroll').evaluate(node=>node.scrollTop);
      await page.evaluate(fs.readFileSync(path.join(project,'content.js'),'utf8'));
      return top;
    }
    async function complete() {
      await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension')?.shadowRoot.querySelectorAll('.mark').length===40&&document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').dataset.state==='complete',null,{timeout:18000});
    }
    const top=await load('native');
    await complete();
    assert.equal(await page.locator('#chat-scroll').evaluate(node=>node.scrollTop),top);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0,'补全不得遍历滚动正文');
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    assert.equal(await page.evaluate(()=>window.unrelatedVisibleCallbacks),0,'不得触发图片等无关观察器');
    assert.equal(requests.length,7,'所有分页必须由网页自身加载器发起');
    assert.ok(await page.locator('[data-message-author-role=user]').count()<6);
    const marks=page.locator(host+' .mark');
    await marks.nth(10).hover();
    await page.locator(host+' .tooltip').waitFor({state:'visible'});
    assert.equal(await page.locator(host+' .tooltip-text').innerText(),'继续');
    assert.ok((await page.locator(host+' .tooltip-response').innerText()).includes('第 11 个问题'));
    await marks.first().click();
    await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('[aria-current]')?.dataset.key==='message:user-0');
    console.log('PASS: native history loader reads 40 questions in 7 authenticated-site pages without scrolling, leaves unrelated observers alone, old targets and previews work');

    await load('late-label');
    await complete();
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0);
    console.log('PASS: a history target observed before its text and DOM attachment still loads all older pages');

    await load('reused-observer');
    await complete();
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0);
    console.log('PASS: the same observer and sentinel load all seven pages, with each next call gated on index progress');

    await load('react-pager');
    await complete();
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0);
    console.log('PASS: committed native pagination callback reads all pages without a history sentinel or observer');

    await load('pause');
    await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension').shadowRoot.querySelector('.history-control').dataset.state==='native');
    await page.locator(host+' .history-control').click();
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),1);
    await page.locator(host+' .history-control').click();
    await complete();
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),7);
    console.log('PASS: native history reading pauses and resumes; the completed in-flight request does not restart pagination');

    await load('error');
    await page.waitForFunction(()=>document.getElementById('chatgpt-right-rail-extension').dataset.history==='error',null,{timeout:8000});
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(()=>window.nativeHistoryCalls),1);
    assert.equal(await page.evaluate(()=>window.chatScrollCommands),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: a native load error stops without repeated requests or fallback auto scrolling; no page script errors');
  } finally { await browser.close(); }
}

if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={nativeFixture,historyPage};
