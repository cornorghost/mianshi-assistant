const $ = id => document.getElementById(id);
const api = window.copilot;
const { Segmenter, PcmFramer, QuestionAssembler, QuestionGrouper } = window.SpeechPipeline;
let settings = {}, history = [], currentAnswer = '', image = false, generating = false, pendingScreenshot = false;
let recording = false, draining = false, stream = null, audioContext = null, processor = null, audioSourceNode = null, mutedGain = null, segmenter = null, audioReady = false;
let audioQueue = [], queueBusy = false, answerQueue = [], toastTimer, transcriptCount = 0, stopping = null, captureId = 'legacy';
const transcriptRows=new Map();
let transcriptRecords=[];
const questions = new QuestionAssembler();
let interview=null, selectedHistoryId=null, grouper=null, ending=false, pendingEnqueues=0, activeTurn=null, selectedTurnId=null, imageAssetId=null;
let activeView='session',pointerToolbar=null,initialized=false,codexConnection={epoch:-1};
const deferredScreenshots=[],seenScreenshotIds=new Set();
const newId=()=> 'turn-'+Date.now()+'-'+Math.random().toString(36).slice(2);
function configureGrouping(){grouper?.reset();grouper=new QuestionGrouper({waitMs:settings.questionMergeMs??1000,onQuestion:q=>enqueueQuestion(q.text,{source:'speech',sourceIds:q.sourceIds})});}
function showSavedState(){ $('savedState').textContent=interview?.endedAt?'已归档':'自动保存';$('resumeSession').hidden=!interview?.endedAt; }
function renderQuestionList(){
  $('questionList').replaceChildren();$('questionCount').textContent=history.length;
  history.forEach((turn,i)=>{const button=document.createElement('button');button.className='question-card'+(turn.id===selectedTurnId?' selected':'');
    const title=document.createElement('span');title.textContent=(i+1)+'. '+turn.question;const meta=document.createElement('small');meta.textContent=({queued:'等待回答',generating:'回答中',completed:'已保存',failed:'失败 · 已保留',interrupted:'已中断'}[turn.status]||turn.status);
    button.append(title,meta);button.onclick=()=>displayTurn(turn);$('questionList').append(button);
  });
}
function displayTurn(turn){selectedTurnId=turn.id;showTurnScreenshot(turn);$('question').value=turn.question;$('answerQuestion').hidden=false;$('answerQuestion').textContent=turn.question;
  $('answer').innerHTML=renderMarkdown(turn.answer||'等待回答…');$('answerState').textContent=turn.status==='generating'?'生成中':turn.status==='completed'?'已保存':turn.error||'等待回答';renderQuestionList();
}
async function showTurnScreenshot(turn){$('savedImageButton').hidden=true;if(!turn.attachment&&!turn.attachmentId)return;const sessionId=interview?.id;try{const data=await api.invoke('session-attachment',{sessionId,turnId:turn.id});if(selectedTurnId!==turn.id||interview?.id!==sessionId)return;$('savedQuestionImage').src=data;$('savedImageButton').hidden=false;}catch(e){if(selectedTurnId===turn.id)toast('题目原图无法读取：'+e.message);}}
$('savedImageButton').onclick=()=>{$('fullQuestionImage').src=$('savedQuestionImage').src;$('imageViewer').showModal();reportMouseRegion();};
$('closeImageViewer').onclick=()=>$('imageViewer').close();
async function refreshSessionPicker(){const list=await api.invoke('session-list');if(!Array.isArray(list))return;$('sessionPicker').replaceChildren();for(const session of list){const option=document.createElement('option');option.value=session.id;option.textContent=session.title+(session.endedAt?' · 已归档':'');$('sessionPicker').append(option);}$('sessionPicker').value=interview?.id||'';}
function restoreInterview(session){interview=session;clearSession();history=session.turns||[];settings.projectRoot=session.projectRoot||'';$('projectRoot').value=settings.projectRoot;
  for(const row of session.transcripts||[])addTranscript(row.text,row.id,row.final);
  const last=history[history.length-1];if(last){currentAnswer=last.answer||'';displayTurn(last);}else renderQuestionList();showSavedState();updateStatus();refreshSessionPicker().catch(e=>toast(e.message));
}


