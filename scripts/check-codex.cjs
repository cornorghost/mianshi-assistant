const {CodexBridge}=require('../src/codex.cjs');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'copilot-check-'));
const bridge=new CodexBridge({cwd});
bridge.on('delta',d=>process.stdout.write(d));
const timer=setTimeout(()=>{console.error('Codex smoke check timed out');bridge.close();process.exitCode=1;},90000);
(async()=>{
  try {
    const image=process.argv[2];
    const answer=await bridge.ask({text:image?'读出截图中显示的文字，仅回复文字。':'用一句中文解释什么是 Redis。只回答，不使用任何工具。',image});
    if(!answer.trim())throw new Error('Empty model response');
    console.log('\nCodex connection verified.');
  }catch(e){console.error(e.message);process.exitCode=1;}
  finally{clearTimeout(timer);bridge.close();fs.rm(cwd,{recursive:true,force:true,maxRetries:8,retryDelay:250},()=>{});}
})();
