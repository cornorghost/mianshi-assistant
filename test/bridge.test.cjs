const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const {CodexBridge}=require('../src/codex.cjs');
const create=()=>new CodexBridge({cwd:os.tmpdir(),launcher:()=>({command:process.execPath,args:[path.join(__dirname,'mock-server.cjs')]})});
test('initializes, forwards question, aggregates streamed response, and resets context',async()=>{
  const bridge=create(); const deltas=[]; bridge.on('delta',d=>deltas.push(d));
  try {
    const result=await bridge.ask({text:'缓存如何保持一致性？'});
    assert.equal(result,'先更新数据库，再删除缓存。');assert.equal(deltas.length,2);assert.equal(bridge.threadId,'test-thread');
    bridge.reset(); assert.equal(bridge.threadId,null);
  }finally{bridge.close();}
});
test('rejects concurrent requests and interrupts active generation',async()=>{
  const bridge=create();
  try {
    const answer=bridge.ask({text:'wait-forever'});
    const rejected=assert.rejects(answer,/已停止生成/);
    for(let i=0;i<100&&!bridge.turnId;i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(bridge.turnId);await assert.rejects(bridge.ask({text:'second'}),/尚未结束/);
    await bridge.cancel();await rejected;assert.equal(bridge.active,null);
  }finally{bridge.close();}
});
test('selected project directory enables CLI reads without injecting code; general mode disables reads',async()=>{
  const bridge=create();try{
    await bridge.ask({text:'项目怎样保持缓存一致？',projectRoot:os.tmpdir(),conversation:'问：订单如何落库？\n答：通过事务提交。'});
    const request=await bridge.request('test/requests',{});assert.equal(request.threadParams.cwd,os.tmpdir());assert.equal(request.threadParams.sandbox,'read-only');
    const prompt=request.turnParams.input[0].text;assert.equal(request.threadParams.dynamicTools.length,3);assert.equal(request.threadParams.config['tools.shell'],false);assert.match(prompt,/自行只读检索/);assert.match(prompt,/通过事务提交/);
    await bridge.ask({text:'解释数据库索引'});const general=await bridge.request('test/requests',{});assert.equal(general.threadParams.config['tools.shell'],false);assert.match(general.turnParams.input[0].text,/不读取本地项目/);
  }finally{bridge.close();}
});
