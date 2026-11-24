const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SpeechService}=require('../src/speech-service.cjs');const {wavPCM}=require('../src/speech.js');
const make=directory=>new SpeechService({directory,launcher:()=>({command:process.execPath,args:[path.join(__dirname,'mock-asr.cjs')]})});
const packet=id=>({id,utteranceId:1,sessionId:'capture-test',final:id===3,audio:wavPCM([new Float32Array(1600).fill(.0001)],16000)});
test('accepts and persists every chunk before warmup; pause waits for all queued results',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asr-service-test-'));const service=make(dir);
  try{
    for(let i=1;i<=3;i++)assert.equal(service.accept(packet(i)).accepted,true);
    assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.wav')).length,3);
    const seen=[];service.on('result',r=>seen.push(r));let finished=false;
    const drained=service.drain().then(()=>{finished=true;});assert.equal(finished,false);
    await service.configure({model:'test',language:'zh'});await drained;
    assert.equal(seen.length,3);assert.deepEqual(seen.map(r=>r.id),[1,2,3]);assert.equal(service.records().length,3);
    assert.ok(seen.every(r=>fs.existsSync(r.audioFile)));
  }finally{service.close();await new Promise(r=>setTimeout(r,100));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});}
});
test('unprocessed audio survives restart and duplicate delivery does not duplicate transcripts',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asr-recovery-test-'));let service=make(dir);
  try{
    service.accept(packet(1));service.accept(packet(2));service.close();
    service=make(dir);assert.equal(service.queue.length,2);
    service.accept(packet(1));assert.equal(service.queue.length,2);
    await service.configure({model:'test',language:'zh'});await service.drain();assert.equal(service.records().length,2);
    service.close();service=make(dir);assert.equal(service.records().length,2);assert.equal(service.queue.length,0);
  }finally{service.close();await new Promise(r=>setTimeout(r,100));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});}
});
