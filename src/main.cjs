const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, globalShortcut, dialog, clipboard, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexBridge,findCodex } = require('./codex.cjs');
const { SpeechService } = require('./speech-service.cjs');
const { BailianSpeech } = require('./bailian-speech.cjs');
const { Credentials } = require('./credentials.cjs');
const { SessionStore } = require('./session-store.cjs');
const {MousePassthrough}=require('./mouse-passthrough.cjs');
const {projectDirectory}=require('./project-directory.cjs');
const ROOT = path.join(__dirname, '..');
app.setName('chatbox');
// Retain the existing data location so renaming never loses history or encrypted keys.
app.setPath('userData',path.join(app.getPath('appData'),'interview-copilot-local'));
if(process.argv.some(flag=>['--package-check','--mouse-integration','--history-integration','--smoke'].includes(flag)))app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'copilot-package-check-')));
let win, bridge, overlay, selection, speechService, settings, stateFile, scratch;
let pointSelection=null,pointTimer=null,mouseTestPoint=null;
let connectionEpoch=0,codexState={ok:false,connecting:false,epoch:0};
let imagePath = null, cloudSpeech, credentials, activeAsr, sessions, activeRequest, mousePassthrough;
const defaults = { settingsVersion: 3, asrProvider: 'bailian', bailianWorkspace: '', bailianVocabulary: '', model: '', context: '', style: '用中文，先给结论，控制在 3–5 个要点；代码题给代码和复杂度。', protection: true, top: true, mousePassthrough:false, opacity: 1, audioSource: 'system', autoAnswer: true, autoScreenshot:true, questionMergeMs:1000, captureMode:'points', projectRoot:'',codexPath:'', asrModel: 'small', asrLanguage: 'zh' };
function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function save() { fs.writeFileSync(stateFile, JSON.stringify(settings, null, 2)); }
function applySettings() { win.setAlwaysOnTop(settings.top||settings.mousePassthrough);mousePassthrough?.configure({enabled:settings.mousePassthrough}); win.setContentProtection(settings.protection); win.setOpacity(settings.opacity); }
function stopAsr() { speechService?.close(); cloudSpeech?.close(); }
function cancelSelection() {
  const old = overlay; overlay = null; selection = null; old?.destroy();
  if (win && !win.isDestroyed()) win.show();
}
async function captureDrag() {
  if (overlay) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.hide();
  try {
    await new Promise(r => setTimeout(r, 220));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const source = sources.find(s => s.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取当前显示器截图');
    selection = { image: source.thumbnail, display };
    overlay = new BrowserWindow({ ...display.bounds, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    overlay.setContentProtection(settings.protection);
    overlay.setMenuBarVisibility(false);
    overlay.webContents.on('did-finish-load', () => overlay?.webContents.send('screenshot', source.thumbnail.toDataURL()));
    await overlay.loadFile(path.join(__dirname, 'capture.html'));
  } catch (e) { cancelSelection(); throw e; }
}
function cancelPoints(message='已取消截题'){
  pointSelection=null;clearTimeout(pointTimer);send('shortcut',{type:'capture-status',message});
}
async function capture({fromButton=false}={}){
  if(settings.captureMode==='drag')return captureDrag();
  if(fromButton){if(pointSelection)return cancelPoints();send('shortcut',{type:'capture-status',message:'把鼠标移到题目左上角按 '+(process.platform==='darwin'?'⌘':'Ctrl')+'+Shift+S，再移到右下角按一次；期间指针照常使用。'});return {pending:true};}
  const cursor=screen.getCursorScreenPoint(),display=screen.getDisplayNearestPoint(cursor);
  if(!pointSelection){
    pointSelection={cursor,display};clearTimeout(pointTimer);pointTimer=setTimeout(()=>cancelPoints('截题已超时，可重新标记两个角'),30000);
    send('shortcut',{type:'capture-status',message:'第一个角已标记。移到另一个角按 '+(process.platform==='darwin'?'⌘':'Ctrl')+'+Shift+S；同组合加 Esc 取消。'});return {pending:true};
  }
  const first=pointSelection;pointSelection=null;clearTimeout(pointTimer);
  if(first.display.id!==display.id)throw new Error('请在同一块屏幕上标记题目的两个角');
  return finishPointCapture(first,cursor,display);
}
async function finishPointCapture(first,cursor,display,notify=true){
  const left=Math.min(first.cursor.x,cursor.x),top=Math.min(first.cursor.y,cursor.y),width=Math.abs(cursor.x-first.cursor.x),height=Math.abs(cursor.y-first.cursor.y);
  if(width<8||height<8)throw new Error('选区太小，请重新标记两个角');
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)}});
  const source=sources.find(s=>s.display_id===String(display.id));if(!source||source.thumbnail.isEmpty())throw new Error('无法获取当前显示器截图');
  const size=source.thumbnail.getSize(),sx=size.width/display.size.width,sy=size.height/display.size.height;
  const x=Math.max(0,Math.round((left-display.bounds.x)*sx)),y=Math.max(0,Math.round((top-display.bounds.y)*sy));
  const cropped=source.thumbnail.crop({x,y,width:Math.min(size.width-x,Math.round(width*sx)),height:Math.min(size.height-y,Math.round(height*sy))});
  imagePath=path.join(scratch,`capture-${Date.now()}.png`);fs.writeFileSync(imagePath,cropped.toPNG());if(notify)publishScreenshot(cropped.toDataURL());return {ok:true,width:cropped.getSize().width,height:cropped.getSize().height};
}
function publishScreenshot(dataUrl){const asset=sessions.capture(imagePath);imagePath=asset.path;send('screenshot',{dataUrl,attachmentId:asset.id,sessionId:sessions.current.id});}
function toggleMousePassthrough(){settings.mousePassthrough=!settings.mousePassthrough;save();applySettings();return mousePassthrough.state();}
function resetCodexState(){codexState={ok:false,connecting:false,epoch:++connectionEpoch};bridge.close();}
function connectCodex(){
  const epoch=++connectionEpoch;codexState={ok:false,connecting:true,epoch};send('codex-state',codexState);
  return new Promise(resolve=>setImmediate(resolve)).then(()=>bridge.start()).then(()=>({ok:true,connecting:false,epoch,model:settings.model||bridge.defaultModel,path:bridge.commandPath}),error=>({ok:false,connecting:false,epoch,error:error.message})).then(state=>{if(epoch===connectionEpoch){codexState=state;send('codex-state',state);}return state;});
}
function registerIPC() {
  ipcMain.handle('mouse-toggle',event=>{if(event.sender!==win.webContents)throw new Error('无效窗口');return toggleMousePassthrough();});
  ipcMain.handle('mouse-region',(event,value)=>{if(event.sender!==win.webContents)return;const mode=['session','settings','history','image'].includes(value?.mode)?value.mode:'session';mousePassthrough.configure({mode,toolbarHeight:(Number(value?.height)||46)*win.webContents.getZoomFactor()});return mousePassthrough.state();});
  ipcMain.handle('init', async () => {
    if(!codexState.connecting&&(!codexState.ok||!bridge.child))connectCodex();
    return { settings:{...settings,projectRoot:sessions.current.projectRoot||''}, codex:{...codexState}, root: ROOT, platform:process.platform, asrInstalled: fs.existsSync(pythonPath()), interview:sessions.snapshot(), sessions:sessions.list(), transcripts:[], credentials:credentials.status(), asrReady:activeAsr?.ready || false };
  });
  ipcMain.handle('settings', (_, value) => {
    if(typeof value.codexPath==='string'&&value.codexPath.trim()!==(settings.codexPath||'')){if(activeRequest)throw new Error('请先停止当前回答，再修改 Codex CLI 路径');resetCodexState();}
    if(typeof value.projectRoot==='string'){const root=value.projectRoot.trim();const info=root?projectDirectory(root):{root:''};settings.projectRoot=root;sessions.setProject(root);}
    for (const k of ['model','context','style','audioSource','asrModel','asrLanguage','asrProvider','bailianWorkspace','bailianVocabulary','captureMode','codexPath']) if (typeof value[k] === 'string') settings[k] = value[k].slice(0, k === 'context' ? 22000 : 2000);
    for (const k of ['protection','top','autoAnswer','autoScreenshot','mousePassthrough']) if (typeof value[k] === 'boolean') settings[k] = value[k];
    if (typeof value.opacity === 'number') settings.opacity = Math.min(1, Math.max(.35, value.opacity));
    if(typeof value.questionMergeMs==='number')settings.questionMergeMs=Math.max(0,Math.min(4000,value.questionMergeMs));
    save(); applySettings(); return settings;
  });
  ipcMain.handle('codex-pick',async()=>{const result=await dialog.showOpenDialog(win,{title:'选择 Codex CLI 文件或 Codex.app',properties:['openFile']});return result.canceled?null:result.filePaths[0];});
  ipcMain.handle('codex-detect',async(_,value)=>{if(activeRequest)throw new Error('请先停止当前回答再检测 CLI');settings.codexPath=String(value||'').trim();save();resetCodexState();return connectCodex();});
  ipcMain.handle('project-pick',async()=>{const result=await dialog.showOpenDialog(win,{title:'选择回答参考的项目文件夹',properties:['openDirectory']});if(result.canceled)return null;return projectDirectory(result.filePaths[0]);});
  ipcMain.handle('project-info',(_,root)=>root?projectDirectory(root):{root:'',files:0});
  ipcMain.handle('session-switch',(_,id)=>{if(activeRequest)throw new Error('请先停止当前回答');bridge.reset();imagePath=null;return sessions.activate(id);});
  ipcMain.handle('session-resume',()=>sessions.resume());
  ipcMain.handle('session-rename',(_,title)=>sessions.rename(title));
  ipcMain.handle('session-list',()=>sessions.list());
  ipcMain.handle('session-attachment',(_,data)=>sessions.attachmentData(data.sessionId,data.attachmentId||data.turnId));
  ipcMain.handle('session-get',(_,id)=>id===sessions.current.id?sessions.snapshot():sessions.read(id));
  ipcMain.handle('session-new',()=>{if(activeRequest)throw new Error('请等待当前回答结束');bridge.reset();imagePath=null;return sessions.create();});
  ipcMain.handle('session-end',()=>{if(activeRequest)throw new Error('请等待当前回答结束');return sessions.finish();});
  ipcMain.handle('turn-queue',(_,data)=>sessions.queue({...data,attachment:data.withImage&&!data.attachmentId?imagePath:null}));
  ipcMain.handle('ask', async (_, data) => {
    if(activeRequest)return {ok:false,error:'已有问题正在回答'};
    if(sessions.current.endedAt)return {ok:false,error:'本场面试已结束，请新建会话'};
    let request;
    try {
      const id=data.turnId||('manual-'+Date.now());
      let turn=sessions.current.turns.find(t=>t.id===id);
      if(!turn)turn=sessions.queue({id,question:data.text||'截图提问',source:data.withImage?'screenshot':'manual',attachment:data.withImage&&!data.attachmentId?imagePath:null});
      request=activeRequest={id,answer:'',lastSaved:Date.now()};
      sessions.update(id,{status:'generating',startedAt:new Date().toISOString()});
      const project=projectDirectory(sessions.current.projectRoot||'');
      const conversation=sessions.current.turns.filter(t=>t.id!==id&&t.status==='completed').slice(-6).map(t=>'问：'+t.question+'\n答：'+t.answer.slice(0,2000)).join('\n\n');
      sessions.update(id,{projectRoot:project.root||'',projectMode:project.root?'cli':'general',projectWarning:project.warning});
      const text=await bridge.ask({...settings,text:turn.question,image:turn.attachment||null,projectRoot:project.root||'',conversation});
      const saved=sessions.update(id,{answer:text,status:'completed',projectActivities:request.activities||[],completedAt:new Date().toISOString(),error:null});
      return {ok:true,text,turn:saved};
    } catch(e) {
      if(request)sessions.update(request.id,{answer:request.answer,status:'failed',error:e.message,completedAt:new Date().toISOString()});
      return {ok:false,error:e.message,partial:request?.answer||''};
    } finally { if(activeRequest===request)activeRequest=null; }
  });
  ipcMain.handle('cancel', () => bridge.cancel());
  ipcMain.handle('reset', () => { bridge.reset(); imagePath = null; return true; });
  ipcMain.handle('capture', (_,data) => capture(data));
  ipcMain.handle('crop', (event, rect) => {
    if (!overlay || event.sender !== overlay.webContents) throw new Error('无截图选区');
    if (!rect) { cancelSelection(); return; }
    try {
      const { image, display } = selection; const size = image.getSize();
      const sx = size.width / display.size.width, sy = size.height / display.size.height;
      const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x * sx)));
      const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y * sy)));
      const width = Math.min(size.width - x, Math.round(rect.width * sx));
      const height = Math.min(size.height - y, Math.round(rect.height * sy));
      if (width < 8 || height < 8) throw new Error('选区太小，请重新截图');
      const cropped = image.crop({ x, y, width, height });
      imagePath = path.join(scratch, `capture-${Date.now()}.png`); fs.writeFileSync(imagePath, cropped.toPNG());
      publishScreenshot(cropped.toDataURL());
    } finally { setTimeout(cancelSelection, 50); }
  });
  ipcMain.handle('window', (_, action) => {
    if (action === 'minimize') win.minimize();
    if (action === 'close') win.close();
    if (action === 'copy') clipboard.writeText('');
  });
  ipcMain.handle('export', async (_, content) => {
    const result = await dialog.showSaveDialog(win, { defaultPath: `会话记录-${new Date().toISOString().slice(0,10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!result.canceled){if(content?.sessionId)sessions.exportTo(result.filePath,content.sessionId);else fs.writeFileSync(result.filePath,String(content));}
    return !result.canceled;
  });
  ipcMain.handle('credentials', (_, data) => data?.key ? credentials.save(data.key) : credentials.status());
  ipcMain.handle('asr-start', (_, data) => startAsr(data));
  ipcMain.handle('asr-stop', () => activeAsr?.drain());
  ipcMain.handle('asr-audio', (_, data) => { if(!activeAsr)throw new Error('请先开始监听');return activeAsr.accept(data); });
}
function pythonPath() { return process.platform==='win32'?path.join(ROOT,'.venv','Scripts','python.exe'):path.join(ROOT,'.venv','bin','python3'); }
async function startAsr(data = {}) {
  if(settings.asrProvider === 'bailian') {
    activeAsr=cloudSpeech;
    try { return await cloudSpeech.start({key:credentials.key(),workspace:settings.bailianWorkspace.trim(),vocabulary:settings.bailianVocabulary.trim(),language:settings.asrLanguage,sessionId:data.sessionId}); }
    catch(e) { return {ok:false,error:e.message}; }
  }
  activeAsr=speechService;
  if (!fs.existsSync(pythonPath())) return { ok: false, error: app.isPackaged?'当前安装包使用百炼识别，本地 Whisper 需另行安装源码环境。':'请先安装本地转写依赖，或在设置中切换百炼。' };
  return speechService.configure({model:settings.asrModel,language:settings.asrLanguage});
}
app.whenReady().then(async () => {
  app.setAppUserModelId('local.chatbox');
  stateFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    settings = { ...defaults, ...stored };
    if (stored.settingsVersion !== 3) Object.assign(settings, { settingsVersion: 3, asrProvider:'bailian' });
  } catch { settings = { ...defaults }; }
  save();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-copilot-'));
  const archive = process.argv.some(x=>['--mouse-integration','--history-integration','--speech-integration','--smoke','--integration','--latency-test'].includes(x)) ? path.join(scratch,'speech') : path.join(app.getPath('userData'),'speech-archive');
  speechService=new SpeechService({directory:archive,python:pythonPath(),script:path.join(ROOT,'scripts/asr.py')});
  sessions=new SessionStore(path.join(archive,'interviews'));
  const archiveSpeech=data=>{sessions.transcript(data);send(data.type==='transcript'?'asr':'asr-status',data);};
  speechService.on('result',archiveSpeech);
  speechService.on('status',data=>send('asr-status',data));
  credentials=new Credentials(path.join(app.getPath('userData'),'bailian-key.bin'),safeStorage);
  cloudSpeech=new BailianSpeech({directory:path.join(archive,'bailian')});
  cloudSpeech.on('result',archiveSpeech);cloudSpeech.on('status',data=>send('asr-status',data));
  const migration=path.join(archive,'interview-history-migrated');
  if(!fs.existsSync(migration)){sessions.importLegacy([...speechService.records(),...cloudSpeech.records()].sort((a,b)=>(a.capturedAt||0)-(b.capturedAt||0)));fs.writeFileSync(migration,'1');}
  bridge = new CodexBridge({ cwd: scratch,launcher:()=>findCodex({overridePath:settings.codexPath}), ...(process.argv.some(flag=>['--mouse-integration','--history-integration'].includes(flag))?{launcher:()=>({command:process.execPath,args:[path.join(ROOT,'test/mock-server.cjs')]})}:{}) }); bridge.on('delta', d => {if(activeRequest){activeRequest.answer+=d;if(Date.now()-activeRequest.lastSaved>=400){sessions.update(activeRequest.id,{answer:activeRequest.answer});activeRequest.lastSaved=Date.now();}}send('delta',d);});
  bridge.on('activity',data=>{if(activeRequest){(activeRequest.activities||=[]).push(data);send('model-activity',data);}});
  win = new BrowserWindow({ width: 1120, height: 760, minWidth: 800, minHeight: 540, frame: false, backgroundColor: '#fafaf9', title: 'chatbox', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling:false } });
  mousePassthrough=new MousePassthrough({win,getCursor:()=>mouseTestPoint||screen.getCursorScreenPoint(),onChange:state=>send('mouse-state',state)});
  win.setMenuBarVisibility(false); applySettings();
  win.on('closed',()=>mousePassthrough.dispose());
  const testConsole=[];
  if(process.argv.includes('--history-integration'))win.webContents.on('console-message',(_event,...details)=>testConsole.push(details));
  let closing=false;
  win.on('close',event=>{
    if(closing)return;
    event.preventDefault();
    // Flush the renderer's final PCM tail before terminating the warm worker.
    const timeout=new Promise(resolve=>setTimeout(resolve,15000));
    Promise.race([win.webContents.executeJavaScript('stopListening()').catch(()=>{}),timeout]).finally(()=>{closing=true;win.close();});
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc === win.webContents && ['media','display-capture'].includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (_, callback) => {
    try { const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }); callback({ video: sources[0], audio: 'loopback' }); }
    catch { callback({}); }
  },{useSystemPicker:process.platform==='darwin'});
  registerIPC();
  globalShortcut.register('CommandOrControl+Shift+S', () => capture().catch(e => send('shortcut', { type: 'error', message: e.message })));
  globalShortcut.register('CommandOrControl+Shift+P',toggleMousePassthrough);
  globalShortcut.register('CommandOrControl+Shift+Space', () => send('shortcut', { type: 'ask' }));
  globalShortcut.register('CommandOrControl+Shift+Escape',()=>{if(pointSelection)cancelPoints();else if(overlay)cancelSelection();});
  globalShortcut.register('CommandOrControl+Shift+H', () => win.isVisible() ? win.hide() : win.show());
  await win.loadFile(path.join(__dirname, 'index.html'));
  if(process.argv.includes('--mouse-integration')){
    const report={};
    try{
      await bridge.start();await new Promise(r=>setTimeout(r,200));const bounds=win.getContentBounds();
      mouseTestPoint={x:bounds.x+120,y:bounds.y+150};
      await win.webContents.executeJavaScript("api.invoke('settings',{mousePassthrough:true,top:false}).then(value=>{settings=value;loadSettings();})");
      mousePassthrough.refresh();report.bodyIgnored=mousePassthrough.state().ignoring;report.forcedTop=win.isAlwaysOnTop();
      mouseTestPoint={x:bounds.x+120,y:bounds.y+20};mousePassthrough.refresh();report.toolbarInteractive=!mousePassthrough.state().ignoring;
      mouseTestPoint={x:bounds.x+120,y:bounds.y+150};
      await win.webContents.executeJavaScript("showView('settings');api.invoke('mouse-region',{mode:'settings',height:46})");
      report.settingsInteractive=!mousePassthrough.state().ignoring&&mousePassthrough.state().suspended;
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(ROOT,'artifacts/mouse-settings.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("showView('session');api.invoke('mouse-region',{mode:'session',height:46})");report.resumed=mousePassthrough.state().ignoring;
      await win.webContents.executeJavaScript("document.getElementById('passThroughToggle').onclick()");
      report.disabled=!mousePassthrough.state().ignoring&&!settings.mousePassthrough;report.topPreferenceRestored=!win.isAlwaysOnTop();
      report.persisted=JSON.parse(fs.readFileSync(stateFile,'utf8')).mousePassthrough===false;
      report.ok=Object.values(report).every(value=>value===true);
    }catch(e){report.ok=false;report.error=e.stack;}
    fs.writeFileSync(path.join(ROOT,'artifacts/mouse-integration.json'),JSON.stringify(report,null,2));app.quit();
  }
  if(process.argv.includes('--package-check')){
    const report={packaged:app.isPackaged,version:app.getVersion()};
    try{await bridge.start();report.codex=true;report.cliPath=bridge.commandPath;await new Promise(r=>setTimeout(r,800));report.ui=await win.webContents.executeJavaScript('({title:document.title,sessions:document.getElementById("sessionPicker").options.length,layout:getComputedStyle(document.querySelector(".workspace")).display,provider:settings.asrProvider})');report.ok=report.codex&&report.ui.layout==='grid';}
    catch(e){report.ok=false;report.error=e.message;}
    fs.writeFileSync(path.join(os.tmpdir(),'copilot-package-check.json'),JSON.stringify(report,null,2));app.quit();
  }
  if(settings.asrProvider==='local') Promise.resolve(startAsr()).catch(e=>send('asr-status',{type:'error',message:e.message}));
  if (process.argv.includes('--history-integration')) {
    const output={};const artifacts=path.join(ROOT,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
    try{
      output.step='initialize';
      for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('!!interview'))break;await new Promise(r=>setTimeout(r,30));}
      const project=path.join(scratch,'fixture-project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'OrderService.java'),'class OrderService {\n  // 订单幂等校验\n  boolean idempotent(String key){ return cache.setIfAbsent(key); }\n}');sessions.setProject(project);sessions.rename('示例公司 A · 一面');
      output.step='grouping';
      output.grouping=await win.webContents.executeJavaScript("(()=>{try{settings.questionMergeMs=100;configureGrouping();recording=true;captureId='history-fixture';return {ok:true};}catch(e){return {error:e.stack};}})()");
      if(!output.grouping.ok)throw new Error(output.grouping.error);
      archiveSpeech({type:'transcript',sessionId:'history-fixture',id:1,utteranceId:0,text:'假设一个订单系统允许用户重复提交。',final:true,replace:true,capturedAt:Date.now()});
      archiveSpeech({type:'transcript',sessionId:'history-fixture',id:2,utteranceId:1000,text:'如何保证接口幂等，并保持缓存一致性？',final:true,replace:true,capturedAt:Date.now()+1000});
      for(let i=0;i<150;i++){if(sessions.current.turns[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,30));}
      output.turns=sessions.current.turns.length;output.question=sessions.current.turns[0]?.question;output.answer=sessions.current.turns[0]?.answer;output.sourceIds=sessions.current.turns[0]?.sourceIds;
      output.projectRequest=await bridge.request('test/requests',{});
      output.projectRoot=sessions.current.turns[0]?.projectRoot;
      await win.webContents.executeJavaScript('stopListening()');
      const imageFixture=new BrowserWindow({show:false,width:520,height:220,webPreferences:{sandbox:true}});
      await imageFixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="font:22px sans-serif;padding:25px;background:white"><h3>示例截图题</h3><p>Redis 缓存与数据库如何保持一致？</p></body></html>'));
      await new Promise(r=>setTimeout(r,100));const screenshotFile=path.join(scratch,'question-image.png');fs.writeFileSync(screenshotFile,(await imageFixture.webContents.capturePage()).toPNG());imageFixture.destroy();
      const screenshotAsset=sessions.capture(screenshotFile);
      send('screenshot',{dataUrl:'data:image/png;base64,'+fs.readFileSync(screenshotAsset.path).toString('base64'),attachmentId:screenshotAsset.id,sessionId:sessions.current.id});
      for(let i=0;i<100;i++){if(sessions.current.turns.at(-1)?.attachmentId===screenshotAsset.id&&sessions.current.turns.at(-1)?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
      const original=sessions.current.id;
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('!!interview'))break;await new Promise(r=>setTimeout(r,30));}
      output.restored=await win.webContents.executeJavaScript('({turns:history.length,answer:history[0]?.answer,transcripts:transcriptRows.size})');
      await win.webContents.executeJavaScript('document.getElementById("endSession").onclick()');
      fs.writeFileSync(path.join(artifacts,'history-sample.md'),sessions.document());
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await new Promise(r=>setTimeout(r,100));
      fs.writeFileSync(path.join(artifacts,'interview-history.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript('document.getElementById("newSession").onclick()');
      output.archived=sessions.read(original).endedAt;
      const second=sessions.current.id;await win.webContents.executeJavaScript("api.invoke('session-rename','示例公司 B · 二面').then(restoreInterview)");
      await win.webContents.executeJavaScript("enqueueQuestion('Redis 如何保持缓存一致？')");
      for(let i=0;i<100;i++){if(sessions.current.turns[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
      await win.webContents.executeJavaScript(`document.getElementById('sessionPicker').value=${JSON.stringify(original)};document.getElementById('sessionPicker').onchange()`);
      await win.webContents.executeJavaScript("document.getElementById('resumeSession').onclick()");
      output.switchedBack=await win.webContents.executeJavaScript('({id:interview.id,question:history[0]?.question,answer:history[0]?.answer,rows:document.querySelectorAll(".question-card").length})');
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await new Promise(r=>setTimeout(r,100));
      fs.writeFileSync(path.join(artifacts,'split-session.png'),(await win.webContents.capturePage()).toPNG());
      output.sessions=sessions.list().length;output.otherSessionTurns=sessions.read(second).turns.length;
      settings.captureMode='points';const visible=win.isVisible();await capture();output.pointerSelection={overlay:!!overlay,windowStayedVisible:win.isVisible()===visible};cancelPoints();
      const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      output.pointCrop=await finishPointCapture({cursor:{x:display.bounds.x+20,y:display.bounds.y+20},display},{x:display.bounds.x+200,y:display.bounds.y+140},display,false);
      output.sessionRestored=sessions.current.id===original;
      output.screenshotRestored=await win.webContents.executeJavaScript('({visible:!document.getElementById("savedImageButton").hidden,width:document.getElementById("savedQuestionImage").naturalWidth,attachment:history.at(-1)?.attachmentId})');

      output.ok=output.turns===1&&output.sourceIds.length===2&&/订单系统.*幂等/.test(output.question)&&output.answer===output.restored.answer&&output.restored.transcripts===2&&output.sessions===2&&!!output.archived&&output.sessionRestored&&output.otherSessionTurns===1&&!!output.projectRoot&&output.projectRequest.threadParams.dynamicTools.length===3&&!output.projectRequest.turnParams.input[0].text.includes('boolean idempotent')&&!output.pointerSelection.overlay&&output.pointerSelection.windowStayedVisible&&output.pointCrop.width>0&&output.screenshotRestored.width>0&&output.screenshotRestored.attachment===screenshotAsset.id;
    }catch(e){output.ok=false;output.error=e.stack;output.console=testConsole;}
    fs.writeFileSync(path.join(artifacts,'history-integration.json'),JSON.stringify(output,null,2));app.quit();
  }
  if (process.argv.includes('--speech-integration')) {
    const result = {};
    try {
      await bridge.start();
      const fixture = fs.readFileSync(path.join(ROOT,'artifacts/speech-test.wav')).toString('base64');
      await win.webContents.executeJavaScript(`(async()=>{
        settings.asrProvider='local';settings.autoAnswer=true;settings.asrModel='small';settings.asrLanguage='zh';
        await api.invoke('settings',{asrProvider:'local',autoAnswer:true,asrModel:'small',asrLanguage:'zh'});
        recording=true;questions.reset();const service=await api.invoke('asr-start');audioReady=service.ready;
        while(!audioReady)await new Promise(r=>setTimeout(r,25));
        window.speechTest={start:Date.now(),events:[]};api.on('asr',p=>window.speechTest.events.push({elapsedMs:Date.now()-window.speechTest.start,text:p.text,final:p.final,processingMs:p.processingMs}));
        const ctx=new AudioContext();const bytes=Uint8Array.from(atob(${JSON.stringify(fixture)}),c=>c.charCodeAt(0));
        const decoded=await ctx.decodeAudioData(bytes.buffer);
        const s=new Segmenter({sampleRate:decoded.sampleRate,onSegment:p=>{audioQueue.push(p);drainAudio();}});
        const data=decoded.getChannelData(0),frame=Math.round(decoded.sampleRate/10);
        for(let i=0;i<data.length;i+=frame){s.push(data.slice(i,i+frame));await new Promise(r=>setTimeout(r,100));}
        for(let i=0;i<12;i++){s.push(new Float32Array(frame));await new Promise(r=>setTimeout(r,100));}s.flush();await ctx.close();
      })()`);
      const deadline = Date.now()+100000;
      while(Date.now()<deadline) {
        const state = await win.webContents.executeJavaScript('({answers:history.filter(t=>t.status==="completed").length,busy:generating,error:document.querySelector(".error-message")?.textContent,question:history[0]?.question,answer:history[0]?.answer,toast:document.getElementById("toast").textContent})');
        if(state.answers || state.error) { Object.assign(result,state); break; }
        await new Promise(r=>setTimeout(r,400));
      }
      result.ok=result.answers===1 && /数据库/.test(result.question||'') && !!result.answer;
      Object.assign(result,await win.webContents.executeJavaScript('({speechEvents:window.speechTest.events,transcriptRows:[...transcriptRows.values()].map(r=>r.text)})'));
      result.firstTextMs=result.speechEvents?.[0]?.elapsedMs;
      fs.writeFileSync(path.join(ROOT,'artifacts/minimal-app.png'),(await win.webContents.capturePage()).toPNG());
    }catch(e){result.ok=false;result.error=e.message;}
    fs.writeFileSync(path.join(ROOT,'artifacts/speech-integration.json'),JSON.stringify(result,null,2));app.quit();
  }
  if (process.argv.includes('--integration')) {
    const artifactDir = path.join(ROOT, 'artifacts'); fs.mkdirSync(artifactDir, { recursive: true });
    const result = {};
    try {
      await bridge.start();
      result.model = bridge.defaultModel;
      result.protectionEnabled = win.isContentProtected();
      result.loopback = await win.webContents.executeJavaScript(`(async()=>{const s=await navigator.mediaDevices.getDisplayMedia({video:{width:320,height:180,frameRate:1},audio:true});const r={audioTracks:s.getAudioTracks().length,videoTracks:s.getVideoTracks().length};s.getTracks().forEach(t=>t.stop());return r;})()`, true);
      await captureDrag();
      const overlayWindow = overlay;
      await overlayWindow.webContents.executeJavaScript(`window.copilot.invoke('crop',{x:30,y:30,width:240,height:140})`);
      result.regionScreenshot = { exists: fs.existsSync(imagePath), bytes: fs.statSync(imagePath).size };
      // The screen selection is not sent to a model. Vision uses this synthetic fixture.
      const fixture = new BrowserWindow({ show: false, width: 640, height: 240, webPreferences: { offscreen: true } });
      await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="background:white;color:black;font:32px sans-serif;padding:30px">Interview test: What is Redis?</body></html>'));
      await new Promise(r => setTimeout(r, 300));
      const fixturePath = path.join(scratch, 'fixture.png'); fs.writeFileSync(fixturePath, (await fixture.webContents.capturePage()).toPNG()); fixture.destroy();
      const answer = await bridge.ask({ text: '回答截图里的技术问题，用中文，一句话即可。', image: fixturePath });
      result.visionAnswer = answer;
      await win.webContents.executeJavaScript(`document.getElementById('attachment').hidden=true;document.getElementById('answer').textContent=${JSON.stringify(answer)};document.getElementById('answerState').textContent='实测回答成功';`);
      fs.writeFileSync(path.join(artifactDir, 'verified-app.png'), (await win.webContents.capturePage()).toPNG());
      result.ok = result.loopback.audioTracks > 0 && result.regionScreenshot.bytes > 0 && /Redis/i.test(answer);
    } catch(e) { result.ok = false; result.error = e.message; }
    fs.writeFileSync(path.join(artifactDir,'integration.json'), JSON.stringify(result,null,2));
    app.quit();
  }
  if (process.argv.includes('--smoke')) {
    setTimeout(async () => {
      try {
        const check = await win.webContents.executeJavaScript('({title:document.title,buttons:document.querySelectorAll("button").length,bridge:!!window.copilot,provider:settings.asrProvider,keyFieldType:document.getElementById("bailianKey").type})');
        check.encryptionAvailable=safeStorage.isEncryptionAvailable();check.cloudConnected=!!cloudSpeech.socket;
        const pic = await win.webContents.capturePage(); fs.mkdirSync(path.join(ROOT,'artifacts'), { recursive: true }); fs.writeFileSync(path.join(ROOT,'artifacts/app.png'), pic.toPNG());
        await win.webContents.executeJavaScript('showView("settings")');
        await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        fs.writeFileSync(path.join(ROOT,'artifacts/bailian-settings.png'),(await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(ROOT,'artifacts/smoke.json'), JSON.stringify(check)); app.quit();
      } catch(e) { console.error(e); app.exit(1); }
    }, 3500);
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { globalShortcut.unregisterAll();mousePassthrough?.dispose();clearTimeout(pointTimer); if(activeRequest)sessions.update(activeRequest.id,{answer:activeRequest.answer,status:'interrupted',error:'应用退出时回答尚未完成'});stopAsr(); bridge?.close(); if (scratch) fs.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }, () => {}); });
