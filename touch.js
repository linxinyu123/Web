// Native single-finger scrolling and anchored, compositor-only two-finger zoom.
// No PDF re-render occurs during a pinch; the existing sharp render runs on release.
function installPdfTouch(pane) {
  let pinch=null, frame=0, pending=null, tap=null, lastTap=null;
  const center=touches=>({x:(touches[0].clientX+touches[1].clientX)/2,y:(touches[0].clientY+touches[1].clientY)/2});
  const distance=touches=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
  function paint() {
    frame=0;
    if(!pinch||!pending||!pane.pdf||!pane.plane)return;
    const {point,scale}=pending,rect=pane.viewer.getBoundingClientRect();
    const localX=point.x-rect.left,localY=point.y-rect.top,ratio=scale/pane.layoutScale;
    const tx=pane.viewer.scrollLeft+localX-(pane.planeOffsetX+(pane.zoomBaseDocX-pane.planeOffsetX)*ratio);
    const ty=pane.viewer.scrollTop+localY-pane.zoomBaseDocY*ratio;
    pane.plane.style.transform=`translate3d(${tx}px,${ty}px,0) scale(${scale})`;
    pane.scale=scale;pane.wheelZoomTargetScale=scale;
    if(pane.zoomAnchor){pane.zoomAnchor.localX=localX;pane.zoomAnchor.localY=localY;}
    pane.updateZoomUI();
  }
  function finish() {
    if(frame){cancelAnimationFrame(frame);frame=0;paint();}
    if(pinch&&pane.zoomPreviewActive)pane.commitWheelZoom();
    pinch=null;pending=null;
  }
  pane.viewer.addEventListener('touchstart',event=>{
    if(!pane.pdf)return;
    appState.activeSide=pane.side;
    if(event.touches.length===1){const t=event.touches[0];tap={x:t.clientX,y:t.clientY,time:performance.now()};return;}
    if(event.touches.length!==2)return;
    if(event.cancelable)event.preventDefault();
    tap=null;lastTap=null;finish();
    if(pane.zoomPreviewActive)pane.commitWheelZoom();
    const point=center(event.touches),rect=pane.viewer.getBoundingClientRect();
    pinch={distance:Math.max(1,distance(event.touches)),scale:pane.scale};
    pane.cancelSharpRender();pane.zoomPreviewActive=true;pane.viewer.classList.add('zoom-preview');
    pane.zoomBaseMx=point.x-rect.left;pane.zoomBaseMy=point.y-rect.top;
    pane.zoomBaseDocX=pane.viewer.scrollLeft+pane.zoomBaseMx;pane.zoomBaseDocY=pane.viewer.scrollTop+pane.zoomBaseMy;
    pane.zoomAnchor=pane.captureWheelZoomGesture(point.x,point.y);
    clearTimeout(pane.wheelZoomTimer);updateRenderConcurrency();
  },{passive:false});
  pane.viewer.addEventListener('touchmove',event=>{
    if(tap&&event.touches.length===1&&Math.hypot(event.touches[0].clientX-tap.x,event.touches[0].clientY-tap.y)>8)tap=null;
    if(!pinch||event.touches.length!==2)return;
    if(event.cancelable)event.preventDefault();
    pending={point:center(event.touches),scale:clamp(pinch.scale*distance(event.touches)/pinch.distance,CFG.MIN_SCALE,CFG.MAX_SCALE)};
    if(!frame)frame=requestAnimationFrame(paint);
  },{passive:false});
  pane.viewer.addEventListener('touchend',event=>{
    if(pinch){if(event.touches.length<2)finish();return;}
    if(event.touches.length||!tap||performance.now()-tap.time>280){tap=null;return;}
    const now=performance.now();
    if(lastTap&&now-lastTap.time<320&&Math.hypot(lastTap.x-tap.x,lastTap.y-tap.y)<28&&!document.getSelection()?.toString()){
      if(event.cancelable)event.preventDefault();
      if(pane.zoomMode==='fit-width')pane.setScale(Math.min(CFG.MAX_SCALE,pane.scale*1.7),{anchorClientX:tap.x,anchorClientY:tap.y,propagate:true});
      else pane.fitWidth({propagate:true});
      lastTap=null;
    }else lastTap={...tap,time:now};
    tap=null;
  },{passive:false});
  pane.viewer.addEventListener('touchcancel',()=>{tap=null;lastTap=null;finish()},{passive:true});
  pane.cancelTouch=()=>{tap=null;lastTap=null;finish()};
}
