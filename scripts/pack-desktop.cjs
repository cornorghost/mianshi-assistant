const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const packager=require('@electron/packager'),{downloadArtifact}=require('@electron/get');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const out=path.resolve(root,'dist','build-'+version),release=path.resolve(root,'dist','releases',version);
if(!out.startsWith(root+path.sep)||!release.startsWith(root+path.sep))throw new Error('输出路径不在项目中');
fs.mkdirSync(release,{recursive:true});
const readme=`面试助手 · 应用名 chatbox ${version}\n\n项目名称为“面试助手”，程序名称沿用 chatbox。完整说明见 README.md 和 docs/使用说明.md。\n\nWindows：解压完整文件夹后双击 chatbox.exe，无需安装 Node/Python。\nMac：Apple 芯片选 arm64 包，Intel 选 x64 包。先把整个解压文件夹放到本机可写位置，首次右键“打开”同目录的 启动chatbox.command，它会为本包执行本机临时签名并打开应用；以后可直接打开 chatbox.app。此包没有 Apple 开发者证书/公证，不能宣称已签名发行。\n\n先安装并登录 Codex 桌面版（或安装 CLI 并执行 codex login）；助手会自动检测常见位置。特殊路径可通过环境变量 INTERVIEW_CODEX_PATH 指定。\n百炼北京地域 API Key：Windows 沿用本机已有配置，Mac 首次在设置粘贴一次后加密保存。安装包不含密钥和 Codex 登录信息。\nMac 首次请在系统设置 > 隐私与安全性允许屏幕/系统声音录制和麦克风（使用时）；系统声音建议 macOS 14.2 或更新版本，未在 Mac 实机测试。\n\n顶部会话选择器用于切换，＋新会话不会删除已有会话。左边选问题，右边看对应回答。\n截题默认将鼠标移到两个角分别按 Ctrl+Shift+S（Mac 用 Command）；没有全屏框选覆盖，不接管系统鼠标。Ctrl/Command+Shift+Esc 取消。\n设置参考项目目录后，Codex CLI 可在只读模式自行查看代码；不指定或目录不可用时按通用模式回答。\n\n历史与录音保存在用户应用数据目录，不在安装包内；升级或移动程序不会主动删除历史。\n`;
(async()=>{
  console.log('Building Windows application…');
  const builds=await packager({dir:root,name:'chatbox',platform:'win32',arch:'x64',electronVersion:require('electron/package.json').version,out,overwrite:true,asar:true,prune:true,
    ignore:file=>{const rel=file.replaceAll('\\','/').replace(/^\//,'');if(!rel)return false;return !/^(?:src(?:\/|$)|docs(?:\/|$)|node_modules(?:\/|$)|package\.json$|README\.md$|LICENSE$)/.test(rel);},
    download:{mirrorOptions:{mirror:'https://npmmirror.com/mirrors/electron/'}},win32metadata:{CompanyName:'Local Tools',FileDescription:'chatbox',ProductName:'chatbox',InternalName:'chatbox'}});
  const win=builds[0];fs.writeFileSync(path.join(win,'使用说明.txt'),readme);fs.writeFileSync(path.join(win,'启动chatbox.cmd'),'@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart "" "%~dp0chatbox.exe"\r\n');
  const mac=await Promise.all(['arm64','x64'].map(async arch=>({arch,file:await downloadArtifact({version:require('electron/package.json').version,platform:'darwin',arch,artifactName:'electron',mirrorOptions:{mirror:'https://npmmirror.com/mirrors/electron/'}})})));
  const manifest={version,release,win,asar:path.join(win,'resources','app.asar'),mac,readme};
  const manifestFile=path.join(out,'package-manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const result=spawnSync(process.platform==='win32'?'python':'python3',[path.join(__dirname,'zip-desktop.py'),manifestFile],{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw new Error('压缩包生成失败');
  console.log('Packages ready: '+release);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
