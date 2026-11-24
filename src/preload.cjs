const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('copilot', {
  invoke: (channel, data) => {
    if (!['mouse-toggle','mouse-region','init','codex-pick','codex-detect','project-pick','project-info','session-switch','session-resume','session-rename','session-list','session-attachment','session-get','session-new','session-end','turn-queue','credentials','settings','ask','cancel','reset','capture','crop','window','export','asr-start','asr-stop','asr-audio'].includes(channel)) throw new Error('Unknown channel');
    return ipcRenderer.invoke(channel, data);
  },
  on: (channel, fn) => {
    if (!['codex-state','mouse-state','model-activity','delta','shortcut','screenshot','asr','asr-status'].includes(channel)) throw new Error('Unknown event');
    const handler = (_, value) => fn(value); ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
