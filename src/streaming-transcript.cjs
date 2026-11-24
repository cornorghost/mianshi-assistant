// Independently implemented from observed, redacted WebSocket message shapes.
// This parser does not connect to either vendor or contain any credentials.
class StreamingTranscript {
  constructor(){this.partial='';this.sentences=[];this.finalIds=new Set();}
  accept(message){
    if(typeof message==='string'){try{message=JSON.parse(message);}catch{return null;}}
    if(!message||typeof message.text!=='string')return null;
    if(!message.stopFlag){this.partial=message.text;return{final:false,partial:this.partial,text:this.text()};}
    const text=message.text.trim();if(!text){this.partial='';return{final:true,committed:null,text:this.text()};}
    const segment=message.segment||{};
    // A repeated sentence is valid. Deduplicate only when the server supplies identical timestamps.
    const key=Number.isFinite(segment.start)&&Number.isFinite(segment.end)?segment.start+':'+segment.end+':'+text:null;
    this.partial='';
    if(key&&this.finalIds.has(key))return{final:true,duplicate:true,committed:null,text:this.text()};
    if(key)this.finalIds.add(key);
    const sentence={text,...(Number.isFinite(segment.start)?{startMs:segment.start}:{}),...(Number.isFinite(segment.end)?{endMs:segment.end}:{})};
    this.sentences.push(sentence);return{final:true,committed:sentence,text:this.text()};
  }
  text(){return [...this.sentences.map(x=>x.text),...(this.partial?[this.partial]:[])].join('\n');}
}
module.exports={StreamingTranscript};
