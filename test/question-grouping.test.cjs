const test=require('node:test'),assert=require('node:assert/strict');const {QuestionGrouper}=require('../src/speech.js');
function fixture(){let time=1000,timer=null;const groups=[];const grouper=new QuestionGrouper({onQuestion:q=>groups.push(q),waitMs:1000,now:()=>time,setTimer:fn=>(timer=fn),clearTimer:()=>{timer=null;}});return{grouper,groups,advance:ms=>time+=ms,fire:()=>{const fn=timer;timer=null;fn?.();}};}
test('a context lead-in and several ASR sentences form one question with exact source references',()=>{
  const f=fixture();f.grouper.accept({id:'s:1',text:'我们有一个订单系统。',complete:true,shouldAnswer:false});f.fire();assert.equal(f.groups.length,0);
  f.grouper.accept({id:'s:2',text:'用户可能重复点击提交。',complete:true,shouldAnswer:false});
  f.grouper.accept({id:'s:3',text:'你会如何',complete:false});f.fire();assert.equal(f.groups.length,0);
  f.grouper.accept({id:'s:3',text:'你会如何保证幂等？',complete:true,shouldAnswer:true});assert.equal(f.groups.length,0);f.fire();
  assert.equal(f.groups.length,1);assert.deepEqual(f.groups[0].sourceIds,['s:1','s:2','s:3']);assert.match(f.groups[0].text,/订单系统.*重复点击.*如何保证幂等/);
  f.grouper.flush();assert.equal(f.groups.length,1);
});
test('separate pauses create separate questions; stale context and acknowledgements are excluded',()=>{
  const f=fixture();f.grouper.accept({id:'s:1',text:'介绍一下索引。',complete:true,shouldAnswer:true});f.fire();
  f.grouper.accept({id:'s:2',text:'好的。',complete:true,shouldAnswer:false});f.fire();
  f.grouper.accept({id:'s:3',text:'接下来谈一个订单系统。',complete:true,shouldAnswer:false});f.fire();f.advance(21000);
  f.grouper.accept({id:'s:4',text:'Redis 如何持久化？',complete:true,shouldAnswer:true});f.grouper.flush();
  assert.equal(f.groups.length,2);assert.equal(f.groups[1].text,'Redis 如何持久化？');
});
