const fs=require('node:fs'),path=require('node:path');const {CodexBridge}=require('../src/codex.cjs');
const root=path.resolve(__dirname,'..','artifacts','cli-project-check');fs.mkdirSync(root,{recursive:true});
const word='PROJECT_READ_'+Date.now();fs.writeFileSync(path.join(root,'README.md'),'本项目的验证词是：'+word+'\n');
const bridge=new CodexBridge({cwd:path.dirname(root)}),activities=[];bridge.on('activity',event=>activities.push(event));
bridge.on('diagnostic',item=>activities.push({command:item.command,exitCode:item.exitCode,output:item.aggregatedOutput}));
(async()=>{try{const answer=await bridge.ask({text:'请读取当前项目 README.md 中的验证词，只回复验证词。',projectRoot:root,model:process.env.TEST_CODEX_MODEL||''});const result={ok:answer.includes(word),answer,activities};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,readCommands:activities.length,answer}));if(!result.ok)process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=1;}finally{bridge.close();}})();
