const rl=require('node:readline').createInterface({input:process.stdin});
const send=msg=>process.stdout.write(JSON.stringify(msg)+'\n');
let threadParams,turnParams;
rl.on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize')send({id:m.id,result:{}});
  if(m.method==='model/list')send({id:m.id,result:{data:[{model:'test-model',isDefault:true}]}});
  if(m.method==='thread/start'){threadParams=m.params;send({id:m.id,result:{thread:{id:'test-thread'}}});}
  if(m.method==='test/requests')send({id:m.id,result:{threadParams,turnParams}});
  if(m.method==='turn/start'){
    turnParams=m.params;
    send({id:m.id,result:{turn:{id:'turn-1'}}});
    if(m.params.input[0].text.includes('wait-forever'))return;
    setTimeout(()=>{
      send({method:'item/agentMessage/delta',params:{threadId:'test-thread',delta:'先更新数据库，'}});
      send({method:'item/agentMessage/delta',params:{threadId:'test-thread',delta:'再删除缓存。'}});
      send({method:'turn/completed',params:{threadId:'test-thread',turn:{status:'completed'}}});
    },10);
  }
  if(m.method==='turn/interrupt'){
    send({id:m.id,result:{}});
    send({method:'turn/completed',params:{threadId:'test-thread',turn:{status:'interrupted'}}});
  }
});
