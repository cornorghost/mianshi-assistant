const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

function wavHeader(bytes) {
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
class BailianSpeech extends EventEmitter {
  constructor({ directory, createSocket, timeout = 12000 }) {
    super(); this.directory = directory; this.timeout = timeout;
    this.createSocket = createSocket || ((url, options) => new WebSocket(url, options));
    fs.mkdirSync(directory, { recursive: true }); this.ready = false;
  }
  records() {
    return fs.readdirSync(this.directory).filter(n => n.endsWith('.json')).flatMap(n => {
      try { return Object.values(JSON.parse(fs.readFileSync(path.join(this.directory, n), 'utf8')).sentences || {}); } catch { return []; }
    }).sort((a,b) => a.capturedAt - b.capturedAt || a.id - b.id);
  }
  checkpoint() {
    if (!this.meta) return;
    const target = path.join(this.directory, this.taskId + '.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(this.meta)); fs.renameSync(target + '.tmp', target);
  }
  async start({ key, workspace = '', vocabulary = '', language = 'zh', sessionId }) {
    if (this.socket) await this.drain();
    if (!key) return { ok: false, error: '请在设置中填写百炼北京地域 API Key。' };
    if (workspace && !/^[a-zA-Z0-9-]+$/.test(workspace)) return { ok: false, error: '业务空间 ID 格式不正确' };
    this.taskId = randomUUID(); this.sessionId = sessionId || this.taskId; this.sequence = 0; this.bytes = 0;
    this.accepted = new Set(); this.finalized = new Set(); this.failure = null; this.ready = false; this.finishing = false;
    this.startResolve=null;this.finishResolve=null;this.finishReject=null;
    this.meta = { provider: 'bailian', model: 'paraformer-realtime-v2', startedAt: Date.now(), sessionId:this.sessionId, sentences:{} };
    this.audioPath = path.join(this.directory, this.taskId + '.wav'); fs.writeFileSync(this.audioPath, wavHeader(0)); this.checkpoint();
    const redact = value => String(value).split(key).join('[已隐藏]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
    const fail = message => {
      if (this.failure) return;
      this.failure = new Error(redact(message)); this.ready = false;
      clearTimeout(this.startTimer); clearTimeout(this.finishTimer);
      this.meta.error = this.failure.message; this.checkpoint();
      this.startResolve?.({ ok:false, error:this.failure.message }); this.finishReject?.(this.failure);
      this.emit('status', { type:'error', message:this.failure.message });
      const socket=this.socket;this.socket=null;socket?.terminate();
    };
    this.fail = fail;
    const url = workspace ? `wss://${workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` : 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    const options = { headers:{ Authorization:`Bearer ${key}` }, handshakeTimeout:this.timeout };
    if (workspace) options.headers['X-DashScope-WorkSpace'] = workspace;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
    if (proxy && /^https?:\/\//i.test(proxy)) {
      const { HttpsProxyAgent } = await import('https-proxy-agent'); options.agent = new HttpsProxyAgent(proxy);
    }
    return new Promise(resolve => {
      this.startResolve = resolve;
      this.startTimer = setTimeout(() => fail('百炼连接超时，请检查网络、代理和北京地域 API Key'), this.timeout);
      let socket;
      try { socket = this.socket = this.createSocket(url, options); } catch(e) { fail(e.message); return; }
      socket.on('open', () => {
        const parameters = { format:'pcm', sample_rate:16000, disfluency_removal_enabled:false,
          semantic_punctuation_enabled:false, max_sentence_silence:800, heartbeat:true };
        if (language !== 'auto') parameters.language_hints = language === 'en' ? ['en'] : ['zh','en'];
        if (vocabulary) parameters.vocabulary_id = vocabulary;
        socket.send(JSON.stringify({header:{action:'run-task',task_id:this.taskId,streaming:'duplex'},payload:{task_group:'audio',task:'asr',function:'recognition',model:'paraformer-realtime-v2',parameters,input:{}}}));
      });
      socket.on('message', data => {
        if(this.socket!==socket)return;
        try {
          const event = JSON.parse(data.toString()), header = event.header || {};
          if (header.task_id && header.task_id !== this.taskId) return;
          if (header.event === 'task-started') {
            clearTimeout(this.startTimer); this.ready = true; resolve({ok:true,ready:true}); this.emit('status',{type:'ready'});
          } else if (header.event === 'result-generated') {
            const sentence = event.payload?.output?.sentence;
            if (!sentence || sentence.heartbeat || !Number.isFinite(sentence.begin_time)) return;
            const utteranceId = sentence.begin_time;
            if (this.finalized.has(utteranceId)) return;
            const packet = {type:'transcript',sessionId:this.sessionId,id:++this.sequence,utteranceId,text:String(sentence.text || ''),final:sentence.sentence_end === true,replace:true,capturedAt:this.meta.startedAt + utteranceId};
            if (packet.final) this.finalized.add(utteranceId);
            this.meta.sentences[utteranceId] = packet; this.checkpoint(); this.emit('result',packet);
          } else if (header.event === 'task-finished') {
            if (!this.finishing) { fail('百炼任务提前结束，录音已保存在本机'); return; }
            clearTimeout(this.finishTimer); this.ready = false; this.meta.finishedAt = Date.now(); this.checkpoint();
            this.socket=null;this.finishResolve?.({ok:true}); socket.close();
          } else if (header.event === 'task-failed') fail(`百炼识别失败：${header.error_code || ''} ${header.error_message || '请检查密钥、模型权限或余额'}`);
        } catch(e) { fail('百炼返回结果处理失败：' + e.message); }
      });
      socket.on('error', e => {if(this.socket===socket)fail('百炼连接失败：' + e.message);});
      socket.on('close', () => {
        if(this.socket!==socket)return;
        if (!this.meta.finishedAt && !this.failure) fail('百炼连接已断开，录音与已有文字已保留，请重新开始监听');
        if (this.socket === socket) this.socket = null;
      });
    });
  }
  accept(packet) {
    if (!this.meta || packet.sessionId !== this.sessionId) throw new Error('语音会话不匹配');
    if(!this.ready&&!this.failure)throw new Error('百炼尚未就绪或任务已结束');
    if (this.accepted.has(packet.id)) return {accepted:true};
    const audio = Buffer.from(packet.audio || []);
    if (!Number.isInteger(packet.id) || !audio.length || audio.length > 32000 || audio.length % 2) throw new Error('PCM 音频格式不正确');
    const fd = fs.openSync(this.audioPath, 'r+');
    try { fs.writeSync(fd, audio, 0, audio.length, 44 + this.bytes); this.bytes += audio.length; fs.writeSync(fd,wavHeader(this.bytes),0,44,0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.accepted.add(packet.id);
    // Persist first. A network failure must never delete the final captured tail.
    if (this.ready && !this.finishing && !this.failure) {
      if (this.socket.bufferedAmount > 32000 * 10) this.fail('网络上传积压超过 10 秒，已停止监听；录音已保留');
      else {const fail=this.fail;this.socket.send(audio, {binary:true}, error => { if (error) fail('音频上传失败：' + error.message); });}
    }
    return {accepted:true};
  }
  drain() {
    if (this.finishPromise) return this.finishPromise;
    if (this.failure) return Promise.reject(this.failure);
    if (!this.socket) return Promise.resolve({ok:true});
    this.finishing = true;
    this.finishPromise = new Promise((resolve,reject) => {
      this.finishResolve = resolve; this.finishReject = reject;
      this.finishTimer = setTimeout(() => this.fail('等待百炼尾句超时，录音和已有文字已保留'), this.timeout);
      this.socket.send(JSON.stringify({header:{action:'finish-task',task_id:this.taskId,streaming:'duplex'},payload:{input:{}}}));
    }).finally(() => { this.finishPromise = null; });
    return this.finishPromise;
  }
  close() { clearTimeout(this.startTimer); clearTimeout(this.finishTimer); const socket=this.socket;this.socket=null;socket?.terminate(); }
}
module.exports = { BailianSpeech, wavHeader };
