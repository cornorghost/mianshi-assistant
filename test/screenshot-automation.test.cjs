const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const SpeechPipeline=require('../src/speech.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  const elements=new Map(),handlers=new Map(),asks=[],queued=[],answers=[];let initialize;
  const element=()=>({value:'',hidden:false,textContent:'',classList:{add(){},remove(){}},append(){},replaceChildren(){},addEventListener(){}});
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element};
  const api={on:(event,handler)=>handlers.set(event,handler),invoke:(channel,data)=>{
    if(channel==='init')return new Promise(resolve=>{initialize=resolve;});
    if(channel==='session-list')return Promise.resolve([]);
    if(channel==='turn-queue'){queued.push(data);return Promise.resolve({...data,attachment:'/saved/'+data.attachmentId+'.png',status:'queued'});}
    if(channel==='session-attachment')return Promise.resolve('data:image/png;base64,test');
    if(channel==='ask'){asks.push(data);return new Promise(resolve=>answers.push(resolve));}
    return Promise.resolve(true);
  }};
  const context=vm.createContext({window:{copilot:api,SpeechPipeline},document,setInterval(){},setTimeout(){},clearTimeout(){},console,Date,Uint8Array,Float32Array,DataView,ArrayBuffer});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),context);
  return {elements,handlers,asks,queued,answers,context,initialize:settings=>initialize({settings,platform:'darwin',interview:{id:'session-a',turns:[],transcripts:[]},codex:{ok:false,connecting:true,epoch:1}})};
}
test('Mac screenshots arriving during initialization are submitted once after settings load, independently of voice auto-answer',async()=>{
  const h=harness(),first={dataUrl:'data:image/png;base64,one',attachmentId:'image-1',sessionId:'session-a'};
  h.handlers.get('screenshot')(first);h.handlers.get('screenshot')(first);assert.equal(h.asks.length,0);assert.match(h.elements.get('captureStatus').textContent,/等待设置/);
  h.initialize({autoAnswer:false,autoScreenshot:true});await tick();assert.equal(h.asks.length,1);assert.equal(h.queued.length,1);assert.equal(h.queued[0].attachmentId,'image-1');assert.equal(h.asks[0].withImage,true);
  h.handlers.get('screenshot')({dataUrl:'data:image/png;base64,two',attachmentId:'image-2',sessionId:'session-a'});await tick();assert.equal(h.queued.length,2);assert.equal(h.asks.length,1);
  h.answers.shift()({ok:true,text:'第一张答案'});await tick();assert.equal(h.asks.length,2);assert.equal(h.queued[1].attachmentId,'image-2');
  h.answers.shift()({ok:true,text:'第二张答案'});await tick();assert.equal(vm.runInContext('history.length',h.context),2);assert.match(h.elements.get('captureStatus').textContent,/已回答/);
});
test('disabled screenshot automation is explicit; stale connection events do not overwrite a successful connection',async()=>{
  const h=harness();h.handlers.get('codex-state')({ok:true,epoch:2,path:'/custom/codex'});h.initialize({autoAnswer:true,autoScreenshot:false});await tick();assert.equal(h.elements.get('connection').textContent,'Codex 已连接');
  h.handlers.get('screenshot')({dataUrl:'data:image/png;base64,one',attachmentId:'image-1',sessionId:'session-a'});await tick();assert.equal(h.asks.length,0);assert.equal(h.queued.length,0);assert.match(h.elements.get('captureStatus').textContent,/自动提问已关闭/);assert.equal(h.elements.get('attachment').hidden,false);
});