function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,5500); }
function escapeHTML(text) { return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderMarkdown(text) {
  return text.split(/(\x60{3}[\s\S]*?(?:\x60{3}|$))/g).map(part=>{
    if (part.startsWith('\x60\x60\x60')) return '<pre><code>'+escapeHTML(part.replace(/^\x60{3}[^\n]*\n?/,'').replace(/\x60{3}$/,''))+'</code></pre>';
    return escapeHTML(part).split('\n').map(line=>{
      const inline=line.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>');
      return /^#{1,4} /.test(line)?'<h3>'+inline.replace(/^#{1,4} /,'')+'</h3>':'<p>'+(inline||'<br>')+'</p>';
    }).join('');
  }).join('');
}
function showView(view) { activeView=view;reportMouseRegion(); $('sessionView').hidden=view!=='session'; $('settingsView').hidden=view!=='settings';$('historyView').hidden=view!=='history'; }
function updateStatus() {
  $('autoAnswerToggle').textContent=settings.autoAnswer?'自动回答 开':'自动回答 关';
  $('autoAnswerToggle').ariaPressed=String(!!settings.autoAnswer);
  $('sessionStatus').textContent=draining?'收音已暂停，正在补齐转写':answerQueue.length?'还有 '+answerQueue.length+' 个问题待回答':generating?'正在回答':recording?(settings.autoAnswer?'正在听 · 问完自动回答':'仅转写 · 需手动发送'):settings.autoAnswer?'问完自动回答':'仅转写 · 需手动发送';
}
$('autoAnswerToggle').onclick=async()=>{
  if(!initialized)return;
  $('autoAnswerToggle').disabled=true;
  try{
    const enabled=!settings.autoAnswer;
    await api.invoke('settings',{autoAnswer:enabled});
    settings.autoAnswer=enabled;$('autoAnswer').checked=enabled;
    // Changing mode starts a fresh group; never submit old transcripts on enable.
    grouper?.reset();updateStatus();
    toast(enabled?'已开启自动回答，从下一句开始识别问题':'已关闭自动回答，转写后需手动发送');
  }catch(e){toast('自动回答设置未保存：'+e.message);}
  finally{$('autoAnswerToggle').disabled=false;}
};
function loadSettings() {
  for (const k of ['context','model','style','asrModel','asrLanguage','opacity','audioSource','asrProvider','bailianWorkspace','bailianVocabulary','questionMergeMs','captureMode','projectRoot','codexPath']) $(k).value=settings[k]??(k==='questionMergeMs'?1000:k==='captureMode'?'points':'');
  for (const k of ['top','protection','autoAnswer','autoScreenshot','mousePassthrough']) $(k).checked=settings[k]??(k==='autoScreenshot');
  updateMouseUI();updateProvider();
  $('protectionLabel').textContent=settings.protection?'窗口保护已开启':'窗口保护已关闭'; updateStatus();
}
function reportMouseRegion(){
  const height=document.querySelector?.('.titlebar')?.getBoundingClientRect?.()?.height||46;
  const mode=$('imageViewer').open?'image':activeView;
  api.invoke('mouse-region',{mode,height}).catch(()=>{});
}
function updateMouseUI(state={}){
  if(typeof state.enabled==='boolean')settings.mousePassthrough=state.enabled;
  const enabled=!!settings.mousePassthrough;$('mousePassthrough').checked=enabled;$('passThroughToggle').textContent=enabled?'穿透 开':'穿透 关';$('passThroughToggle').ariaPressed=String(enabled);
  $('top').disabled=enabled;$('top').checked=enabled||!!settings.top;
  $('mouseStateLabel').textContent=enabled?(state.suspended?'· 穿透暂挂':'· 鼠标穿透'):'';
}
api.on('mouse-state',updateMouseUI);
$('mousePassthrough').onchange=()=>{$('top').disabled=$('mousePassthrough').checked;$('top').checked=$('mousePassthrough').checked||!!settings.top;};
$('passThroughToggle').onclick=()=>api.invoke('mouse-toggle').then(updateMouseUI).catch(e=>toast(e.message));
window.addEventListener?.('resize',reportMouseRegion);
document.addEventListener?.('mousemove',event=>{if(!settings.mousePassthrough)return;const toolbar=event.clientY<46;if(toolbar!==pointerToolbar){pointerToolbar=toolbar;reportMouseRegion();}},true);
$('imageViewer').addEventListener('close',reportMouseRegion);
function updateProvider(){
  const cloud=$('asrProvider').value==='bailian';$('bailianSettings').hidden=!cloud;$('localSettings').hidden=cloud;
}
$('asrProvider').onchange=updateProvider;
function addTranscript(text,key='manual-'+Date.now(),complete=true) {
  if (!text) return;
  let row=transcriptRows.get(key);
  if(row){row.body.textContent=text;row.text=text;row.complete=complete;return;}
  const item=document.createElement('div'); item.className='transcript-item';
  const label=document.createElement('small'); label.textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  const body=document.createElement('span');body.textContent=text;
  row={item,body,text,complete,time:label.textContent};transcriptRows.set(key,row);
  item.append(label,body); item.onclick=()=>{$('question').value=row.text;};
  $('transcripts').append(item); $('transcriptCount').textContent=++transcriptCount;
}
async function enqueueQuestion(text,{withImage=false,source='manual',sourceIds=[],attachmentId=null}={}) {
  if(!text&&!withImage)return;
  if(interview?.endedAt){if(source==='screenshot')$('captureStatus').textContent='截图已保存 · 会话已归档';return toast('本场面试已归档，请先继续会话或新建会话');}
  const turn={id:newId(),question:text||'截图提问',text:text||'截图提问',answer:'',source,sourceIds,withImage,attachmentId,status:'queued',createdAt:new Date().toISOString()};
  history.push(turn);if(source==='screenshot')$('captureStatus').textContent=generating?'截图已保存 · 排队中':'截图已保存 · 正在提交';renderQuestionList();pendingEnqueues++;$('savedState').textContent='保存中…';
  try {
    const saved=await api.invoke('turn-queue',{id:turn.id,question:turn.question,source,sourceIds,withImage,attachmentId});if(saved&&typeof saved==='object')Object.assign(turn,saved);
    answerQueue.push(turn);showSavedState();
  }catch(e){turn.status='failed';turn.error=e.message;$('savedState').textContent='保存失败';if(source==='screenshot')$('captureStatus').textContent='截图提问保存失败';toast('提问未保存：'+e.message);}
  finally{pendingEnqueues--;renderQuestionList();runNext();}
}
async function submit(text,{withImage=false,turn}={}) {
  if (generating||(!text&&!withImage)) return;
  if(!turn)return enqueueQuestion(text,{withImage,source:withImage?'screenshot':'manual'});
  if(turn.source==='screenshot')$('captureStatus').textContent='截图题正在回答';
  generating=true;activeTurn=turn;turn.status='generating';selectedTurnId=turn.id;renderQuestionList();$('answerQuestion').hidden=false;$('answerQuestion').textContent=text;showTurnScreenshot(turn);$('ask').disabled=true;$('cancel').hidden=false;$('answerState').textContent='思考中';updateStatus();
  $('question').value=text;currentAnswer='';$('answer').replaceChildren();$('answer').scrollTop=0;
  if(withImage&&(!turn.attachmentId||turn.attachmentId===imageAssetId)){image=false;imageAssetId=null;$('attachment').hidden=true;}
  const result=await api.invoke('ask',{text,withImage,turnId:turn.id}).catch(e=>({ok:false,error:e.message}));
  generating=false;activeTurn=null;$('ask').disabled=false;$('cancel').hidden=true;
  if(result.ok){
    if(turn.source==='screenshot')$('captureStatus').textContent='截图题已回答';
    currentAnswer=result.text;Object.assign(turn,result.turn||{answer:currentAnswer,status:'completed'});if(selectedTurnId===turn.id){$('answer').innerHTML=renderMarkdown(currentAnswer);$('answerState').textContent=turn.projectRoot?'已保存 · 已启用项目读取':turn.projectWarning?'已保存 · 通用模式':'已保存';}
  }else{
    if(turn.source==='screenshot')$('captureStatus').textContent='截图已提交 · 回答失败';
    turn.answer=result.partial||currentAnswer;turn.status='failed';turn.error=result.error;
    if(selectedTurnId===turn.id){const err=document.createElement('p');err.className='error-message';err.textContent=result.error;$('answer').append(err);$('answerState').textContent='已停止 · 记录已保留';}toast(result.error);
  }
  renderQuestionList();updateStatus();runNext();
}
function manualAsk(){
  const text=$('question').value.trim();if(generating||(!text&&!image)||ending)return;
  grouper?.reset();addTranscript(text||'截图提问');enqueueQuestion(text,{withImage:image,source:image?'screenshot':'manual',attachmentId:imageAssetId});
}
function runNext(){
  if(generating)return;
  if(answerQueue.length){const next=answerQueue.shift();submit(next.question,{withImage:next.withImage,turn:next});}
  else if(pendingScreenshot&&image){pendingScreenshot=false;enqueueQuestion('请解答截图中的问题。',{withImage:true,source:'screenshot'});}
  updateStatus();
}
function receiveSpeech(packet,{restored=false}={}) {
  const question=questions.accept(packet);
  if(question) {
    transcriptRecords.push(packet);
    addTranscript(question.text,question.id,question.complete);
    $('transcriptDetails').open=true;
    if(!restored&&!generating&&!answerQueue.length&&document.activeElement!==$('question'))$('question').value=question.text;
    if(question.complete){
      const current=(packet.sessionId||'legacy')===captureId;
      if(!restored&&current&&(recording||draining)&&settings.autoAnswer)grouper?.accept(question,packet);
      $('asrStatus').textContent='识别完成';
    }else { $('asrStatus').textContent='正在转写…';if(!restored&&(packet.sessionId||'legacy')===captureId&&(recording||draining)&&settings.autoAnswer)grouper?.accept(question,packet); }
  }
  drainAudio().catch(()=>{});
}
api.on('model-activity',data=>{if(data.type==='project-read'&&activeTurn&&selectedTurnId===activeTurn.id)$('answerState').textContent='正在查看项目…';});
api.on('delta',text=>{currentAnswer+=text;if(activeTurn)activeTurn.answer=currentAnswer;if(!activeTurn||selectedTurnId===activeTurn.id){$('answerState').textContent='生成中';$('answer').innerHTML=renderMarkdown(currentAnswer);}});
function receiveScreenshot(payload){
  if(!initialized){deferredScreenshots.push(payload);$('captureStatus').textContent='截图已保存 · 等待设置加载';return;}
  const data=typeof payload==='string'?payload:payload.dataUrl,id=typeof payload==='string'?null:payload.attachmentId;
  if(id&&seenScreenshotIds.has(id))return;
  if(id)seenScreenshotIds.add(id);
  if(payload.sessionId&&interview?.id&&payload.sessionId!==interview.id){$('captureStatus').textContent='截图已保存在原会话';return;}
  imageAssetId=id;$('preview').src=data;$('attachment').hidden=false;image=true;
  if(settings.autoScreenshot!==false)enqueueQuestion('请解答截图中的问题。',{withImage:true,source:'screenshot',attachmentId:id});
  else{$('captureStatus').textContent='截图已保存 · 自动提问已关闭';toast('截图已保存；可开启“截图完成后自动提问”，或手动提交');}
}
api.on('screenshot',receiveScreenshot);
function updateCodexConnection(status){
  const epoch=status.epoch??0;
  if(epoch<(codexConnection.epoch??-1)||(epoch===codexConnection.epoch&&codexConnection.ok&&status.connecting))return;
  codexConnection={...status,epoch};$('connection').textContent=status.connecting?'Codex 连接中':status.ok?'Codex 已连接':'连接失败';
  $('connectionDot').className='dot '+(status.connecting?'':status.ok?'ok':'error');$('connection').title=status.model||'';
  $('codexInfo').textContent=status.connecting?'正在检测 Codex，截图和设置可先使用':status.path?'已检测到：'+status.path:status.error||'';
  if(status.error&&!status.connecting)toast(status.error);
}
api.on('codex-state',updateCodexConnection);
api.on('shortcut',data=>data.type==='ask'?manualAsk():toast(data.message));
api.on('asr',receiveSpeech);
api.on('asr-status',data=>{
  if(data.type==='ready'){audioReady=true;$('asrStatus').textContent='模型就绪';drainAudio().catch(()=>{});}
  else if(data.type==='loading')$('asrStatus').textContent=data.message;
  else if(data.type==='progress')$('asrStatus').textContent=data.pending?'转写待处理 '+data.pending+' 段（约 '+Math.round(data.seconds)+' 秒音频）':recording?'正在听…':'转写已补齐';
  else if(data.type==='empty')receiveSpeech(data);
  else if(data.type==='error'){audioReady=false;toast(data.message);stopListening();$('asrStatus').textContent='识别失败，音频已保留';}
});
async function drainAudio(){
  if(queueBusy||!audioQueue.length)return;
  queueBusy=true;
  try{
    while(audioQueue.length){
      const packet=audioQueue[0];
      const result=await api.invoke('asr-audio',packet);
      if(!result||result.accepted===false)throw new Error('音频保存失败，片段仍在等待重试');
      audioQueue.shift();
    }
  }catch(e){toast(e.message);throw e;}finally{queueBusy=false;}
}
setInterval(()=>{drainAudio().catch(()=>{});if(initialized&&!generating&&answerQueue.length)runNext();},100);
async function startListening(){
  if(interview?.endedAt)return toast('本场面试已归档，请新建会话');
  if(recording)return stopListening();
  if(stopping)await stopping;
  $('listen').disabled=true;
  try{
    settings.audioSource=$('audioSource').value;
    await api.invoke('settings',{audioSource:settings.audioSource});
    captureId='capture-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    stream=settings.audioSource==='mic'?await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:true,autoGainControl:true},video:false}):await navigator.mediaDevices.getDisplayMedia({audio:true,video:{width:320,height:180,frameRate:1}});
    if(!stream.getAudioTracks().some(track=>track.readyState==='live'))throw new Error('没有可用的声音轨道，请检查输出设备；Mac 请在系统设置中允许本应用录制系统声音与屏幕。');
    $('asrStatus').textContent='正在连接识别服务…';
    const result=await api.invoke('asr-start',{sessionId:captureId});if(!result.ok)throw new Error(result.error);
    audioReady=result.ready;
    audioContext=new AudioContext();await audioContext.resume();
    audioSourceNode=audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    processor=audioContext.createScriptProcessor(4096,1,1);
    mutedGain=audioContext.createGain();mutedGain.gain.value=0;
    segmenter=new (settings.asrProvider==='bailian'?PcmFramer:Segmenter)({sampleRate:audioContext.sampleRate,source:settings.audioSource,
      onVoice:()=>{if(!generating)$('sessionStatus').textContent='正在听…';},
      onSegment:packet=>{
        audioQueue.push({...packet,sessionId:captureId});$('asrStatus').textContent=audioReady?'识别中…':'正在加载模型，音频已保存';drainAudio().catch(()=>{});
      }
    });
    processor.onaudioprocess=event=>{if(recording)segmenter?.push(event.inputBuffer.getChannelData(0));};
    audioSourceNode.connect(processor);processor.connect(mutedGain);mutedGain.connect(audioContext.destination);
    stream.getAudioTracks()[0].onended=()=>stopListening();
    recording=true;$('listen').textContent='暂停监听';$('listen').classList.add('recording');$('audioSource').disabled=true;
    $('asrStatus').textContent=audioReady?(settings.asrProvider==='bailian'?'百炼已连接':'模型就绪'):'加载模型中，声音会缓存';updateStatus();
  }catch(e){toast(e.message);await stopListening();}finally{$('listen').disabled=false;}
}
function stopListening(){
  if(stopping)return stopping;
  const hadAudio=recording||audioQueue.length;
  recording=false;draining=!!hadAudio;
  segmenter?.flush();segmenter=null;
  stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});stream=null;
  if(processor){processor.onaudioprocess=null;processor.disconnect();processor=null;}
  audioSourceNode?.disconnect();mutedGain?.disconnect();audioContext?.close();audioContext=null;
  $('listen').disabled=true;$('listen').textContent='补齐转写…';updateStatus();
  stopping=(async()=>{
    try{
      while(queueBusy)await new Promise(resolve=>setTimeout(resolve,25));
      await drainAudio();
      await api.invoke('asr-stop');
      grouper?.flush();
      $('asrStatus').textContent='已暂停，转写已补齐';
    }catch(e){grouper?.flush();toast(e.message);$('asrStatus').textContent='待处理音频已保留';}
    finally{draining=false;stopping=null;$('listen').disabled=false;$('listen').textContent='开始监听';$('listen').classList.remove('recording');$('audioSource').disabled=false;updateStatus();}
  })();
  return stopping;
}
$('listen').onclick=startListening;$('ask').onclick=manualAsk;
$('question').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')manualAsk();});
$('cancel').onclick=()=>{pendingScreenshot=false;grouper?.reset();api.invoke('cancel').catch(e=>toast(e.message));};
$('capture').onclick=()=>api.invoke('capture',{fromButton:true}).catch(e=>toast(e.message));
$('removeImage').onclick=()=>{image=false;pendingScreenshot=false;$('attachment').hidden=true;};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(history.find(t=>t.id===selectedTurnId)?.answer??currentAnswer);toast('已复制');}catch{toast('复制失败');}};
$('minimize').onclick=()=>api.invoke('window','minimize');$('close').onclick=()=>api.invoke('window','close');
$('settingsShortcut').onclick=()=>showView('settings');$('back').onclick=()=>showView('session');
$('saveSettings').onclick=async()=>{
  const data={};for(const k of ['context','model','style','asrModel','asrLanguage','asrProvider','bailianWorkspace','bailianVocabulary','captureMode','projectRoot','codexPath'])data[k]=$(k).value;
  for(const k of ['top','protection','autoAnswer','autoScreenshot','mousePassthrough'])data[k]=$(k).checked;
  if(data.mousePassthrough)data.top=settings.top;
  data.opacity=Number($('opacity').value);data.questionMergeMs=Number($('questionMergeMs').value);
  const changed=['asrProvider','asrModel','asrLanguage','bailianWorkspace','bailianVocabulary'].some(k=>data[k]!==settings[k])||!!$('bailianKey').value.trim();
  const restart=recording&&changed;
  if(restart)await stopListening();
  try {
  if($('bailianKey').value.trim()) { await api.invoke('credentials',{key:$('bailianKey').value.trim()});$('bailianKey').value='';$('keyStatus').textContent='密钥已加密保存'; }
  const codexChanged=data.codexPath!==(settings.codexPath||'');
  settings=await api.invoke('settings',data);if(interview)interview.projectRoot=settings.projectRoot;loadSettings();if(settings.autoAnswer)grouper?.flush();configureGrouping();
  if(codexChanged)await detectCodex();showView('session');toast('已保存');if(restart)startListening();
  } catch(e){toast(e.message);}
};
async function settleAnswers(){
  await stopListening();grouper?.flush();
  while(generating||answerQueue.length||pendingEnqueues)await new Promise(resolve=>setTimeout(resolve,50));
}
function clearSession(){
  history=[];answerQueue=[];questions.reset();grouper?.reset();transcriptRows.clear();transcriptRecords=[];currentAnswer='';selectedTurnId=null;
  $('captureStatus').textContent='';$('answerQuestion').hidden=true;$('savedImageButton').hidden=true;imageAssetId=null;renderQuestionList();$('answer').replaceChildren();$('transcripts').replaceChildren();transcriptCount=0;$('transcriptCount').textContent='0';
  $('question').value='';image=false;pendingScreenshot=false;$('attachment').hidden=true;$('answerState').textContent='';showSavedState();
}
$('sessionPicker').onchange=async()=>{
  const id=$('sessionPicker').value;if(ending||!id||id===interview?.id)return;
  ending=true;$('sessionPicker').disabled=true;
  try{await settleAnswers();restoreInterview(await api.invoke('session-switch',id));toast('已切换会话，其他会话保留');}
  catch(e){toast(e.message);$('sessionPicker').value=interview?.id||'';}finally{ending=false;$('sessionPicker').disabled=false;}
};
$('resumeSession').onclick=async()=>{try{interview=await api.invoke('session-resume');showSavedState();refreshSessionPicker();toast('已继续本场会话');}catch(e){toast(e.message);}};
$('renameSession').onclick=()=>{$('sessionTitle').hidden=false;$('sessionPicker').hidden=true;$('sessionTitle').value=interview?.title||'';$('sessionTitle').focus();};
async function saveSessionTitle(){try{interview=await api.invoke('session-rename',$('sessionTitle').value);$('sessionTitle').hidden=true;$('sessionPicker').hidden=false;await refreshSessionPicker();}catch(e){toast(e.message);}}
$('sessionTitle').addEventListener('keydown',event=>{if(event.key==='Enter')saveSessionTitle();else if(event.key==='Escape'){$('sessionTitle').hidden=true;$('sessionPicker').hidden=false;}});
$('sessionTitle').onchange=saveSessionTitle;
async function detectCodex(){
  $('detectCodex').disabled=true;$('codexDetection').textContent='正在检测 Codex…';
  try{const result=await api.invoke('codex-detect',$('codexPath').value);settings.codexPath=$('codexPath').value;updateCodexConnection(result);$('codexDetection').textContent=result.ok?'已连接：'+result.path:result.error;$('codexInfo').textContent=result.ok?'已检测到：'+result.path:result.error;return result;}catch(e){$('codexDetection').textContent=e.message;}finally{$('detectCodex').disabled=false;}
}
$('detectCodex').onclick=detectCodex;
$('pickCodex').onclick=async()=>{try{const file=await api.invoke('codex-pick');if(file){$('codexPath').value=file;$('codexDetection').textContent='已选择，请点击保存路径并检测。';}}catch(e){toast(e.message);}};
$('pickProject').onclick=async()=>{try{const info=await api.invoke('project-pick');if(info){$('projectRoot').value=info.root;$('projectInfo').textContent='目录可用，保存后由 Codex CLI 按需读取。';}}catch(e){toast(e.message);}};
$('projectRoot').onchange=async()=>{try{const info=await api.invoke('project-info',$('projectRoot').value);$('projectInfo').textContent=info.available?'目录可用，由 Codex CLI 按需读取':info.warning||'未选择参考项目';}catch(e){$('projectInfo').textContent=e.message;}};
$('newSession').onclick=async()=>{
  if(ending)return;ending=true;$('newSession').disabled=true;
  try{await settleAnswers();restoreInterview(await api.invoke('session-new'));showView('session');toast('已保存上一场，开始新会话');}
  catch(e){toast(e.message);}finally{ending=false;$('newSession').disabled=false;}
};
$('endSession').onclick=async()=>{
  if(ending)return;ending=true;$('endSession').disabled=true;
  try{await settleAnswers();interview=await api.invoke('session-end');showSavedState();await openHistory(interview.id);toast('面试文档已自动保存');}
  catch(e){toast(e.message);}finally{ending=false;$('endSession').disabled=false;}
};
async function loadHistoryImage(sessionId,id,element){try{element.src=await api.invoke('session-attachment',{sessionId,attachmentId:id,turnId:id});}catch{element.alt='原图文件不可用';}}
function renderHistory(session){
  selectedHistoryId=session.id;$('historyMeta').textContent=new Date(session.createdAt).toLocaleString('zh-CN')+' · '+session.turns.length+' 个提问 · '+(session.endedAt?'已归档':'进行中');
  $('historyTurns').replaceChildren();$('historyTranscripts').replaceChildren();$('historyImageGallery').replaceChildren();$('historyImages').hidden=!(session.screenshots||[]).length;
  for(const asset of session.screenshots||[]){const image=document.createElement('img');image.className='history-screenshot';image.alt='会话截图 · '+new Date(asset.createdAt).toLocaleTimeString('zh-CN');image.onclick=()=>{$('fullQuestionImage').src=image.src;$('imageViewer').showModal();reportMouseRegion();};$('historyImageGallery').append(image);loadHistoryImage(session.id,asset.id,image);}
  const sourceMap=new Map(session.transcripts.map((row,i)=>[row.id,{...row,number:i+1}]));
  if(!session.turns.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='本场尚无提问。转写仍保存在下方。';$('historyTurns').append(empty);}
  session.turns.forEach((turn,i)=>{
    const card=document.createElement('article');card.className='history-turn';
    const title=document.createElement('h2');title.textContent=(i+1)+'. '+turn.question;
    const meta=document.createElement('p');meta.className='hint';meta.textContent=new Date(turn.createdAt).toLocaleTimeString('zh-CN')+' · '+({queued:'等待回答',generating:'回答中',completed:'已完成',failed:'失败',interrupted:'已中断'}[turn.status]||turn.status);
    const body=document.createElement('div');body.className='history-answer';body.innerHTML=renderMarkdown(turn.answer||'（暂无回答）');card.append(title,meta,body);
    if(turn.error){const error=document.createElement('p');error.className='error-message';error.textContent=turn.error;card.append(error);}
    if(turn.projectRoot){const note=document.createElement('p');note.className='hint';note.textContent='参考项目（CLI 读取）：'+turn.projectRoot;card.append(note);}
    if(turn.projectWarning){const note=document.createElement('p');note.className='hint';note.textContent=turn.projectWarning;card.append(note);}
    if(turn.projectSources?.length){const sources=document.createElement('p');sources.className='hint';sources.textContent='项目参考：'+turn.projectSources.map(s=>s.path+':'+s.line).join('、');card.append(sources);}
    if(turn.attachment){const image=document.createElement('img');image.className='history-screenshot';image.alt='第 '+(i+1)+' 题原始截图';image.onclick=()=>{$('fullQuestionImage').src=image.src;$('imageViewer').showModal();reportMouseRegion();};card.append(image);loadHistoryImage(session.id,turn.id,image);}
    if(turn.sourceIds?.length){
      const details=document.createElement('details');details.className='history-sources';const label=document.createElement('summary');label.textContent='对应的原始提问 · '+turn.sourceIds.length+' 段';details.append(label);
      for(const id of turn.sourceIds){const row=sourceMap.get(id);if(!row)continue;const text=document.createElement('p');text.textContent='['+row.number+'] '+row.text;details.append(text);}card.append(details);
    }
    $('historyTurns').append(card);
  });
  session.transcripts.forEach((row,i)=>{const item=document.createElement('p');item.textContent='['+(i+1)+'] '+new Date(row.capturedAt).toLocaleTimeString('zh-CN')+' '+row.text+(row.final?'':'（未定稿）');$('historyTranscripts').append(item);});
}
async function openHistory(id){
  try{
    const list=await api.invoke('session-list');$('historySession').replaceChildren();
    for(const session of list){const option=document.createElement('option');option.value=session.id;option.textContent=session.title+' · '+session.turns+' 题';$('historySession').append(option);}
    const selected=id||interview?.id||list[0]?.id;if(!selected)return;
    $('historySession').value=selected;renderHistory(await api.invoke('session-get',selected));showView('history');
  }catch(e){toast(e.message);}
}
$('historyShortcut').onclick=()=>openHistory();$('historyBack').onclick=()=>showView('session');
$('historySession').onchange=async()=>{try{renderHistory(await api.invoke('session-get',$('historySession').value));}catch(e){toast(e.message);}};
$('historyExport').onclick=async()=>{try{if(await api.invoke('export',{sessionId:selectedHistoryId}))toast('已导出面试文档');}catch(e){toast(e.message);}};
$('export').onclick=async()=>{
  if(interview?.id){if(await api.invoke('export',{sessionId:interview.id}))toast('已导出面试文档');return;}
  const log=[...transcriptRows.values()].map(row=>'['+row.time+'] '+row.text).join('\n\n');
  const text='# 会话记录\n\n## 完整转写\n\n'+log+'\n\n## 问答\n\n'+history.map((h,i)=>'### '+(i+1)+'. '+h.question+'\n\n'+h.answer+'\n').join('\n');
  if(await api.invoke('export',text))toast('已导出');
};
api.invoke('init').then(data=>{
  settings=data.settings;reportMouseRegion();if(data.platform==='darwin'){$('capture').title='⌘ + Shift + S：依次标记两个角';$('projectInfo').textContent='Mac 首次使用需允许屏幕与系统声音权限';}loadSettings();configureGrouping();if(data.interview)restoreInterview(data.interview);else showSavedState();
$('keyStatus').textContent=data.credentials?.configured?'已配置；留空保留现有密钥':'尚未配置，请填写北京地域 API Key';
  $('asrStatus').textContent=settings.asrProvider==='bailian'?'百炼 · 开始监听后连接':'本地模型预热中';updateCodexConnection(data.codex);
  for(const record of data.transcripts||[])receiveSpeech(record,{restored:true});
  initialized=true;$('saveSettings').disabled=false;$('autoAnswerToggle').disabled=false;for(const payload of deferredScreenshots.splice(0))receiveScreenshot(payload);
}).catch(e=>toast(e.message));
