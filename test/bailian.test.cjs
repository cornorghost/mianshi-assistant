const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {once}=require('node:events');
const {WebSocket,WebSocketServer}=require('ws');
const {BailianSpeech}=require('../src/bailian-speech.cjs');const {PcmFramer,QuestionAssembler}=require('../src/speech.js');
const {Credentials}=require('../src/credentials.cjs');
async function fixture(t,onMessage) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bailian-test-'));
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
  const requests=[];let connection;
  server.on('connection',(socket,request)=>{connection=socket;requests.push(request);socket.on('message',(data,binary)=>onMessage(socket,data,binary));});
  const service=new BailianSpeech({directory,timeout:500,createSocket:(_url,options)=>new WebSocket(`ws://127.0.0.1:${server.address().port}`,{headers:options.headers})});
  t.after(()=>{service.close();for(const socket of server.clients)socket.terminate();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,service,requests,get socket(){return connection;}};
}
function send(socket,taskId,event,sentence){socket.send(JSON.stringify({header:{task_id:taskId,event},payload:{output:{sentence}}}));}
test('Bailian handshake, cumulative revisions, final dedupe, durable PCM and late tail on finish',async t=>{
  let taskId,runTask,binaryFrame,finishSeen=false;
  const f=await fixture(t,(socket,data,binary)=>{
    if(binary){binaryFrame=Buffer.from(data);return;}
    const message=JSON.parse(data);taskId=message.header.task_id;
    if(message.header.action==='run-task'){runTask=message;send(socket,taskId,'task-started');}
    else {finishSeen=true;setTimeout(()=>{send(socket,taskId,'result-generated',{begin_time:20,text:'为什么使用数据库索引？',sentence_end:true});send(socket,taskId,'task-finished');},25);}
  });
  const results=[];f.service.on('result',p=>results.push(p));
  assert.deepEqual(await f.service.start({key:'sk-dummy-test-key',sessionId:'test'}),{ok:true,ready:true});
  assert.equal(f.requests[0].headers.authorization,'Bearer sk-dummy-test-key');
  assert.equal(runTask.payload.model,'paraformer-realtime-v2');assert.equal(runTask.payload.parameters.max_sentence_silence,800);
  const pcm=Buffer.from([1,2,3,4]);f.service.accept({id:1,sessionId:'test',audio:pcm});f.service.accept({id:1,sessionId:'test',audio:pcm});
  const wav=fs.readFileSync(f.service.audioPath);assert.equal(wav.readUInt32LE(40),4);assert.deepEqual(wav.subarray(44),pcm);
  const sentence=(text,final=false)=>({begin_time:0,text,sentence_end:final});
  send(f.socket,taskId,'result-generated',sentence('什么是数据'));
  send(f.socket,taskId,'result-generated',sentence('什么是数据库索引？',true));
  send(f.socket,taskId,'result-generated',sentence('什么是数据库索引？',true));
  send(f.socket,taskId,'result-generated',{heartbeat:true,begin_time:10});
  let done=false;const drained=f.service.drain().then(()=>done=true);assert.equal(done,false);await drained;
  assert.equal(finishSeen,true);assert.deepEqual(binaryFrame,pcm);assert.equal(results.length,3);
  const assembler=new QuestionAssembler();assert.equal(assembler.accept(results[0]).complete,false);
  assert.equal(assembler.accept(results[1]).text,'什么是数据库索引？');assert.equal(assembler.accept(results[2]).shouldAnswer,true);
  assert.equal(f.service.records().length,2);assert.equal(f.service.records()[1].final,true);
  assert.equal(await f.service.start({key:'sk-dummy-test-key',sessionId:'second'}).then(r=>r.ok),true);await f.service.drain();
});
test('missing key does not connect; task failure redacts key, preserves audio and permits restart',async t=>{
  let id;
  const f=await fixture(t,(socket,data,binary)=>{if(binary)return;const m=JSON.parse(data);id=m.header.task_id;send(socket,id,'task-started');});
  assert.equal((await f.service.start({key:''})).ok,false);assert.equal(f.requests.length,0);
  await f.service.start({key:'sk-sensitive-test',sessionId:'test'});
  f.service.accept({id:1,sessionId:'test',audio:Buffer.alloc(320)});
  f.socket.send(JSON.stringify({header:{task_id:id,event:'task-failed',error_message:'invalid sk-sensitive-test'}}));
  const [status]=await once(f.service,'status');assert.equal(status.type,'error');assert.ok(!status.message.includes('sk-sensitive-test'));
  await assert.rejects(f.service.drain());assert.equal(fs.statSync(f.service.audioPath).size,364);
  assert.equal((await f.service.start({key:'sk-sensitive-test',sessionId:'new'})).ok,true);
});
test('PCM frames preserve all input across 44.1k chunks and retain a short stop tail',()=>{
  const frames=[];const framer=new PcmFramer({sampleRate:44100,onSegment:p=>frames.push(p)});
  const input=new Float32Array(44100+13).fill(.1);
  for(let i=0;i<input.length;i+=4096)framer.push(input.subarray(i,i+4096));framer.flush();
  assert.equal(frames.length,6);assert.equal(frames[0].audio.length,6400);
  assert.equal(frames.reduce((n,p)=>n+p.audio.length,0)/2,Math.ceil(input.length*16000/44100));
  assert.equal(new DataView(frames[0].audio.buffer).getInt16(0,true),3276);
});
test('credentials are encrypted at rest, never returned as plaintext and reject invalid input',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'credentials-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'key.bin');const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s.split('').reverse().join('')),decryptString:b=>b.toString().split('').reverse().join('')};
  const credentials=new Credentials(file,storage);assert.throws(()=>credentials.save('invalid'));
  assert.deepEqual(credentials.save('sk-test-secret-123'),{configured:true});assert.equal(credentials.key(),'sk-test-secret-123');assert.ok(!fs.readFileSync(file).includes(Buffer.from('sk-test-secret-123')));
  storage.isEncryptionAvailable=()=>false;assert.throws(()=>credentials.save('sk-other-secret-123'));
});
