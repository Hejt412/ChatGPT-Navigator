const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const folder = require('../folder-storage.js');
const memory = require('../navigation-memory.js');
const model = require('../conversation-model.js');
const origin = 'https://chatgpt.com', key = memory.scopeKey(origin, 'chat');
const outputs = path.resolve(__dirname, '../test-results');

function storage(initial = {}) {
  const data = structuredClone(initial);
  return { data, get: async name => structuredClone(name === null ? data : { [name]: data[name] }),
    set: async values => { Object.assign(data, structuredClone(values)); },
    remove: async names => { for (const name of Array.isArray(names) ? names : [names]) delete data[name]; } };
}
function record() {
  return memory.encode(model, {origin,id:'chat',snapshot:null,complete:true,entries:[{
    key:'message:q',messageId:'q',signature:model.signature('记住这个问题'),preview:'记住这个问题',response:'对应的回答',source:'page',position:360
  }]});
}
async function disk() {
  await fs.mkdir(outputs,{recursive:true});
  const base = await fs.mkdtemp(path.join(outputs,'folder-memory-'));
  assert.ok(path.resolve(base).startsWith(outputs + path.sep));
  const state = {permission:'granted',failWrite:false};
  const nameCheck = name => { if (!name || path.basename(name)!==name || name==='..') throw new Error('unsafe test path'); return name; };
  const handle = (absolute,kind='directory') => ({
    kind,name:path.basename(absolute),queryPermission:async()=>state.permission,
    async getDirectoryHandle(name, options={}) {
      const target=path.join(absolute,nameCheck(name));
      try { if(options.create) await fs.mkdir(target,{recursive:false}); } catch(error) { if(error.code!=='EEXIST')throw error; }
      try { await fs.access(target); } catch { throw new DOMException('missing','NotFoundError'); }
      return handle(target);
    },
    async getFileHandle(name,options={}) {
      const target=path.join(absolute,nameCheck(name));
      try { await fs.access(target); } catch { if(!options.create)throw new DOMException('missing','NotFoundError'); }
      return {
        kind:'file',name,
        async getFile(){const content=await fs.readFile(target);return{size:content.length,text:async()=>content.toString('utf8')};},
        async createWritable(){let text='';return{
          write:async value=>{text=value;},close:async()=>{if(state.failWrite)throw new Error('disk unavailable');await fs.writeFile(target,text,'utf8');},abort:async()=>{}
        };}
      };
    },
    async *values(){for(const value of await fs.readdir(absolute,{withFileTypes:true}))yield{kind:value.isDirectory()?'directory':'file',name:value.name};},
    async removeEntry(name){try{await fs.unlink(path.join(absolute,nameCheck(name)));}catch(error){if(error.code==='ENOENT')throw new DOMException('missing','NotFoundError');throw error;}}
  });
  let selected;
  return {base,state,root:handle(base),handles:{get:async()=>selected,set:async value=>{selected=value;}}};
}

test('moving memory writes verified JSON on disk and removes browser copies without touching bookmarks or source files', async () => {
  const dir=await disk(), local=storage({[key]:record(),'question-bookmarks:chat':['message:q']});
  await fs.writeFile(path.join(dir.base,'content.js'),'extension-source','utf8');
  const api=folder.create(local,{handles:dir.handles});
  const result=await api.configure(dir.root);
  assert.equal(result.migrated,1);
  const file=path.join(dir.base,'navigator-data',folder.filename(key));
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).entries[0].preview,'记住这个问题');
  assert.equal(local.data[key],undefined);
  assert.deepEqual(local.data['question-bookmarks:chat'],['message:q']);
  assert.equal(await fs.readFile(path.join(dir.base,'content.js'),'utf8'),'extension-source');
  const reopened=folder.create(local,{handles:dir.handles});
  assert.equal((await reopened.get(key))[key].complete,true);
  assert.equal((await reopened.status()).mode,'folder');
});

test('folder saves and clears affect only cache JSON files, and switching back retains the disk copy', async () => {
  const dir=await disk(), local=storage({[key]:record()}), api=folder.create(local,{handles:dir.handles});
  await api.configure(dir.root);
  await fs.writeFile(path.join(dir.base,'navigator-data','keep.txt'),'unrelated','utf8');
  const next=record();next.entries[0].preview='更新后的问题';
  await api.set({[key]:next});
  assert.equal((await api.get(null))[key].entries[0].preview,'更新后的问题');
  await api.useBrowser();
  assert.equal(local.data[key].entries[0].preview,'更新后的问题');
  assert.equal(await fs.readFile(path.join(dir.base,'navigator-data','keep.txt'),'utf8'),'unrelated');
  assert.ok(await fs.stat(path.join(dir.base,'navigator-data',folder.filename(key))));
  await api.configure(dir.root);await api.remove(key);
  assert.equal((await api.get(null))[key],undefined);
  assert.equal(await fs.readFile(path.join(dir.base,'navigator-data','keep.txt'),'utf8'),'unrelated');
});

test('revoked directory permission stops reads and writes without silently recreating a browser cache', async () => {
  const dir=await disk(), local=storage({[key]:record()}), api=folder.create(local,{handles:dir.handles});
  await api.configure(dir.root);dir.state.permission='prompt';
  await assert.rejects(api.get(key),{name:'DirectoryPermissionRequired'});
  await assert.rejects(api.set({[key]:record()}),{name:'DirectoryPermissionRequired'});
  assert.equal(local.data[key],undefined);
  assert.equal((await api.status()).granted,false);
});

test('a failed migration preserves the original browser record and storage mode', async () => {
  const dir=await disk(), local=storage({[key]:record()}), api=folder.create(local,{handles:dir.handles});
  dir.state.failWrite=true;
  await assert.rejects(api.configure(dir.root),/disk unavailable/);
  assert.equal(local.data[key].entries.length,1);
  assert.equal((await api.status()).mode,'browser');
});

test('cache names reject traversal and mismatched records before writing files', async () => {
  assert.throws(()=>folder.filename('question-memory:v1:https://chatgpt.com:../content.js'));
  const dir=await disk(),local=storage(),api=folder.create(local,{handles:dir.handles});
  await assert.rejects(api.set({[key]:{...record(),conversationId:'other'}}),/无效/);
  assert.deepEqual(local.data,{});
});

test('background record saves preserve newer data and evict expired cache files in the same operation', async () => {
  const dir=await disk(),local=storage({[key]:record()}),api=folder.create(local,{handles:dir.handles});
  await api.configure(dir.root);
  const previous=record();previous.updatedAt=1;
  await api.saveRecord(key,previous);
  assert.notEqual((await api.get(key))[key].updatedAt,1,'过时的后台任务不能覆盖较新记忆');
  const oldKey=memory.scopeKey(origin,'expired'),old={...record(),conversationId:'expired',updatedAt:1};
  await api.set({[oldKey]:old});
  const next=record();next.updatedAt+=1000;
  await api.saveRecord(key,next);
  assert.equal((await api.get(oldKey))[oldKey],undefined);
  assert.equal((await api.get(key))[key].updatedAt,next.updatedAt);
  assert.equal(local.data[key],undefined);
});
