// Interactive native hit-test fixture. No model, microphone or user data access.
const {app,BrowserWindow,ipcMain,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path');const {MousePassthrough}=require('../src/mouse-passthrough.cjs');
let upper,lower,controller,underClicks=0,overClicks=0,enabled=true;
const report=()=>fs.writeFileSync(path.join(__dirname,'../artifacts/mouse-native-test.json'),JSON.stringify({underClicks,overClicks,enabled,...controller?.state()}));
app.whenReady().then(async()=>{
  lower=new BrowserWindow({x:120,y:120,width:760,height:540,title:'chatbox 穿透验证 - 下层',webPreferences:{nodeIntegration:true,contextIsolation:false}});
  await lower.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<body style="margin:0;background:#dcebe3;font:20px sans-serif"><button style="width:100vw;height:100vh;border:0;background:transparent;font-size:26px" onclick="require('electron').ipcRenderer.send('under-click')">下层点击次数：<span id="count">0</span></button></body>`));
  upper=new BrowserWindow({x:120,y:120,width:760,height:540,title:'chatbox 穿透验证 - 上层',frame:false,alwaysOnTop:true,opacity:.9,webPreferences:{nodeIntegration:true,contextIsolation:false}});
  controller=new MousePassthrough({win:upper,getCursor:()=>screen.getCursorScreenPoint()});
  ipcMain.on('under-click',()=>{underClicks++;lower.webContents.executeJavaScript(`document.getElementById('count').textContent=${underClicks}`);report();});
  ipcMain.on('over-click',()=>{overClicks++;upper.webContents.executeJavaScript(`document.getElementById('over').textContent=${overClicks}`);report();});
  ipcMain.handle('toggle-test',()=>{enabled=!enabled;controller.configure({enabled});report();return enabled;});
  ipcMain.on('close-test',()=>app.quit());
  await upper.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<body style="margin:0;background:#fafaf9;font:16px sans-serif"><header style="height:46px;display:flex;align-items:center;background:#ddd;gap:20px;padding:0 15px"><b>chatbox 穿透验证</b><button onclick="require('electron').ipcRenderer.invoke('toggle-test').then(v=>this.textContent=v?'穿透 开':'穿透 关')">穿透 开</button><button onclick="require('electron').ipcRenderer.send('close-test')">关闭测试</button></header><button style="width:100%;height:450px;font-size:24px;border:0;background:transparent" onclick="require('electron').ipcRenderer.send('over-click')">上层点击次数：<span id="over">0</span><br><small>穿透开启时，此处应点击到下层窗口</small></button></body>`));
  controller.configure({enabled});report();
});
app.on('before-quit',()=>controller?.dispose());app.on('window-all-closed',()=>app.quit());
