const fs=require('node:fs'),path=require('node:path');
function projectDirectory(value){
  const configuredRoot=String(value||'').trim();if(!configuredRoot)return {root:'',configuredRoot:'',available:false,warning:''};
  try{const root=fs.realpathSync(path.resolve(configuredRoot));if(!fs.statSync(root).isDirectory())throw new Error();fs.accessSync(root,fs.constants.R_OK);return {root,configuredRoot,available:true,warning:''};}
  catch{return {root:'',configuredRoot,available:false,warning:'参考项目文件夹不存在或无法读取，本次按通用模式回答。'};}
}
module.exports={projectDirectory};
