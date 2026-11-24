const test=require('node:test');const assert=require('node:assert/strict');
const {Segmenter,QuestionAssembler,wavPCM,substantive}=require('../src/speech.js');
function feed(segmenter,seconds,amplitude=0){const sampleRate=16000;for(let i=0;i<seconds*10;i++)segmenter.push(new Float32Array(sampleRate/10).fill(amplitude));}
test('quiet speech is retained and a short pause does not split the question',()=>{
  const packets=[];const s=new Segmenter({sampleRate:16000,onSegment:p=>packets.push(p)});
  feed(s,1,.003);feed(s,.8);feed(s,1,.003);
  assert.equal(packets.length,1);assert.equal(packets[0].final,false);feed(s,1.1);
  assert.equal(packets.filter(p=>p.final).length,1);
  assert.equal(new Set(packets.map(p=>p.utteranceId)).size,1);
});
test('continuous capture keeps quiet audio, short words and the tail on pause',()=>{
  const packets=[];const s=new Segmenter({sampleRate:16000,onSegment:p=>packets.push(p)});
  feed(s,1,.0001);feed(s,.1,.02);s.flush();
  assert.equal(packets.length,1);assert.equal(packets[0].final,true);assert.equal(packets[0].audio.length,44+32000*1.1);
});
test('long utterances keep one id and generate one completed question',()=>{
  const packets=[];const s=new Segmenter({sampleRate:16000,maxSeconds:2,onSegment:p=>packets.push(p)});
  feed(s,5,.02);feed(s,1.5);
  assert.ok(packets.length>=3);assert.equal(new Set(packets.map(p=>p.utteranceId)).size,1);
  assert.equal(packets.filter(p=>p.final).length,1);
  const assembler=new QuestionAssembler();let complete=[];
  packets.forEach((p,i)=>{const result=assembler.accept({...p,text:i===0?'请解释线程池的':i===1?'核心参数和':'拒绝策略？'});if(result.complete)complete.push(result);});
  assert.equal(complete.length,1);assert.equal(complete[0].text,'请解释线程池的核心参数和拒绝策略？');assert.ok(complete[0].shouldAnswer);
  assert.equal(assembler.accept({...packets.at(-1),text:'duplicate'}),null);
});
test('empty tail still closes a long question and two questions remain separate',()=>{
  const a=new QuestionAssembler();assert.equal(a.accept({id:1,utteranceId:1,final:false,text:'Redis 怎么持久化？'}).complete,false);
  const result=a.accept({id:2,utteranceId:1,final:true,text:''});assert.equal(result.text,'Redis 怎么持久化？');assert.ok(result.shouldAnswer);
  assert.equal(a.accept({id:3,utteranceId:2,final:true,text:'什么是联合索引？'}).text,'什么是联合索引？');
  assert.equal(substantive('好的'),false);assert.equal(substantive('能听到吗？'),false);assert.equal(substantive('What is a database?'),true);
  assert.equal(substantive('我先介绍一下我们团队目前的情况'),false);
  assert.equal(substantive('Redis 的持久化原理'),true);
});
test('resampling cancels high frequency energy instead of aliasing it into speech',()=>{
  const input=Float32Array.from({length:4800},(_,i)=>i%2?.5:-.5);
  const wav=wavPCM([input],48000),v=new DataView(wav.buffer);let maximum=0;
  for(let i=44;i<wav.length;i+=2)maximum=Math.max(maximum,Math.abs(v.getInt16(i,true)));
  assert.ok(maximum<6000);assert.equal(v.getUint32(24,true),16000);assert.equal(v.getUint32(40,true),3200);
});
test('short Chinese questions survive filtering while acknowledgements stay excluded',()=>{
  for(const text of ['怎么算？','怎么做？','如何做？','为什么？','多少？'])assert.equal(substantive(text),true,text);
  for(const text of ['好。','好的','嗯','谢谢','不准。'])assert.equal(substantive(text),false,text);
});
