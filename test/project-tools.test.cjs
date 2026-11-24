const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {callProjectTool}=require('../src/project-tools.cjs');
test('CLI project tools list, search and read only requested project files with line numbers',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'project-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'README.md'),'订单系统\nRedis 实现幂等\n');fs.writeFileSync(path.join(root,'.env'),'API_KEY=hidden');fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(root,'.git','config'),'private metadata');
  const listed=callProjectTool(root,'project_list_files');assert.deepEqual(listed.files,['README.md']);
  assert.equal(callProjectTool(root,'project_search',{query:'redis'}).matches[0].line,2);
  assert.match(callProjectTool(root,'project_read_file',{path:'README.md',startLine:2,endLine:2}).content,/^2: Redis/);
  assert.throws(()=>callProjectTool(root,'project_read_file',{path:'.env'}));assert.throws(()=>callProjectTool(root,'project_read_file',{path:'.git/config'}));assert.throws(()=>callProjectTool(root,'project_read_file',{path:os.tmpdir()}));assert.throws(()=>callProjectTool('','project_list_files'));
});
