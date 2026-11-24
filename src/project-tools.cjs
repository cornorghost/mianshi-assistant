const fs=require('node:fs'),path=require('node:path');
const skip=new Set(['.git','.ssh','.codex','node_modules','vendor','dist','build','target','.venv','venv','.models','artifacts','coverage','.next','__pycache__']);
const sensitive=name=>/(?:^|[/\\])\.env(?:$|[./\\])|credential|secret|private[-_]?key|api[-_]?key|id_(?:rsa|ed25519|dsa)|\.(?:npmrc|pypirc|netrc)$|\.(?:pem|key|p12|pfx)$/i.test(name);
const schema=properties=>({type:'object',properties,additionalProperties:false});
const definitions=[
  {type:'function',name:'project_list_files',description:'List files inside the user-selected reference project. Read-only. Use this to locate relevant code before answering.',inputSchema:schema({path:{type:'string',description:'Relative subdirectory; omit for project root.'}}),deferLoading:false},
  {type:'function',name:'project_read_file',description:'Read a file from the reference project with line numbers. Read-only; credential files and paths outside the project are blocked.',inputSchema:{...schema({path:{type:'string'},startLine:{type:'integer'},endLine:{type:'integer'}}),required:['path']},deferLoading:false},
  {type:'function',name:'project_search',description:'Search text in reference project files. Query is case-insensitive literal text; | separates alternatives. Returns file names and line numbers.',inputSchema:{...schema({query:{type:'string'},path:{type:'string'}}),required:['query']},deferLoading:false}
];
function safePath(root,relative=''){
  root=fs.realpathSync(root);const file=fs.realpathSync(path.resolve(root,String(relative)));
  const rel=path.relative(root,file);if(path.isAbsolute(rel)||rel==='..'||rel.startsWith('..'+path.sep)||sensitive(rel)||rel.split(path.sep).some(part=>skip.has(part)))throw new Error('只允许读取所选项目内的非凭据文件');
  return file;
}
function filesIn(root,relative=''){
  const base=safePath(root,relative),files=[];
  function walk(dir,depth=0){if(depth>15||files.length>=3000)return;let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const item of entries){if(item.isSymbolicLink()||sensitive(item.name))continue;const file=path.join(dir,item.name);if(item.isDirectory()){if(!skip.has(item.name))walk(file,depth+1);}else files.push(path.relative(root,file));if(files.length>=3000)break;}}
  walk(base);return files;
}
function read(root,name){const file=safePath(root,name),stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw new Error('文件过大或不是普通文件');const text=fs.readFileSync(file,'utf8');if(text.includes('\0'))throw new Error('不读取二进制文件');return text.replace(/^.*(?:password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[=:].*$/gim,'[凭据配置行已省略]').replace(/sk-[a-zA-Z0-9_-]{12,}/g,'[密钥已省略]');}
function callProjectTool(root,name,args={}){
  if(!root)throw new Error('当前会话未指定项目目录');
  if(name==='project_list_files'){const files=filesIn(root,args.path||'');return {files:files.slice(0,400),truncated:files.length>400};}
  if(name==='project_read_file'){const lines=read(root,args.path).split(/\r?\n/),start=Math.max(1,Math.trunc(args.startLine)||1),end=Math.min(lines.length,Math.trunc(args.endLine)||start+199,start+249);return {path:args.path,totalLines:lines.length,content:lines.slice(start-1,end).map((line,i)=>(start+i)+': '+line).join('\n').slice(0,18000)};}
  if(name==='project_search'){const terms=String(args.query||'').toLowerCase().split('|').map(t=>t.trim()).filter(Boolean);if(!terms.length)throw new Error('搜索词不能为空');const matches=[];let bytes=0;for(const file of filesIn(root,args.path||'')){let text;try{text=read(root,file);bytes+=text.length;if(bytes>12*1024*1024)break;}catch{continue;}const lines=text.split(/\r?\n/);for(let i=0;i<lines.length;i++)if(terms.some(term=>lines[i].toLowerCase().includes(term))){matches.push({path:file,line:i+1,text:lines[i].slice(0,350)});if(matches.length>=50)return {matches,truncated:true};}}return {matches,truncated:bytes>12*1024*1024};}
  throw new Error('未知项目工具');
}
module.exports={definitions,callProjectTool};
