const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const SpeechPipeline=require('../src/speech.js');
test('pause commits its PCM tail, waits for late transcripts, and export includes non-question speech',async()=>{
  const elements=new Map(),handlers=new Map();let commit,drain,exported='',stopRequested=false;
  const element=()=>({value:'',hidden:false,textContent:'',classList:{add(){},remove(){}},append(){},replaceChildren(){},addEventListener(){}});
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:()=>element(),createTextNode:t=>t};
  const api={on:(name,fn)=>handlers.set(name,fn),invoke:(channel,data)=>{
    if(channel==='init')return Promise.resolve({settings:{autoAnswer:true},codex:{ok:true},transcripts:[]});
    if(channel==='asr-audio')return new Promise(resolve=>{commit=resolve;});
    if(channel==='asr-stop'){stopRequested=true;return new Promise(resolve=>{drain=resolve;});}
    if(channel==='export'){exported=data;return Promise.resolve(true);}
    return Promise.resolve(true);
  }};
  const context=vm.createContext({window:{copilot:api,SpeechPipeline},document,setInterval(){},setTimeout,clearTimeout,console,Date,Uint8Array,Float32Array,DataView,ArrayBuffer});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8'),context);await Promise.resolve();
  vm.runInContext("recording=true;captureId='pause-test';segmenter={flush(){audioQueue.push({id:1,utteranceId:1,sessionId:'pause-test',final:true,audio:new Uint8Array(44)});}};",context);
  const stopped=vm.runInContext('stopListening()',context);let finished=false;stopped.then(()=>{finished=true;});
  assert.equal(stopRequested,false);assert.equal(finished,false);assert.ok(commit);
  commit({accepted:true});
  for(let i=0;i<100&&!stopRequested;i++)await new Promise(r=>setTimeout(r,5));assert.equal(stopRequested,true);assert.equal(finished,false);
  handlers.get('asr')({id:1,utteranceId:1,sessionId:'pause-test',final:true,text:'今天我们讨论接口上线计划。'});
  handlers.get('asr')({id:2,utteranceId:2,sessionId:'pause-test',final:true,text:'好的。'});
  drain();await stopped;
  assert.equal(vm.runInContext('transcriptRows.size',context),2);
  await elements.get('export').onclick();assert.match(exported,/今天我们讨论接口上线计划/);assert.match(exported,/好的/);assert.match(exported,/完整转写/);
  // Clear the notification timer so this test does not retain the process.
  vm.runInContext('clearTimeout(toastTimer)',context);
});
