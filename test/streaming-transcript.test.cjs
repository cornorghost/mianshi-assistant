const test=require('node:test'),assert=require('node:assert/strict');const {StreamingTranscript}=require('../src/streaming-transcript.cjs');
test('interim revisions replace the draft; only final messages commit an answerable sentence',()=>{
 const parser=new StreamingTranscript();
 assert.equal(parser.accept({text:'什么是数据库？',stopFlag:false,segment:{}}).final,false);
 assert.equal(parser.accept({text:'什么是数据库索引？',stopFlag:false}).text,'什么是数据库索引？');
 assert.equal(parser.sentences.length,0);
 const final={text:'什么是数据库索引？',stopFlag:true,segment:{start:0,end:2040,text:'什么是数据库索引？'}};
 assert.equal(parser.accept(final).committed.endMs,2040);assert.equal(parser.accept(final).duplicate,true);
 parser.accept({text:'如何优化慢查询？',stopFlag:true,segment:{start:2460,end:4700}});
 assert.deepEqual(parser.sentences.map(x=>x.text),['什么是数据库索引？','如何优化慢查询？']);
});
test('complete history is retained and legitimate repeated questions are not discarded',()=>{
 const parser=new StreamingTranscript();for(let i=0;i<150;i++)parser.accept({text:'请解释索引如何工作。',stopFlag:true,segment:{start:i*2000,end:i*2000+1000}});
 assert.equal(parser.sentences.length,150);assert.ok(parser.text().length>1000);
 assert.equal(parser.accept('bad json'),null);
});
