// Virtualized page previews share the existing PDF and low-priority render queue.
// At most 24 small canvases are retained; closing releases them and cancels work.
var pdfNavigatorState;
function navigatorPane() {
  const active=panes[appState.activeSide];
  return active?.pdf&&!active.paneEl.hidden?active:Object.values(panes).find(p=>p.pdf&&!p.paneEl.hidden)||null;
}
function closePdfNavigator() {
  const s=pdfNavigatorState;if(!s)return;
  const wasOpen=!s.root.hidden;s.root.hidden=true;$('#pdfNavBtn').setAttribute('aria-expanded','false');
  ++s.token;s.task?.cancel();s.pdf=null;s.buttons.clear();s.pages.replaceChildren();
  for(const canvas of s.cache.values())canvas.width=canvas.height=1;
  s.cache.clear();s.failed.clear();
  if(wasOpen)refreshSearchOverlayLayout();
}
function syncPdfNavigator() {
  const s=pdfNavigatorState;if(!s||s.root.hidden)return;
  const pane=navigatorPane();
  if(s.pdf!==pane?.pdf||s.side!==pane?.side){
    ++s.token;s.task?.cancel();s.pdf=pane?.pdf||null;s.side=pane?.side||null;
    for(const canvas of s.cache.values())canvas.width=canvas.height=1;
    s.cache.clear();s.failed.clear();s.buttons.clear();s.pages.replaceChildren();s.current=0;
  }
  const sources=Object.values(panes).filter(p=>p.pdf);
  s.sides.hidden=sources.length<2;
  for(const b of s.sides.children)b.setAttribute('aria-pressed',String(b.dataset.side===s.side));
  s.empty.hidden=!!s.pdf;
  s.pages.style.height=`${(s.pdf?.numPages||0)*190}px`;
  refreshSearchOverlayLayout();
  if(s.pdf){
    const max=Math.max(0,s.pdf.numPages*190-s.list.clientHeight);
    s.list.scrollTop=clamp(s.list.scrollTop,0,max);
  }
  paintPdfNavigator();
}
function paintPdfNavigator() {
  const s=pdfNavigatorState;if(!s||s.root.hidden||!s.pdf)return;
  const pane=panes[s.side],page=clamp(pane.currentPage||1,1,s.pdf.numPages);
  s.count.textContent=`${page} / ${s.pdf.numPages}`;
  if(s.current!==page){
    s.current=page;const top=(page-1)*190;
    if(top<s.list.scrollTop||top+180>s.list.scrollTop+s.list.clientHeight)s.list.scrollTop=clamp(top-s.list.clientHeight*.25,0,Math.max(0,s.pdf.numPages*190-s.list.clientHeight));
  }
  const first=Math.max(1,Math.floor(s.list.scrollTop/190)),last=Math.min(s.pdf.numPages,Math.ceil((s.list.scrollTop+s.list.clientHeight)/190)+2);
  for(const [number,button]of s.buttons)if(number<first||number>last){button.remove();s.buttons.delete(number);}
  for(let n=first;n<=last;n++){
    let button=s.buttons.get(n);
    if(!button){
      button=document.createElement('button');button.type='button';button.className='pdf-page-thumb';button.dataset.page=n;
      button.style.top=`${(n-1)*190}px`;button.setAttribute('aria-label',`跳到第 ${n} 页`);
      const image=document.createElement('span');image.className='pdf-thumb-image';
      const placeholder=document.createElement('span');placeholder.className='pdf-thumb-placeholder';placeholder.textContent='…';image.append(placeholder);
      const label=document.createElement('span');label.className='pdf-thumb-number';label.textContent=n;button.append(image,label);
      button.onclick=()=>{const p=panes[s.side];if(!p.pdf)return;p.goToPage(n,true);paintPdfNavigator();if(matchMedia('(max-width:700px)').matches)closePdfNavigator();};
      s.buttons.set(n,button);s.pages.append(button);
    }
    button.setAttribute('aria-current',n===page?'page':'false');
    const cached=s.cache.get(n);
    if(cached&&cached.parentElement!==button.firstElementChild)button.firstElementChild.replaceChildren(cached);
  }
  pumpPdfThumbnails();
}
async function pumpPdfThumbnails() {
  const s=pdfNavigatorState;if(!s||s.busy||s.root.hidden||!s.pdf)return;
  s.busy=true;
  const token=s.token,pdf=s.pdf,side=s.side;
  const valid=()=>!s.root.hidden&&s.token===token&&s.pdf===pdf&&panes[side].pdf===pdf;
  try{
    while(valid()){
      const n=[...s.buttons.keys()].find(n=>!s.cache.has(n)&&!s.failed.has(n));if(!n)break;
      let canvas;
      try{
        canvas=await renderQueue.add(async()=>{
          if(!valid())return null;
          const source=panes[side].models[n-1]?.canvas;
          const result=document.createElement('canvas');
          if(source?.width>1){
            const ratio=Math.min(228/source.width,213/source.height);
            result.width=Math.max(1,Math.round(source.width*ratio));result.height=Math.max(1,Math.round(source.height*ratio));
            result.getContext('2d',{alpha:false}).drawImage(source,0,0,result.width,result.height);
          }else{
            const page=await pdf.getPage(n);if(!valid())return null;
            const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(228/base.width,213/base.height)});
            result.width=Math.max(1,Math.ceil(viewport.width));result.height=Math.max(1,Math.ceil(viewport.height));
            s.task=page.render({canvasContext:result.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)'});
            try{await s.task.promise;}catch(error){result.width=result.height=1;throw error;}finally{s.task=null;}
          }
          return result;
        },-1000);
        if(!canvas)break;
        if(!valid()){canvas.width=canvas.height=1;break;}
        s.cache.set(n,canvas);
        s.buttons.get(n)?.firstElementChild.replaceChildren(canvas);
        while(s.cache.size>24){
          const old=[...s.cache.keys()].find(k=>!s.buttons.has(k));if(old===undefined)break;
          const c=s.cache.get(old);s.cache.delete(old);c.width=c.height=1;
        }
      }catch(error){
        if(!valid())break;
        s.failed.add(n);
        const label=s.buttons.get(n)?.querySelector('.pdf-thumb-placeholder');if(label)label.textContent='点击跳转';
      }
      await nextFrame();
    }
  }finally{
    s.busy=false;
    if(!s.root.hidden&&s.pdf&&s.token!==token)pumpPdfThumbnails();
  }
}
function initPdfNavigator(){
  const root=document.createElement('aside');root.id='pdfNavigator';root.className='pdf-navigator';root.hidden=true;root.setAttribute('aria-label','PDF 页面导航');
  root.innerHTML='<div class="pdf-nav-heading"><strong>页面导航</strong><span id="pdfNavCount"></span><button id="closePdfNav" aria-label="关闭页面导航"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="pdf-nav-sides" hidden><button data-side="left">左侧文档</button><button data-side="right">右侧文档</button></div><div class="pdf-nav-list" tabindex="0" aria-label="页面缩略图列表"><p class="pdf-nav-empty">打开 PDF 后查看页面缩略图。</p><div class="pdf-nav-pages"></div></div>';
  $('.reader-content').append(root);
  const s=pdfNavigatorState={root,list:root.querySelector('.pdf-nav-list'),pages:root.querySelector('.pdf-nav-pages'),empty:root.querySelector('.pdf-nav-empty'),sides:root.querySelector('.pdf-nav-sides'),count:root.querySelector('#pdfNavCount'),pdf:null,side:null,token:0,busy:false,task:null,cache:new Map(),failed:new Set(),buttons:new Map(),raf:0,current:0};
  $('#pdfNavBtn').onclick=()=>{if(!root.hidden){closePdfNavigator();return;}root.hidden=false;$('#pdfNavBtn').setAttribute('aria-expanded','true');syncPdfNavigator();};
  $('#closePdfNav').onclick=()=>{closePdfNavigator();$('#pdfNavBtn').focus();};
  function queue(){if(s.raf)return;s.raf=requestAnimationFrame(()=>{s.raf=0;paintPdfNavigator();});}
  s.list.addEventListener('scroll',queue,{passive:true});new ResizeObserver(queue).observe(s.list);
  searchOverlayObserver.observe(root);
  for(const b of s.sides.children)b.onclick=()=>{appState.activeSide=b.dataset.side;if(panes[b.dataset.side].paneEl.hidden)setLayout(b.dataset.side);syncPdfNavigator();};
  for(const pane of Object.values(panes)){
    const update=pane.updateCurrentPage.bind(pane);
    pane.updateCurrentPage=()=>{update();if(!root.hidden&&s.pdf===pane.pdf&&s.side===pane.side){s.count.textContent=`${pane.currentPage} / ${pane.pdf.numPages}`;queue();}};
    pane.paneEl.addEventListener('pointerdown',()=>{if(!root.hidden)syncPdfNavigator();},{passive:true});
  }
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!root.hidden)closePdfNavigator();});
}
initPdfNavigator();
