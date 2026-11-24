const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

// Acknowledgement means the audio is on disk, not merely in a renderer queue.
class SpeechService extends EventEmitter {
  constructor({ directory, python, script, launcher }) {
    super(); Object.assign(this, { directory, python, script, launcher });
    fs.mkdirSync(directory, { recursive: true });
    this.queue = []; this.active = null; this.ready = false; this.waiters = [];
    for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.job.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
      if (!fs.existsSync(this.file(job.key,'.result.json'))) this.queue.push(job);
    }
    this.queue.sort((a,b)=>a.capturedAt-b.capturedAt || a.id-b.id);
  }
  file(key, suffix) { return path.join(this.directory,key+suffix); }
  records() {
    return fs.readdirSync(this.directory).filter(n=>n.endsWith('.result.json')).map(n=>JSON.parse(fs.readFileSync(path.join(this.directory,n),'utf8'))).filter(r=>r.text).sort((a,b)=>a.capturedAt-b.capturedAt || a.id-b.id);
  }
  async configure({model,language}) {
    if (this.child && this.model === model && this.language === language) return {ok:true,ready:this.ready};
    if (this.child) { await this.drain(); this.stopChild(); }
    this.model=model; this.language=language; this.failed=null;
    const launch=this.launcher ? this.launcher() : {command:this.python,args:['-u',this.script,'--model',model,'--language',language]};
    this.child=spawn(launch.command,launch.args,{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_DISABLE_SYMLINKS_WARNING:'1'}});
    const child=this.child; let stderr='';
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-1200);});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      if(this.child!==child)return;
      let data;try{data=JSON.parse(line);}catch{return;}
      if(data.type==='ready'){this.ready=true;this.emit('status',data);this.pump();}
      else if(['transcript','empty'].includes(data.type)&&this.active){
        const job=this.active;
        const record={...job,...data,recognizedAt:Date.now(),audioFile:this.file(job.key,'.wav')};
        this.atomic(job.key+'.result.json',record);
        fs.rmSync(this.file(job.key,'.job.json'),{force:true});
        this.active=null;this.emit('result',record);this.progress();this.pump();this.settle();
      }else if(data.type==='error')this.fail(new Error(data.message));
      else this.emit('status',data);
    });
    child.on('error',e=>{if(this.child===child)this.fail(e);});
    child.on('exit',code=>{if(this.child===child)this.fail(new Error('语音服务退出 ('+code+')。'+stderr));});
    return {ok:true,ready:false};
  }
  atomic(name,value){const target=path.join(this.directory,name);fs.writeFileSync(target+'.tmp',JSON.stringify(value));fs.renameSync(target+'.tmp',target);}
  accept(packet){
    if(!(packet.audio instanceof Uint8Array)||packet.audio.byteLength>2000000||packet.audio.byteLength<44||!Number.isInteger(packet.id)||!Number.isInteger(packet.utteranceId))throw new Error('音频片段无效');
    const sessionId=String(packet.sessionId||'legacy');
    const key=crypto.createHash('sha256').update(sessionId+':'+packet.id).digest('hex');
    if(!fs.existsSync(this.file(key,'.wav'))){
      const job={key,id:packet.id,utteranceId:packet.utteranceId,sessionId,final:!!packet.final,capturedAt:packet.capturedAt||Date.now(),duration:(packet.audio.byteLength-44)/32000};
      fs.writeFileSync(this.file(key,'.wav'),Buffer.from(packet.audio));this.atomic(key+'.job.json',job);this.queue.push(job);
    }
    this.progress();this.pump();return {accepted:true,pending:this.queue.length+(this.active?1:0)};
  }
  pump(){
    if(!this.ready||this.active||!this.child||!this.queue.length)return;
    const job=this.active=this.queue.shift();
    try{this.child.stdin.write(JSON.stringify({...job,audio:fs.readFileSync(this.file(job.key,'.wav')).toString('base64')})+'\n');}
    catch(e){this.fail(e);}
  }
  progress(){this.emit('status',{type:'progress',pending:this.queue.length+(this.active?1:0),seconds:this.queue.reduce((n,j)=>n+j.duration,0)+(this.active?.duration||0)});}
  drain(){
    if(!this.active&&!this.queue.length)return Promise.resolve();
    if(this.failed)return Promise.reject(this.failed);
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  settle(){if(!this.active&&!this.queue.length){for(const w of this.waiters)w.resolve();this.waiters=[];}}
  fail(error){
    if(this.active){this.queue.unshift(this.active);this.active=null;}
    this.stopChild();this.failed=error;
    for(const w of this.waiters)w.reject(error);this.waiters=[];
    this.emit('status',{type:'error',message:error.message+'；已接收音频仍保存在本机，重新开始可继续处理。'});
  }
  stopChild(){const p=this.child;this.child=null;this.ready=false;p?.kill();}
  close(){this.stopChild();for(const w of this.waiters)w.reject(new Error('语音服务已关闭，未处理音频将在下次启动恢复'));this.waiters=[];}
}
module.exports={SpeechService};
