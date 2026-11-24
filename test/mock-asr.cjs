const readline=require('node:readline');
setTimeout(()=>process.stdout.write(JSON.stringify({type:'ready'})+'\n'),60);
readline.createInterface({input:process.stdin}).on('line',line=>{
  const packet=JSON.parse(line);
  setTimeout(()=>process.stdout.write(JSON.stringify({type:'transcript',text:'普通陈述 '+packet.id,id:packet.id,utteranceId:packet.utteranceId,sessionId:packet.sessionId,final:packet.final})+'\n'),60);
});
