const test=require('node:test'),assert=require('node:assert/strict');const {MousePassthrough,shouldIgnore}=require('../src/mouse-passthrough.cjs');
test('body passes clicks through while the titlebar remains interactive across negative monitor coordinates',()=>{
  const base={enabled:true,suspended:false,visible:true,bounds:{x:-1200,y:80,width:1000,height:700},toolbarHeight:46};
  assert.equal(shouldIgnore({...base,point:{x:-1100,y:90}}),false);assert.equal(shouldIgnore({...base,point:{x:-1100,y:126}}),true);assert.equal(shouldIgnore({...base,point:{x:40,y:90}}),true);
  assert.equal(shouldIgnore({...base,suspended:true,point:{x:-1100,y:200}}),false);assert.equal(shouldIgnore({...base,enabled:false,point:{x:-1100,y:200}}),false);
});
test('cursor polling restores toolbar interaction even without forwarded mouse events; settings and disable release native ignore',()=>{
  let point={x:200,y:300};const calls=[],win={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,getContentBounds:()=>({x:100,y:100,width:900,height:600}),setIgnoreMouseEvents:(ignore,options)=>calls.push({ignore,options})};
  const controller=new MousePassthrough({win,getCursor:()=>point});
  try{controller.configure({enabled:true});assert.equal(calls.at(-1).ignore,true);point={x:200,y:110};controller.refresh();assert.equal(calls.at(-1).ignore,false);point={x:200,y:300};controller.refresh();assert.equal(calls.at(-1).ignore,true);controller.configure({mode:'settings'});assert.equal(calls.at(-1).ignore,false);controller.configure({mode:'session'});assert.equal(calls.at(-1).ignore,true);controller.configure({enabled:false});assert.equal(calls.at(-1).ignore,false);assert.equal(controller.timer,null);}finally{controller.dispose();}
});
