const screenImage=document.getElementById('screen'), selection=document.getElementById('selection'); let start=null,rect=null;
window.copilot.on('screenshot',data=>{screenImage.src=data;});
window.onkeydown=e=>{if(e.key==='Escape')window.copilot.invoke('crop',null);};
window.onpointerdown=e=>{if(e.button!==0)return;start={x:e.clientX,y:e.clientY};};
window.onpointermove=e=>{if(!start)return;rect={x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(e.clientX-start.x),height:Math.abs(e.clientY-start.y)};Object.assign(selection.style,{display:'block',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});};
window.onpointerup=()=>{if(!start)return;start=null;if(rect&&rect.width>=8&&rect.height>=8)window.copilot.invoke('crop',rect).catch(()=>{});else window.copilot.invoke('crop',null);};
