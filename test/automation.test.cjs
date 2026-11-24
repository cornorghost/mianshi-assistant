const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const SpeechPipeline=require('../src/speech.js');
test('persisted manual mode is visible and the toolbar enables automatic voice answers without replaying old speech',async()=>{
  const elements=new Map(),handlers=new Map(),calls=[],saved=[];let failSave=false;
  const element=()=>({value:'',hidden:false,textContent:'',classList:{add(){},remove(){}},append(){},replaceChildren(){},addEventListener(){}});
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element};
  const api={on:(event,fn)=>handlers.set(event,fn),invoke:async(channel,data)=>{
    if(channel==='init')return {settings:{autoAnswer:false,questionMergeMs:0},codex:{ok:true}};
    if(channel==='settings'){if(failSave)throw new Error('disk full');saved.push(data);return {autoAnswer:data.autoAnswer,questionMergeMs:0};}
    if(channel==='ask'){calls.push(data);return {ok:true,text:'答案'};}
    return true;
  }};
  const context=vm.createContext({window:{copilot:api,SpeechPipeline},document,setInterval(){},setTimeout(){},clearTimeout(){},console,Date,Uint8Array,Float32Array,DataView,ArrayBuffer});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),context);
  const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();
  vm.runInContext("recording=true;captureId='live';updateStatus();",context);
  assert.equal(elements.get('autoAnswerToggle').ariaPressed,'false');assert.match(elements.get('sessionStatus').textContent,/仅转写.*手动/);
  const speech=(id,text,sessionId='live')=>handlers.get('asr')({sessionId,id,utteranceId:id,final:true,replace:true,text});
  speech(1,'什么是数字工厂？');await tick();assert.equal(calls.length,0);
  await elements.get('autoAnswerToggle').onclick();assert.equal(saved[0].autoAnswer,true);assert.equal(elements.get('autoAnswer').checked,true);assert.equal(calls.length,0);
  assert.match(elements.get('sessionStatus').textContent,/问完自动回答/);
  speech(2,'怎么算？');await tick();assert.equal(calls.length,1);assert.equal(calls[0].text,'怎么算？');assert.equal(calls[0].withImage,false);
  speech(2,'怎么算？');speech(3,'如何保证幂等？','old-capture');await tick();assert.equal(calls.length,1);
  failSave=true;await elements.get('autoAnswerToggle').onclick();assert.equal(elements.get('autoAnswerToggle').ariaPressed,'true');assert.equal(elements.get('autoAnswerToggle').disabled,false);
  failSave=false;await elements.get('autoAnswerToggle').onclick();speech(4,'意图识别怎么弄？');await tick();assert.equal(calls.length,1);assert.equal(saved.at(-1).autoAnswer,false);
});
test('auto answer submits once, queues the next whole question, and never attaches a stale screenshot',async()=>{
  const elements=new Map(),calls=[],pending=[],handlers=new Map();
  function element(){return{value:'',hidden:false,textContent:'',classList:{add(){},remove(){}},append(){},replaceChildren(){},addEventListener(){}};}
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:()=>element(),createTextNode:text=>text};
  const api={on:(event,fn)=>handlers.set(event,fn),invoke:(channel,data)=>{
    if(channel==='init')return Promise.resolve({settings:{questionMergeMs:0,autoAnswer:true,asrModel:'small',asrLanguage:'zh'},codex:{ok:true}});
    if(channel==='ask'){calls.push(data);return new Promise(resolve=>pending.push(resolve));}
    return Promise.resolve(true);
  }};
  const context=vm.createContext({window:{copilot:api,SpeechPipeline},document,setInterval(){},setTimeout(){},clearTimeout(){},console,Date,Uint8Array,Float32Array,DataView,ArrayBuffer});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),context);
  await Promise.resolve();vm.runInContext('recording=true;image=true;',context);
  handlers.get('asr')({id:1,utteranceId:1,final:false,text:'解释一下'});assert.equal(calls.length,0);
  handlers.get('asr')({id:2,utteranceId:1,final:true,text:'线程池的拒绝策略？'});await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);assert.equal(calls[0].text,'解释一下线程池的拒绝策略？');assert.equal(calls[0].withImage,false);
  handlers.get('asr')({id:3,utteranceId:2,final:false,text:'如何保证'});
  handlers.get('asr')({id:4,utteranceId:2,final:true,text:'消息不重复消费？'});
  handlers.get('asr')({id:4,utteranceId:2,final:true,text:'消息不重复消费？'});assert.equal(calls.length,1);
  pending.shift()({ok:true,text:'第一题答案'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2);assert.equal(calls[1].text,'如何保证消息不重复消费？');
  pending.shift()({ok:true,text:'第二题答案'});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
  handlers.get('asr')({id:5,utteranceId:3,replace:true,final:false,text:'什么是数据'});
  handlers.get('asr')({id:6,utteranceId:3,replace:true,final:false,text:'什么是数据库索引'});assert.equal(calls.length,2);
  handlers.get('asr')({id:7,utteranceId:3,replace:true,final:true,text:'什么是数据库索引？'});
  await new Promise(r=>setImmediate(r));assert.equal(calls.length,3);assert.equal(calls[2].text,'什么是数据库索引？');
  pending.shift()({ok:true,text:'索引答案'});await new Promise(resolve=>setImmediate(resolve));
});
