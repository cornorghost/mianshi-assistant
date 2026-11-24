const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../src/session-store.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interview-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('questions link to their exact source sentences; restart preserves answers, partials and queued questions',t=>{
  const dir=fixture(t);let store=new SessionStore(dir);const id=store.current.id;
  store.transcript({sessionId:'audio',utteranceId:0,text:'先给你一个订单系统的场景。',final:true});
  store.transcript({sessionId:'audio',utteranceId:1000,text:'如何保证',replace:true,final:false});
  store.transcript({sessionId:'audio',utteranceId:1000,text:'如何保证接口幂等？',replace:true,final:true});
  store.queue({id:'q1',question:'订单系统如何保证接口幂等？',source:'speech',sourceIds:['audio:0','audio:1000','not-real']});
  store.update('q1',{status:'completed',answer:'可以使用唯一请求号。'});
  store.queue({id:'q2',question:'如何优化索引？'});store.update('q2',{status:'generating',answer:'先查看执行计划'});
  store.queue({id:'q3',question:'Redis 持久化有哪些？'});
  store=new SessionStore(dir);assert.equal(store.current.id,id);assert.equal(store.current.turns.length,3);
  assert.deepEqual(store.current.turns[0].sourceIds,['audio:0','audio:1000']);assert.equal(store.current.turns[1].status,'interrupted');assert.equal(store.current.turns[1].answer,'先查看执行计划');assert.equal(store.current.turns[2].status,'queued');
  const document=fs.readFileSync(store.file(id,'md'),'utf8');assert.match(document,/唯一请求号/);assert.match(document,/对应转写：\[1\]、\[2\]/);assert.match(document,/如何保证接口幂等/);assert.ok(!document.includes('如何保证如何保证'));
  store.finish();store.create();assert.equal(store.list().length,2);assert.equal(store.read(id).turns[0].answer,'可以使用唯一请求号。');assert.equal(store.current.turns.length,0);
  assert.throws(()=>store.read('../escape'));
});
test('same question text in separate turns is retained, queue retries are idempotent and screenshots survive temp cleanup',t=>{
  const dir=fixture(t),store=new SessionStore(dir),image=path.join(dir,'capture.png');fs.writeFileSync(image,'test image');
  store.queue({id:'q1',question:'解释索引',attachment:image,source:'screenshot'});store.queue({id:'q1',question:'解释索引'});store.queue({id:'q2',question:'解释索引'});fs.unlinkSync(image);
  assert.equal(store.current.turns.length,2);assert.equal(fs.readFileSync(store.current.turns[0].attachment,'utf8'),'test image');
  store.finish();assert.throws(()=>store.queue({id:'q3',question:'新问题'}));assert.match(store.document(),/解释索引/);
});
test('legacy transcript chunks migrate into an archived session without fabricated answers',t=>{
  const dir=fixture(t),store=new SessionStore(dir);
  store.importLegacy([{id:1,sessionId:'old',utteranceId:1,text:'什么是',final:false,capturedAt:1000},{id:2,sessionId:'old',utteranceId:1,text:'数据库索引？',final:true,capturedAt:2000}]);
  const old=store.list().find(s=>s.id!==store.current.id);assert.ok(old.endedAt);assert.equal(old.turns,0);
  assert.equal(store.read(old.id).transcripts[0].text,'什么是数据库索引？');assert.equal(store.current.transcripts.length,0);
});
test('multiple sessions switch independently, resume archives and restore the last selected conversation',t=>{
  const dir=fixture(t);let store=new SessionStore(dir);const first=store.current.id;
  store.rename('公司 A · 一面');store.setProject('F:/projects/order');store.queue({id:'a1',question:'如何设计订单系统？'});store.update('a1',{answer:'A 的回答',status:'completed'});
  store.create();const second=store.current.id;store.rename('公司 B · 二面');store.setProject('F:/projects/cache');store.queue({id:'b1',question:'如何保持缓存一致？'});store.update('b1',{answer:'B 的回答',status:'completed'});
  store.activate(first);assert.equal(store.current.title,'公司 A · 一面');assert.equal(store.current.turns[0].answer,'A 的回答');assert.equal(store.current.projectRoot,'F:/projects/order');
  store.finish();store.activate(second);assert.equal(store.current.turns[0].answer,'B 的回答');assert.equal(store.current.projectRoot,'F:/projects/cache');
  store.activate(first);assert.ok(store.current.endedAt);store.resume();assert.equal(store.current.endedAt,null);store.queue({id:'a2',question:'追问订单如何重试？'});
  store=new SessionStore(dir);assert.equal(store.current.id,first);assert.equal(store.current.turns.length,2);assert.equal(store.read(second).turns.length,1);assert.equal(store.list().length,2);
});
test('screenshots persist before submission, stay bound to their question and export with portable image files',t=>{
  const dir=fixture(t),capture=path.join(dir,'temporary.png');let store=new SessionStore(dir);
  fs.writeFileSync(capture,'first-image');const first=store.capture(capture);fs.writeFileSync(capture,'second-image');const second=store.capture(capture);fs.unlinkSync(capture);
  const sessionId=store.current.id;store.queue({id:'screenshot-1',question:'第一张截图题',source:'screenshot',attachmentId:first.id});
  assert.equal(store.current.turns[0].attachment,first.path);assert.equal(store.current.screenshots.length,2);
  store=new SessionStore(dir);assert.equal(store.current.id,sessionId);assert.equal(store.attachmentData(sessionId,'screenshot-1'),'data:image/png;base64,'+Buffer.from('first-image').toString('base64'));assert.equal(store.attachmentData(sessionId,second.id),'data:image/png;base64,'+Buffer.from('second-image').toString('base64'));
  const exported=path.join(dir,'面试文档.md');store.exportTo(exported);const document=fs.readFileSync(exported,'utf8');assert.match(document,/!\[题目截图\]/);assert.match(document,/其他截图/);assert.equal(fs.readFileSync(path.join(dir,'面试文档-assets',path.basename(first.path)),'utf8'),'first-image');
  store.create();assert.throws(()=>store.attachmentData(store.current.id,first.id));assert.equal(store.read(sessionId).screenshots.length,2);
});
