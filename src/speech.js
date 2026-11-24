(function(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.SpeechPipeline = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  // Area-averaged resampling avoids aliasing caused by selecting every Nth sample.
  function wavPCM(parts, sampleRate) {
    const merged = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let pos = 0;
    for (const part of parts) { merged.set(part, pos); pos += part.length; }
    const ratio = sampleRate / 16000, length = Math.floor(merged.length / ratio);
    const data = new ArrayBuffer(44 + length * 2), view = new DataView(data);
    const str = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
      const begin = i * ratio, end = (i + 1) * ratio;
      let sum = 0;
      for (let k = Math.floor(begin); k < Math.ceil(end); k++) sum += (merged[k] || 0) * Math.max(0, Math.min(k + 1, end) - Math.max(k, begin));
      const sample = Math.max(-1, Math.min(1, sum / ratio));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return new Uint8Array(data);
  }

  class Segmenter {
    constructor({ sampleRate, onSegment, onVoice = () => {}, endSilence = 1.0, maxSeconds = 2.4, source = 'system' }) {
      Object.assign(this, { sampleRate, onSegment, onVoice, endSilence, maxSeconds, source });
      this.sequence = 0; this.utterance = 1; this.reset();
    }
    reset() { this.parts = []; this.total = 0; this.speechSeen = false; this.silence = 0; this.lastVoiced = false; }
    push(input) {
      const data = new Float32Array(input), duration = data.length / this.sampleRate;
      const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
      // Energy only determines a sentence boundary. It never discards audio.
      const speech = rms > (this.source === 'system' ? .0005 : .002);
      this.parts.push(data); this.total += data.length;
      if (speech) { this.speechSeen = true; this.silence = 0; this.onVoice(rms); } else this.silence += duration;
      this.lastVoiced = speech;
      if (this.speechSeen && this.silence >= this.endSilence) this.emit(true);
      else if (this.total / this.sampleRate >= this.maxSeconds) this.emit(!this.speechSeen);
    }
    emit(final) {
      if (!this.total) return;
      this.onSegment({ id: ++this.sequence, utteranceId: this.utterance, final, capturedAt:Date.now(), audio: wavPCM(this.parts, this.sampleRate) });
      this.parts = []; this.total = 0;
      if (final) { this.utterance++; this.reset(); }
    }
    flush() { this.emit(true); }
  }

  class PcmFramer {
    constructor({sampleRate,onSegment}) {
      this.sampleRate=sampleRate; this.onSegment=onSegment; this.sequence=0;
      this.ratio=sampleRate/16000; this.weight=0; this.sum=0; this.samples=[];
    }
    push(input) {
      for(const value of input) {
        let remaining=1;
        while(remaining>1e-9) {
          const take=Math.min(remaining,this.ratio-this.weight);
          this.sum+=value*take;this.weight+=take;remaining-=take;
          if(this.weight>=this.ratio-1e-9) {
            this.samples.push(Math.max(-1,Math.min(1,this.sum/this.ratio)));this.sum=0;this.weight=0;
            if(this.samples.length===3200)this.emit();
          }
        }
      }
    }
    emit() {
      if(!this.samples.length)return;
      const audio=new Uint8Array(this.samples.length*2),view=new DataView(audio.buffer);
      this.samples.forEach((s,i)=>view.setInt16(i*2,s<0?s*32768:s*32767,true));this.samples=[];
      this.onSegment({id:++this.sequence,audio,capturedAt:Date.now(),pcm:true});
    }
    flush() { if(this.weight>1e-9){this.samples.push(Math.max(-1,Math.min(1,this.sum/this.weight)));this.weight=0;this.sum=0;}this.emit(); }
  }
  function mergeText(first, second) {
    if (!first) return second.trim();
    if (!second) return first;
    const a = first.replace(/\s/g, ''), b = second.replace(/\s/g, '');
    for (let size = Math.min(a.length, b.length, 45); size >= 4; size--) {
      if (a.slice(-size) === b.slice(0, size)) return a + b.slice(size);
    }
    return first + (/\w$/.test(first) && /^\w/.test(second) ? ' ' : '') + second.trim();
  }
  function substantive(text) {
    const clean = text.replace(/[\s，。！？、,.!?]/g, '').toLowerCase();
    if (/^(好[的吧]?|嗯+|啊+|对[的]?|是[的]?|明白[了]?|谢谢[你]?|可以|ok|okay|yes|thankyou|我们开始吧|接下来|能听到吗|听得到吗)$/.test(clean)) return false;
    if (/[\u3400-\u9fff]/.test(clean)) {
      if (clean.length < 4) return /怎么|如何|为何|什么|多少/.test(clean);
      if (/^(我先介绍|今天的面试|请稍等|稍等一下|我这边先|给你.*思考)/.test(clean) && !/[?？]|怎么|如何|为什么|是否|吗|呢/.test(text)) return false;
      const explicit = /[?？]|怎么|如何|为什么|什么|哪些|多少|是否|能否|能不能|谈谈|说说|介绍一下|解释|讲一下|请你|麻烦你|区别|对比|吗|呢/.test(text);
      if (explicit) return true;
      if (/^(我们公司|我们团队|我先介绍|今天的面试|接下来我们|请稍等|稍等一下|我这边先|给你.*思考)/.test(clean)) return false;
      return /^(你|请|假设|如果|给定)/.test(clean) || (clean.length < 28 && /原理|实现|设计|算法|复杂度|持久化|索引|一致性|死锁|事务|线程池|垃圾回收/.test(clean));
    }
    return /\b(what|how|why|when|which|where|explain|describe|compare|design|implement|tell|could|would|can)\b/i.test(text) && text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).length >= 3;
  }
  class QuestionAssembler {
    constructor() { this.parts = new Map(); this.seen = new Set(); }
    accept(packet) {
      const eventKey = (packet.sessionId || 'legacy') + ':' + packet.id;
      if (this.seen.has(eventKey)) return null;
      this.seen.add(eventKey);
      const key = (packet.sessionId || 'legacy') + ':' + packet.utteranceId;
      const text = packet.replace ? (packet.text || '') : mergeText(this.parts.get(key) || '', packet.text || '');
      if (!packet.final) { this.parts.set(key, text); return { text, complete: false, id: key }; }
      this.parts.delete(key);
      return { text, complete: true, shouldAnswer: substantive(text), id: key };
    }
    reset() { this.parts.clear(); this.seen.clear(); }
  }
  // ASR sentence boundaries are acoustic, so hold adjacent sentences briefly
  // and retain a short context lead-in until an answerable question arrives.
  class QuestionGrouper {
    constructor({onQuestion,waitMs=1000,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),now=Date.now}) {
      Object.assign(this,{onQuestion,waitMs,setTimer,clearTimer,now});this.rows=[];this.timer=null;this.lastAt=0;this.draft=false;
    }
    accept(question,packet={}) {
      if(this.lastAt&&this.now()-this.lastAt>20000&&!this.rows.some(r=>r.shouldAnswer))this.rows=[];
      if(!question.complete){this.draft=true;this.clearTimer(this.timer);this.timer=null;return;}
      this.draft=false;this.lastAt=this.now();
      if(question.text&&!/^(好的?[。！!]?|嗯+[。]?|谢谢[。！!]?)$/.test(question.text.trim()))this.rows.push(question);
      if(this.rows.length>12&&!this.rows.some(r=>r.shouldAnswer))this.rows=this.rows.slice(-6);
      this.clearTimer(this.timer);
      if(this.waitMs===0)this.flush();
      else this.timer=this.setTimer(()=>this.flush(),this.waitMs);
    }
    flush(){
      this.clearTimer(this.timer);this.timer=null;
      if(!this.rows.some(r=>r.shouldAnswer))return;
      const rows=this.rows;this.rows=[];
      this.onQuestion({text:rows.map(r=>r.text).join(' '),sourceIds:rows.map(r=>r.id)});
    }
    reset(){this.clearTimer(this.timer);this.timer=null;this.rows=[];this.lastAt=0;this.draft=false;}
  }
  return { wavPCM, Segmenter, PcmFramer, QuestionAssembler, QuestionGrouper, substantive, mergeText };
});
