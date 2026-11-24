const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
function readMacShellPaths(env=process.env,run=execFileSync){
  const shell=/\/bash$/.test(env.SHELL||'')?'/bin/bash':'/bin/zsh';
  const command='printf "\\0CHATBOX_CODEX_PATHS\\0%s\\0%s\\0%s\\0" "$INTERVIEW_CODEX_PATH" "$CODEX_CLI_PATH" "$(command -v codex 2>/dev/null)"';
  try{const output=run(shell,['-ilc',command],{encoding:'utf8',timeout:5000,maxBuffer:256*1024,env});const fields=output.split('\0'),index=fields.indexOf('CHATBOX_CODEX_PATHS');return index<0?[]:fields.slice(index+1,index+4).filter(Boolean);}catch{return [];}
}
function findCodex(options={}){
  const platform=options.platform||process.platform,env=options.env||process.env,home=options.home||os.homedir();
  const exists=options.exists||fs.existsSync,list=options.list||fs.readdirSync,realpath=options.realpath||fs.realpathSync;
  const isFile=options.isFile||(file=>{try{return fs.statSync(file).isFile();}catch{return false;}});
  const p=platform==='win32'?path.win32:path.posix;
  const launch=file=>{try{file=realpath(file);}catch{}return /\.m?js$/i.test(file)?{command:options.execPath||process.execPath,args:[file]}:{command:file,args:[]};};
  const normalize=value=>{let file=String(value||'').trim();if((file.startsWith('"')&&file.endsWith('"'))||(file.startsWith("'")&&file.endsWith("'")))file=file.slice(1,-1);if(file==='~')file=home;else if(/^~[/\\]/.test(file))file=p.join(home,file.slice(2));return file;};
  const first=candidates=>{for(const candidate of candidates.filter(Boolean)){const file=normalize(candidate);const files=[file,...(/\.app\/?$/i.test(file)?['codex','bin/codex','codex-aarch64-apple-darwin','codex-x86_64-apple-darwin'].map(name=>p.join(file,'Contents','Resources',name)):[])];for(const value of files)if(exists(value)&&isFile(value))return launch(value);}};
  if(options.overridePath){const selected=first([options.overridePath]);if(selected)return selected;throw new Error('设置中的 Codex CLI 路径不可用：'+normalize(options.overridePath)+'。请选择 CLI 可执行文件（或 Codex.app），不要选择项目文件夹。');}
  let found=first([env.INTERVIEW_CODEX_PATH,env.CODEX_CLI_PATH,env.CODEX_APP_RUNTIME_CLI_PATH]);if(found)return found;
  if(platform==='win32'){
    try{const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'..','.local-machine.json'),'utf8'));found=first([saved.codexRuntime]);if(found)return found;}catch{}
    if(!options.skipSystemLookup){try{const install=(options.run||execFileSync)('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)'],{encoding:'utf8',timeout:8000,windowsHide:true}).trim();if(install){found=first([p.join(install,'app','resources','codex.exe')]);if(found)return found;}}catch{}}
    const apps=p.join(env.ProgramFiles||'C:\\Program Files','WindowsApps');
    try{found=first(list(apps).filter(n=>n.startsWith('OpenAI.Codex')).sort().reverse().map(n=>p.join(apps,n,'app','resources','codex.exe')));if(found)return found;}catch{}
  }
  if(platform==='darwin'){
    found=first(['/Applications',p.join(home,'Applications')].flatMap(base=>['codex','bin/codex','codex-aarch64-apple-darwin','codex-x86_64-apple-darwin'].map(name=>p.join(base,'Codex.app','Contents','Resources',name))));if(found)return found;
  }
  const dirs=[...(env.PATH||'').split(platform==='win32'?';':':'),p.join(home,'.local','bin'),p.join(home,'.cargo','bin'),p.join(home,'.volta','bin'),p.join(home,'.npm-global','bin'),...(platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin','/usr/bin']:[])].filter(Boolean);
  found=first(dirs.map(dir=>p.join(dir,platform==='win32'?'codex.exe':'codex')));if(found)return found;
  const npmRoots=[env.APPDATA&&p.join(env.APPDATA,'npm','node_modules'),p.join(home,'.npm-global','lib','node_modules'),'/opt/homebrew/lib/node_modules','/usr/local/lib/node_modules',...dirs.flatMap(dir=>[p.join(dir,'node_modules'),p.resolve(dir,'..','lib','node_modules')])].filter(Boolean);
  const nvm=p.join(home,'.nvm','versions','node');try{npmRoots.push(...list(nvm).sort().reverse().map(version=>p.join(nvm,version,'lib','node_modules')));}catch{}
  found=first(npmRoots.map(root=>p.join(root,'@openai','codex','bin','codex.js')));if(found)return found;
  if(platform==='darwin'&&(options.readShellPaths||!options.skipSystemLookup)){found=first((options.readShellPaths||(()=>readMacShellPaths(env)))());if(found)return found;}
  throw new Error('未检测到 Codex。请安装并登录 Codex，或在 chatbox 设置中选择 CLI 文件。Mac 双击启动的应用可能未收到终端中的 INTERVIEW_CODEX_PATH。');
}
module.exports={findCodex,readMacShellPaths};
