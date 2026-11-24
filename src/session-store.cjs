const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const iso=()=>new Date().toISOString();
const stamp=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
function markdown(session,attachmentLink=file=>path.basename(path.dirname(file))+'/'+path.basename(file)){
  const lines=[`# ${session.title}`,`开始时间：${stamp(session.createdAt)}`,`状态：${session.endedAt?'已结束':'进行中'}${session.endedAt?' · '+stamp(session.endedAt):''}`,'## 问题与对应回答'];
  const index=new Map(session.transcripts.map((row,i)=>[row.id,i+1]));
  session.turns.forEach((turn,i)=>{
    lines.push(`### ${i+1}. ${turn.question}`,`提问时间：${stamp(turn.createdAt)} · 来源：${turn.source==='speech'?'语音':turn.source==='screenshot'?'截图':'手动'} · 状态：${{queued:'等待回答',generating:'回答中',completed:'已完成',failed:'失败',interrupted:'已中断'}[turn.status]||turn.status}`);
    if(turn.sourceIds.length)lines.push('对应转写：'+turn.sourceIds.map(id=>`[${index.get(id)||'?'}]`).join('、'));
    if(turn.projectRoot)lines.push('参考项目（CLI 按需读取）：'+turn.projectRoot);
    if(turn.projectWarning)lines.push(turn.projectWarning);
    if(turn.projectSources?.length)lines.push('项目参考：'+turn.projectSources.map(source=>source.path+':'+source.line).join('、'));
    if(turn.attachment)lines.push(`![题目截图](<${attachmentLink(turn.attachment)}>)`);
    lines.push(turn.answer||'（暂无回答）');if(turn.error)lines.push('提示：'+turn.error);
  });
  const unused=(session.screenshots||[]).filter(asset=>!session.turns.some(turn=>turn.attachmentId===asset.id||turn.attachment===asset.path));
  if(unused.length){lines.push('## 其他截图');unused.forEach((asset,i)=>lines.push(`### 截图 ${i+1} · ${stamp(asset.createdAt)}\n\n![会话截图](<${attachmentLink(asset.path)}>)`));}
  lines.push('## 完整转写');session.transcripts.forEach((row,i)=>lines.push(`**[${i+1}] ${stamp(row.capturedAt)}${row.final?'':' · 未定稿'}**\n\n${row.text}`));
  return lines.join('\n\n')+'\n';
}
class SessionStore{
  constructor(directory){
    this.directory=directory;fs.mkdirSync(directory,{recursive:true});this.pointer=path.join(directory,'active.json');
    try{const {id}=JSON.parse(fs.readFileSync(this.pointer,'utf8'));this.current=this.read(id);}catch{}
    if(!this.current)this.create();
    else {for(const turn of this.current.turns)if(turn.status==='generating'){turn.status='interrupted';turn.error='应用退出时回答尚未完成，已保留收到的部分。';}this.persist();}
  }
  file(id,ext='json'){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('会话 ID 无效');return path.join(this.directory,id+'.'+ext);}
  read(id){return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}
  persist(){
    const file=this.file(this.current.id);this.current.updatedAt=iso();
    fs.writeFileSync(file+'.tmp',JSON.stringify(this.current,null,2));fs.renameSync(file+'.tmp',file);
    const doc=this.file(this.current.id,'md');fs.writeFileSync(doc+'.tmp',markdown(this.current));fs.renameSync(doc+'.tmp',doc);
  }
  create({projectRoot=this.current?.projectRoot||''}={}){
    if(this.current)this.persist();
    this.current={version:1,id:randomUUID(),title:'会话记录 · '+stamp(Date.now()),createdAt:iso(),updatedAt:iso(),endedAt:null,projectRoot,transcripts:[],turns:[]};
    this.persist();fs.writeFileSync(this.pointer,JSON.stringify({id:this.current.id}));return this.snapshot();
  }
  snapshot(){return JSON.parse(JSON.stringify(this.current));}
  capture(file){
    const id=randomUUID(),dir=path.join(this.directory,this.current.id+'-attachments');fs.mkdirSync(dir,{recursive:true});
    const target=path.join(dir,id+'.png');fs.copyFileSync(file,target);
    const asset={id,path:target,createdAt:iso()};(this.current.screenshots||=[]).push(asset);this.persist();return {...asset};
  }
  attachmentData(sessionId,id){
    const session=sessionId===this.current.id?this.current:this.read(sessionId),asset=(session.screenshots||[]).find(a=>a.id===id),turn=session.turns.find(t=>t.id===id);
    const file=asset?.path||turn?.attachment;if(!file)throw new Error('未找到本场截图');
    const real=fs.realpathSync(file),relative=path.relative(fs.realpathSync(this.directory),real);
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)||fs.statSync(real).size>20*1024*1024)throw new Error('截图路径或大小无效');
    return 'data:image/png;base64,'+fs.readFileSync(real).toString('base64');
  }
  exportTo(file,sessionId=this.current.id){
    const session=sessionId===this.current.id?this.current:this.read(sessionId),assets=[...new Set([...(session.screenshots||[]).map(a=>a.path),...session.turns.map(t=>t.attachment).filter(Boolean)])];
    const folder=path.basename(file,path.extname(file))+'-assets',links=new Map();
    if(assets.length)fs.mkdirSync(path.join(path.dirname(file),folder),{recursive:true});
    for(const asset of assets){const name=path.basename(asset);fs.copyFileSync(asset,path.join(path.dirname(file),folder,name));links.set(asset,folder+'/'+name);}
    fs.writeFileSync(file,markdown(session,asset=>links.get(asset)));return true;
  }
  activate(id){this.persist();const next=this.read(id);this.current=next;this.persist();fs.writeFileSync(this.pointer,JSON.stringify({id}));return this.snapshot();}
  resume(){this.current.endedAt=null;this.current.resumedAt=iso();this.persist();return this.snapshot();}
  rename(title){title=String(title||'').trim().slice(0,100);if(!title)throw new Error('会话名称不能为空');this.current.title=title;this.persist();return this.snapshot();}
  setProject(root){this.current.projectRoot=root;this.persist();return this.snapshot();}
  importLegacy(records){
    if(!records.length||this.current.turns.length||this.current.transcripts.length)return;
    const {QuestionAssembler}=require('./speech.js'),assembler=new QuestionAssembler(),rows=new Map();
    for(const packet of records){const question=assembler.accept(packet);if(question)rows.set(question.id,{id:question.id,text:question.text,final:question.complete,captureId:packet.sessionId||'legacy',capturedAt:rows.get(question.id)?.capturedAt||packet.capturedAt||Date.now()});}
    this.current.title='旧版恢复转写 · '+stamp(Date.now());this.current.transcripts=[...rows.values()];this.finish();this.create();
  }
  list(){return fs.readdirSync(this.directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).flatMap(n=>{try{const s=this.read(n.slice(0,-5));return [{id:s.id,title:s.title,createdAt:s.createdAt,endedAt:s.endedAt,turns:s.turns.length,transcripts:s.transcripts.length}];}catch{return [];}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  transcript(packet){
    const id=(packet.sessionId||'legacy')+':'+packet.utteranceId;
    let row=this.current.transcripts.find(r=>r.id===id);
    if(!row){row={id,text:'',capturedAt:packet.capturedAt||Date.now()};this.current.transcripts.push(row);}
    if(row.final)return;
    row.text=packet.replace?String(packet.text||''):require('./speech.js').mergeText(row.text,String(packet.text||''));
    row.final=!!packet.final;row.captureId=packet.sessionId||'legacy';this.persist();
  }
  queue({id,question,source='manual',sourceIds=[],attachment,attachmentId}){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('提问 ID 无效');
    const old=this.current.turns.find(t=>t.id===id);if(old)return {...old};
    if(this.current.endedAt)throw new Error('本场面试已结束，请新建会话');
    question=String(question||'').slice(0,16000);if(!question.trim())throw new Error('问题不能为空');
    const turn={id,question,source,sourceIds:[...new Set(sourceIds)].filter(id=>this.current.transcripts.some(r=>r.id===id)),answer:'',status:'queued',createdAt:iso()};
    if(attachmentId){const asset=(this.current.screenshots||[]).find(a=>a.id===attachmentId);if(!asset)throw new Error('未找到当前会话的截图');turn.attachment=asset.path;turn.attachmentId=asset.id;}
    else if(attachment){const asset=this.capture(attachment);turn.attachment=asset.path;turn.attachmentId=asset.id;}
    this.current.turns.push(turn);this.persist();return {...turn};
  }
  update(id,patch){const turn=this.current.turns.find(t=>t.id===id);if(!turn)throw new Error('未找到对应提问');Object.assign(turn,patch);this.persist();return {...turn};}
  finish(){this.current.endedAt=iso();this.persist();return this.snapshot();}
  document(id=this.current.id){return markdown(id===this.current.id?this.current:this.read(id));}
}
module.exports={SessionStore,markdown};
