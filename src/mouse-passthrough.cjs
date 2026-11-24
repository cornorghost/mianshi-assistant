function shouldIgnore({enabled,suspended,visible,point,bounds,toolbarHeight=46}){
  if(!enabled||suspended||!visible)return false;
  const toolbar=point.x>=bounds.x&&point.x<bounds.x+bounds.width&&point.y>=bounds.y&&point.y<bounds.y+toolbarHeight;
  return !toolbar;
}
class MousePassthrough{
  constructor({win,getCursor,onChange=()=>{}}){Object.assign(this,{win,getCursor,onChange});this.enabled=false;this.mode='session';this.toolbarHeight=46;this.ignoring=null;this.timer=null;}
  configure({enabled=this.enabled,mode=this.mode,toolbarHeight=this.toolbarHeight}={}){
    this.enabled=!!enabled;this.mode=mode;this.toolbarHeight=Math.min(180,Math.max(24,Number(toolbarHeight)||46));
    if(this.enabled&&!this.timer){this.timer=setInterval(()=>this.refresh(),16);this.timer.unref?.();}
    if(!this.enabled&&this.timer){clearInterval(this.timer);this.timer=null;}
    this.refresh();this.onChange(this.state());
  }
  state(){return {enabled:this.enabled,ignoring:!!this.ignoring,suspended:this.mode!=='session'};}
  refresh(){
    if(this.win.isDestroyed())return this.dispose();
    const ignore=shouldIgnore({enabled:this.enabled,suspended:this.mode!=='session',visible:this.win.isVisible()&&!this.win.isMinimized(),point:this.getCursor(),bounds:this.win.getContentBounds(),toolbarHeight:this.toolbarHeight});
    if(ignore!==this.ignoring){this.win.setIgnoreMouseEvents(ignore,{forward:true});this.ignoring=ignore;}
  }
  dispose(){if(this.timer)clearInterval(this.timer);this.timer=null;if(!this.win.isDestroyed())this.win.setIgnoreMouseEvents(false);this.ignoring=false;}
}
module.exports={MousePassthrough,shouldIgnore};
