// Workspace shell. This source is appended to the reader by prepare_workspace.py.
// The two live panes are reused; inactive tabs keep detached, bounded snapshots.
const PREF_KEY = 'dualpdf:workspace:preferences';
const TABS_KEY = 'dualpdf:workspace:tabs';
const safeRead = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const safeWrite = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const workspacePrefs = { theme: 'system', readingMode: 'original', fileView: 'list', starred: [], ...safeRead(PREF_KEY, {}) };
if (!Array.isArray(workspacePrefs.starred)) workspacePrefs.starred = [];
const readingModes = ['original', 'dark', 'invert', 'paper'];
if (!readingModes.includes(workspacePrefs.readingMode)) workspacePrefs.readingMode = 'original';
const workspace = { tabs: [], closed: [], active: null, section: 'recent', serial: 0, queue: Promise.resolve(), recent: [], views: [], renderToken: 0, busy: false, dragId: null };
const paneLoad = Object.fromEntries(Object.entries(panes).map(([side, pane]) => [side, pane.loadFile.bind(pane)]));
const documentKeys = ['file','docId','pdf','loadingTask','scale','layoutScale','zoomMode','currentPage','models','plane','baseSurfaceW','baseSurfaceH','planeOffsetX','canvasBytes','textCache','surfaceW','surfaceH'];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const filePicker = $('#workspaceFile');
let homeRenderTimer;

function enqueueWorkspace(action) {
  const next = workspace.queue.then(action);
  workspace.queue = next.catch(error => { console.error('Workspace operation failed', error); toast(error?.message || '操作未完成，请重试。', true); });
  return workspace.queue;
}
function activeWorkspaceTab() { return workspace.tabs.find(tab => tab.id === workspace.active) || null; }
function saveWorkspaceTabs() {
  safeWrite(TABS_KEY,{version:2,active:workspace.active,section:workspace.section,tabs:workspace.tabs.map(describeTab),closed:workspace.closed.map(describeTab)});
}
function describeTab(tab){return {id:tab.id,mode:tab.mode,layout:tab.id===workspace.active?appState.layout:tab.layout,readingMode:tab.readingMode,sources:Object.fromEntries(['left','right'].filter(side=>tab.sources[side]?.docId).map(side=>[side,{docId:tab.sources[side].docId,name:tab.sources[side].file?.name||tab.sources[side].name||'PDF'}]))};}
function tabTitle(tab) {
  const a = tab.sources.left?.file.name, b = tab.sources.right?.file.name;
  return a && b ? `${a.replace(/\.pdf$/i,'')} ↔ ${b.replace(/\.pdf$/i,'')}` : a || b || (tab.mode === 'compare' ? '双栏对读' : '正在打开…');
}
function renderWorkspaceTabs(focusId = null) {
  const container = $('#tabList');
  for (const node of container.querySelectorAll('.document-tab')) node.remove();
  const fragment = document.createDocumentFragment();
  for (const tab of workspace.tabs) {
    const node = document.createElement('div');
    node.className = 'workspace-tab document-tab'; node.id = `tab-${tab.id}`; node.dataset.tabId = tab.id;
    node.setAttribute('role','tab'); node.setAttribute('aria-controls','readerPanel');
    node.setAttribute('aria-selected', String(workspace.active === tab.id));
    node.tabIndex = workspace.active === tab.id ? 0 : -1; node.draggable = true;
    node.title = tabTitle(tab);
    node.innerHTML = tab.loading ? '<i class="tab-loading" aria-hidden="true"></i>' : icon(tab.mode === 'compare' ? 'compare' : 'file');
    const label = document.createElement('span'); label.textContent = tabTitle(tab);
    const close = document.createElement('button'); close.className = 'tab-close'; close.dataset.closeTab = tab.id;
    close.setAttribute('aria-label', `关闭 ${tabTitle(tab)}`); close.title = '关闭标签（Alt + W）'; close.tabIndex = -1; close.innerHTML = icon('close');
    node.append(label,close); fragment.append(node);
  }
  container.append(fragment);
  $('#homeTab').setAttribute('aria-selected', String(!workspace.active));
  $('#homeTab').tabIndex = workspace.active ? -1 : 0;
  if (workspace.active) $('#readerPanel').setAttribute('aria-labelledby', `tab-${workspace.active}`);
  document.title = workspace.active ? `${tabTitle(activeWorkspaceTab())} · 对读` : '对读 · PDF 工作空间';
  if (focusId) (focusId === 'home' ? $('#homeTab') : document.getElementById(`tab-${focusId}`))?.focus({preventScroll:true});
  if (workspace.active) document.getElementById(`tab-${workspace.active}`)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function viewOf(pane) {
  return { scale: pane.scale, zoomMode: pane.zoomMode, currentPage: pane.currentPage, scrollTop: pane.viewer.scrollTop, scrollLeft: pane.viewer.scrollLeft, anchor:pane.getScrollAnchor(), viewportRevision: 2 };
}
function stopPaneActivity(pane) {
  pane.cancelTouch?.();
  if (pane.zoomPreviewActive) pane.commitWheelZoom();
  ++pane.generation;
  for (const field of ['viewSaveTimer','wheelZoomTimer','sharpTimer','scrollIdleTimer','geometryTimer','controlsTimer']) { clearTimeout(pane[field]); pane[field] = 0; }
  for (const field of ['scrollRaf','resizeRaf','panRaf']) { cancelAnimationFrame(pane[field]); pane[field] = 0; }
  if (pane.memoryPruneHandle) { if ('cancelIdleCallback' in window) cancelIdleCallback(pane.memoryPruneHandle); else clearTimeout(pane.memoryPruneHandle); pane.memoryPruneHandle = 0; }
  pane.isScrolling = false; pane.panState = null; pane.syncEcho = null;
  for (const model of pane.models) { pane.cancelModelRender(model); ++model.textTicket; model.textLayer?.cancel?.(); model.textRendering = false; model.textScheduled = false; }
  pane.viewer.classList.remove('panning','zoom-preview');
}
function capturePane(pane) {
  if (!pane.file) return null;
  if (pane.geometryDirtyModels.size) pane.flushGeometryUpdates();
  const view = viewOf(pane);
  pane.persistView();
  stopPaneActivity(pane);
  const snapshot = Object.fromEntries(documentKeys.map(key => [key,pane[key]]));
  snapshot.view = view;
  snapshot.style = pane.pagesEl.getAttribute('style') || '';
  snapshot.fragment = document.createDocumentFragment();
  while (pane.pagesEl.firstChild) snapshot.fragment.append(pane.pagesEl.firstChild);
  // Parked pages retain a small preview, never full-resolution page bitmaps.
  for (const model of snapshot.models) {
    if (model.canvas.width > 1) {
      const preview = document.createElement('canvas'); preview.className = 'pdf-bitmap';
      preview.width = 120; preview.height = Math.max(1, Math.round(model.canvas.height * 120 / model.canvas.width));
      preview.getContext('2d').drawImage(model.canvas,0,0,preview.width,preview.height);
      model.canvas.replaceWith(preview); model.canvas.width = model.canvas.height = 1; model.canvas = preview;
      model.renderedScale = 0; model.canvasBytes = preview.width * preview.height * 4;
    }
  }
  snapshot.canvasBytes = snapshot.models.reduce((sum, model) => sum + model.canvasBytes, 0);
  pane.file = pane.docId = pane.pdf = pane.loadingTask = pane.plane = null;
  pane.models = []; pane.renderingModels = new Set(); pane.geometryDirtyModels = new Set();
  pane.textCache = new LruTextCache(CFG.TEXT_CACHE_PAGES); pane.canvasBytes = 0;
  pane.currentPage = 0; pane.pageInput.value = '0'; pane.totalEl.textContent = '/ 0';
  pane.nameEl.textContent = `打开${pane.side === 'left' ? '左' : '右'}侧 PDF`;
  pane.showEmpty();
  return snapshot;
}
function restorePane(pane, snapshot) {
  ++pane.generation;
  for (const key of documentKeys) pane[key] = snapshot[key];
  pane.wheelZoomTargetScale = pane.scale;
  pane.renderingModels = new Set(); pane.geometryDirtyModels = new Set();
  pane.pagesEl.replaceChildren(snapshot.fragment);
  pane.pagesEl.classList.remove('empty-surface'); pane.pagesEl.setAttribute('style',snapshot.style);
  pane.paneEl.classList.add('loaded'); pane.nameEl.textContent = pane.file.name; pane.nameEl.title = pane.file.name;
  pane.pageInput.value = String(pane.currentPage); pane.totalEl.textContent = `/ ${pane.pdf.numPages}`;
  pane.updateZoomUI(); pane.setStatus(`${pane.pdf.numPages} 页 · ${formatBytes(pane.file.size)}`);
  pane.refreshViewportMetrics(); pane.updateSurfaceGeometry(pane.layoutScale);
  if(snapshot.view.anchor)pane.restoreLocalAnchor(snapshot.view.anchor);
  else {pane.viewer.scrollTop = snapshot.view.scrollTop; pane.viewer.scrollLeft = snapshot.view.scrollLeft;}
  pane.onResize(); pane.renderNearViewport(); pane.scheduleSharpRender();
}
function parkCurrentTab() {
  const tab = activeWorkspaceTab();
  if (!tab) return;
  if (document.body.classList.contains('zen')) setZen(false);
  resetSearch(); $('#searchPanel').hidden = true; clearMirrorSelection();
  for (const side of ['left','right']) {
    const snapshot = capturePane(panes[side]);
    if (snapshot) { tab.snapshots[side] = snapshot; tab.sources[side].view = snapshot.view; }
  }
  tab.layout = appState.layout; tab.lastUsed = Date.now();
}
async function disposeSnapshot(snapshot) {
  if (!snapshot) return;
  for (const model of snapshot.models) { model.canvas.width = model.canvas.height = 1; model.textLayer?.cancel?.(); }
  try { await snapshot.loadingTask?.destroy(); } catch {}
  snapshot.fragment.replaceChildren(); snapshot.models.length = 0;
}
async function evictWorkspaceCache() {
  const warm = workspace.tabs.filter(tab => tab.id !== workspace.active && Object.values(tab.snapshots).some(Boolean)).sort((a,b) => b.lastUsed-a.lastUsed);
  for (const tab of warm.slice(2)) {
    for (const side of ['left','right']) { await disposeSnapshot(tab.snapshots[side]); tab.snapshots[side] = null; }
  }
}
async function showWorkspaceHome(section = workspace.section) {
  if(section==='all')section='recent';
  parkCurrentTab(); workspace.active = null; workspace.section = section;
  $('#readerPanel').hidden = true; $('#homePanel').hidden = false; document.body.dataset.view = 'home';
  if (document.body.classList.contains('zen')) setZen(false);
  document.querySelectorAll('[data-section]').forEach(button => {
    const selected = button.dataset.section === section; button.classList.toggle('active',selected);
    if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  const title = section === 'starred' ? '我的收藏' : '主页';
  $('#sectionBreadcrumb').textContent = title; $('#recentTitle').textContent = section === 'starred' ? '我的收藏' : '最近打开';
  $('.feature-row').hidden=section!=='recent';
  renderWorkspaceTabs(); saveWorkspaceTabs();
  await renderRecentFiles(); await evictWorkspaceCache();
}
async function activateWorkspaceTab(id, { focus = false } = {}) {
  if (workspace.active === id) return;
  const tab = workspace.tabs.find(item => item.id === id); if (!tab) return;
  parkCurrentTab(); workspace.active = id; tab.lastUsed = Date.now();
  document.body.dataset.view = 'reader'; $('#homePanel').hidden = true; $('#readerPanel').hidden = false;
  setLayout(tab.layout || (tab.mode === 'compare' ? 'dual' : 'left'),false);
  applyReadingMode(tab.readingMode,false); renderWorkspaceTabs(focus ? id : null);
  await nextFrame();
  for (const side of ['left','right']) {
    const snapshot = tab.snapshots[side]; tab.snapshots[side] = null;
    if (snapshot?.pdf) restorePane(panes[side],snapshot);
    else if (tab.sources[side]) await loadTabSource(tab,side);
  }
  refreshSessionHint(); saveWorkspaceTabs(); await evictWorkspaceCache();
}
function createWorkspaceTab(mode = 'single') {
  const tab = { id:`w${Date.now().toString(36)}${++workspace.serial}`, mode, sources:{}, snapshots:{}, readingMode:workspacePrefs.readingMode, layout:mode === 'compare' ? 'dual' : 'left', lastUsed:Date.now(), loading:false };
  workspace.tabs.push(tab); return tab;
}
async function loadTabSource(tab, side, persistBlob = false) {
  const source = tab.sources[side]; if (!source) return;
  tab.loading = true; renderWorkspaceTabs();
  try {
    await paneLoad[side](source.file,{ docId:source.docId, restoreState:source.view, persistBlob, silent:true });
    source.docId = panes[side].docId; source.view = viewOf(panes[side]); source.pages = panes[side].pdf.numPages;
    setTimeout(() => enqueueWorkspace(() => cacheRecentMetadata(source,side)),850);
  } catch (error) {
    toast(`无法打开「${source.file.name}」：${error?.message || '文件可能已损坏'}`,true);
    // A failed parse must leave no half-open document or worker in the live pane.
    await panes[side].destroyDocument(); delete tab.sources[side];
  } finally { tab.loading = false; renderWorkspaceTabs(); }
}
async function cacheRecentMetadata(source, side) {
  try {
    const rec = await dbGetDoc(source.docId); if (!rec) return;
    rec.pages = source.pages;
    // Only capture a matching document; a delayed thumbnail task cannot read another tab.
    const pane = panes[side];
    if (pane.docId === source.docId && pane.models[0]?.canvas?.width > 1) {
      const canvas = pane.models[0].canvas, thumb = document.createElement('canvas');
      thumb.width = 100; thumb.height = Math.round(canvas.height*100/canvas.width);
      thumb.getContext('2d').drawImage(canvas,0,0,thumb.width,thumb.height); rec.thumbnail = thumb.toDataURL('image/webp',.65);
    }
    await dbPutDoc(rec);
  } catch { /* Saving a thumbnail is optional, opening the PDF is not. */ }
}
async function openWorkspaceFiles(files, { compare = false, targetSide = null } = {}) {
  const valid = Array.from(files).filter(file => /\.pdf$/i.test(file.name) || file.type === 'application/pdf');
  if (!valid.length) { toast('请选择 PDF 格式的文件。',true); return; }
  for (let index=0;index<valid.length;index++) {
    const file = valid[index];
    if (!file.size) { toast(`「${file.name}」是空文件。`,true); continue; }
    const docId = await makeDocId(file);
    let tab = activeWorkspaceTab();
    let side = targetSide || 'left';
    const fillCompare = tab && targetSide && (tab.mode === 'compare' || appState.layout === 'dual');
    if (fillCompare) {
      tab.mode = 'compare';
      if (panes[side].file) await panes[side].destroyDocument();
    } else {
      const existing = workspace.tabs.find(item => item.mode === 'single' && item.sources.left?.docId === docId);
      if (existing && !compare) { await activateWorkspaceTab(existing.id); continue; }
      tab = createWorkspaceTab(compare ? 'compare' : 'single');
      await activateWorkspaceTab(tab.id);
      side = 'left';
    }
    let savedView = await dbGetView(docId,side).catch(() => null);
    if (!savedView && side === 'left') savedView = await dbGetView(docId,'right').catch(() => null);
    tab.sources[side] = {file,docId,view:savedView};
    await loadTabSource(tab,side,true);
    if (!tab.sources.left && !tab.sources.right && tab.mode === 'single') {
      await closeWorkspaceTab(tab.id); continue;
    }
    if (compare && valid[index+1]) {
      const rightFile = valid[++index], rightId = await makeDocId(rightFile);
      tab.sources.right = {file:rightFile,docId:rightId,view:await dbGetView(rightId,'right').catch(() => null)};
      await loadTabSource(tab,'right',true); tab.layout = 'dual'; setLayout('dual',false);
    }
    renderWorkspaceTabs(); saveWorkspaceTabs();
  }
  await evictWorkspaceCache();
}
async function closeWorkspaceTab(id) {
  const index = workspace.tabs.findIndex(tab => tab.id === id); if (index < 0) return;
  const tab = workspace.tabs[index], active = workspace.active === id;
  if (active) { parkCurrentTab(); workspace.active = null; }
  if(Object.keys(tab.sources).length){workspace.closed.unshift({...tab,snapshots:{}});workspace.closed.length=Math.min(8,workspace.closed.length);}
  for (const side of ['left','right']) await disposeSnapshot(tab.snapshots[side]);
  workspace.tabs.splice(index,1);
  if (active) {
    const next = workspace.tabs[Math.min(index,workspace.tabs.length-1)];
    if (next) await activateWorkspaceTab(next.id,{focus:true}); else await showWorkspaceHome();
  }
  renderWorkspaceTabs(); saveWorkspaceTabs();
}
async function openRecentDoc(id) {
  const existing = workspace.tabs.find(tab => tab.mode === 'single' && tab.sources.left?.docId === id);
  if (existing) { await activateWorkspaceTab(existing.id); return; }
  const record = await dbGetDoc(id);
  if (!record?.blob) { toast('此文件副本已不可用，请重新选择 PDF。',true); filePicker.click(); return; }
  const file = new File([record.blob],record.name,{type:record.type || 'application/pdf',lastModified:record.lastModified || 0});
  const tab = createWorkspaceTab(); tab.sources.left = {file,docId:id,view:await dbGetView(id,'left').catch(() => null)};
  await activateWorkspaceTab(tab.id);
  if (!tab.sources.left) await closeWorkspaceTab(tab.id);
}

function relativeOpened(timestamp) {
  const elapsed = Math.max(0,Date.now()-timestamp);
  if (elapsed < 60000) return '刚刚打开';
  if (elapsed < 3600000) return `${Math.floor(elapsed/60000)} 分钟前`;
  const today = new Date(); today.setHours(0,0,0,0);
  if (timestamp >= today.getTime()) return `今天 ${new Date(timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
  if (timestamp >= today.getTime()-86400000) return '昨天';
  return new Date(timestamp).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
}
async function renderRecentFiles() {
  const token = ++workspace.renderToken;
  try {
    const [docs,views] = await Promise.all([dbGetDocs(),idb('views','readonly',store => store.getAll())]);
    if (token !== workspace.renderToken) return;
    workspace.recent = docs; workspace.views = views || [];
    paintRecentFiles();
  } catch {
    if (token !== workspace.renderToken) return;
    $('#recentFiles').innerHTML = `<div class="files-empty"><span class="empty-file-icon">${icon('folder')}</span><h3>文件历史暂时不可用</h3><p>你仍可打开 PDF 阅读。请检查浏览器是否允许本站保存本地数据。</p><button class="text-button" data-action="open">打开 PDF ${icon('arrow')}</button></div>`;
  }
}
function paintRecentFiles() {
  const filter = $('#fileSearch').value.trim().toLocaleLowerCase();
  const order = $('#fileSort').value;
  const starred = new Set(workspacePrefs.starred);
  $('#starCount').textContent = workspace.recent.filter(doc => starred.has(doc.id)).length;
  let docs = workspace.recent.filter(doc => (!filter || doc.name.toLocaleLowerCase().includes(filter)) && (workspace.section !== 'starred' || starred.has(doc.id)));
  if (order === 'name') docs.sort((a,b) => a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  if (order === 'size') docs.sort((a,b) => b.size-a.size);
  $('#fileCountLabel').textContent = `${docs.length} 份文件`;
  const container = $('#recentFiles'); container.classList.toggle('grid-view',workspacePrefs.fileView === 'grid');
  document.querySelectorAll('[data-view-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.viewMode === workspacePrefs.fileView)));
  if (!docs.length) {
    const title = filter ? '没有找到匹配的文件' : workspace.section === 'starred' ? '暂无收藏文件' : '暂无最近文件';
    const subtitle = filter ? '试试其他文件名，或打开一份新的 PDF。' : workspace.section === 'starred' ? '点击文件旁的星标，即可加入收藏。' : '打开的 PDF 会保存在这里，并记住上次阅读的位置。';
    container.innerHTML = `<div class="files-empty"><span class="empty-file-icon">${icon(workspace.section === 'starred' ? 'star':'folder')}</span><h3>${title}</h3><p>${subtitle}</p><button class="text-button" data-action="open">打开 PDF 文件 ${icon('arrow')}</button></div>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  if (workspacePrefs.fileView !== 'grid') {
    const header = document.createElement('div'); header.className = 'file-table-head'; header.setAttribute('aria-hidden','true');
    header.innerHTML = '<span>文件名称</span><span class="file-size">文件大小</span><span class="file-date">上次打开</span><span class="file-progress">阅读进度</span><span>操作</span>'; fragment.append(header);
  }
  for (const doc of docs) {
    const view = workspace.views.filter(item => item.docId === doc.id).sort((a,b) => (b.updated||0)-(a.updated||0))[0];
    const row = document.createElement('div'); row.className = 'file-row';
    const open = document.createElement('button'); open.className = 'file-open'; open.title = `打开 ${doc.name}`;
    open.dataset.recentId = doc.id;
    const badge = document.createElement('span'); badge.className = 'file-type-icon'; badge.textContent = 'PDF';
    const name = document.createElement('span'); name.className = 'file-name';
    const strong = document.createElement('strong'); strong.textContent = doc.name;
    const small = document.createElement('small'); small.textContent = doc.pages ? `${doc.pages} 页 · 本地文档` : 'PDF 文档 · 本地保存';
    name.append(strong,small);
    if (workspacePrefs.fileView === 'grid') {
      const preview=document.createElement('span'); preview.className='file-preview';
      if(doc.thumbnail){const image=document.createElement('img'); image.src=doc.thumbnail; image.alt=''; image.loading='lazy'; image.width=100; image.height=130;preview.append(image);}
      else{preview.classList.add('is-placeholder');preview.append(badge);}
      open.append(preview,name);
    } else open.append(badge,name);
    const size = document.createElement('span'); size.className='file-size'; size.textContent=formatBytes(doc.size || 0);
    const date = document.createElement('span'); date.className='file-date'; date.textContent=relativeOpened(doc.lastOpened||0); date.title = formatTime(doc.lastOpened);
    const progress = document.createElement('span'); progress.className='file-progress'; progress.textContent = view ? `第 ${view.currentPage} 页` : '未阅读';
    const actions = document.createElement('div'); actions.className='file-actions';
    const favorite = document.createElement('button'); favorite.dataset.starId=doc.id; favorite.classList.toggle('is-starred',starred.has(doc.id));
    favorite.title=starred.has(doc.id)?'取消收藏':'加入收藏'; favorite.setAttribute('aria-label',`${favorite.title} ${doc.name}`); favorite.setAttribute('aria-pressed',String(starred.has(doc.id))); favorite.innerHTML=icon('star');
    const remove = document.createElement('button'); remove.dataset.removeId=doc.id; remove.title='从最近文件移除'; remove.setAttribute('aria-label',`从最近文件移除 ${doc.name}`); remove.innerHTML=icon('trash');
    actions.append(favorite,remove); row.append(open,size,date,progress,actions); fragment.append(row);
  }
  container.replaceChildren(fragment);
}
let removedRecord = null;
async function removeRecentDoc(id) {
  const rec = await dbGetDoc(id); if (!rec) return;
  const views = workspace.views.filter(view => view.docId === id);
  await dbDeleteDoc(id); removedRecord = {rec,views};
  await renderRecentFiles(); toast(`已移除「${rec.name}」`);
  const undo = document.createElement('button'); undo.className='toast-action'; undo.textContent='撤销';
  undo.onclick = () => enqueueWorkspace(async () => { const removed = removedRecord; if (!removed) return; await dbPutDoc(removed.rec); for (const view of removed.views) await dbPutView(view); removedRecord=null; await renderRecentFiles(); toast('已恢复文件与阅读进度'); });
  $('#toast').append(undo); clearTimeout(toastTimer); toastTimer=setTimeout(() => { $('#toast').className='toast'; removedRecord=null; },10000);
}
async function restoreWorkspaceTabList() {
  const saved = safeRead(TABS_KEY,[]);
  const entries=Array.isArray(saved)?saved:Array.isArray(saved.tabs)?saved.tabs:[];
  for (const entry of entries.slice(0,60)) {
    if (!entry || !['single','compare'].includes(entry.mode)) continue;
    const sources = {};
    for (const side of ['left','right']) {
      if (!entry.sources?.[side]?.docId) continue;
      const rec = await dbGetDoc(entry.sources[side].docId).catch(() => null);
      if (rec?.blob) sources[side] = {docId:rec.id,file:new File([rec.blob],rec.name,{type:'application/pdf',lastModified:rec.lastModified||0}),view:await dbGetView(rec.id,side).catch(() => null)};
    }
    if (!Object.keys(sources).length && entry.mode!=='compare') continue;
    const tab=createWorkspaceTab(entry.mode); tab.sources=sources; tab.readingMode=readingModes.includes(entry.readingMode)?entry.readingMode:workspacePrefs.readingMode;
    if(typeof entry.id==='string'&&/^w[a-z0-9]+$/i.test(entry.id)&&!workspace.tabs.some(other=>other!==tab&&other.id===entry.id))tab.id=entry.id;
    if(['left','right','dual'].includes(entry.layout))tab.layout=entry.layout;
  }
  if(!Array.isArray(saved)&&Array.isArray(saved.closed))workspace.closed=saved.closed.filter(tab=>tab&&['single','compare'].includes(tab.mode)&&tab.sources).slice(0,8);
  renderWorkspaceTabs();
  return Array.isArray(saved)?{}:saved;
}
async function reopenClosedTab(){
  const previous=workspace.closed.shift();if(!previous){toast('没有可恢复的已关闭标签。');return;}
  const tab=createWorkspaceTab(previous.mode);tab.layout=previous.layout||tab.layout;tab.readingMode=previous.readingMode||workspacePrefs.readingMode;
  for(const side of ['left','right']){
    const source=previous.sources[side];if(!source?.docId)continue;
    if(source.file)tab.sources[side]={...source};
    else{const record=await dbGetDoc(source.docId).catch(()=>null);if(record?.blob)tab.sources[side]={docId:record.id,file:new File([record.blob],record.name,{type:'application/pdf',lastModified:record.lastModified||0}),view:await dbGetView(record.id,side).catch(()=>null)};}
  }
  if(!Object.keys(tab.sources).length&&tab.mode!=='compare'){workspace.tabs=workspace.tabs.filter(item=>item!==tab);toast('文件副本已移除，无法恢复此标签。',true);saveWorkspaceTabs();return;}
  await activateWorkspaceTab(tab.id,{focus:true});saveWorkspaceTabs();
}

function applyWorkspaceTheme(choice, persist = true) {
  workspacePrefs.theme = ['light','dark','system'].includes(choice)?choice:'system';
  const dark = workspacePrefs.theme === 'dark' || (workspacePrefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark?'dark':'light';
  $('meta[name="theme-color"]').content=dark?'#121A24':'#F5F5F7';
  $('#themeBtn').innerHTML=icon(dark?'sun':'moon'); $('#themeBtn').setAttribute('aria-label',dark?'切换到浅色主题':'切换到深色主题');
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.themeChoice===workspacePrefs.theme)));
  if (persist) safeWrite(PREF_KEY,workspacePrefs);
}
function applyReadingMode(mode, persist = true) {
  const value=readingModes.includes(mode)?mode:'original';
  $('#readerPanel').dataset.readingMode=value;
  const active=activeWorkspaceTab(); if (active) active.readingMode=value;
  document.querySelectorAll('button[data-reading-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.readingMode===value)));
  const modeButton=$('#readingModeBtn');
  if (modeButton) { modeButton.setAttribute('aria-pressed',String(value!=='original')); modeButton.title=`PDF 颜色：${{original:'原始颜色',dark:'柔和深色',invert:'完全反色',paper:'暖色纸张'}[value]}（点击切换深色，右侧设置可选全部模式）`; }
  if (persist) { workspacePrefs.readingMode=value; safeWrite(PREF_KEY,workspacePrefs); saveWorkspaceTabs(); }
}
function openPreferences() { applyReadingMode(activeWorkspaceTab()?.readingMode || workspacePrefs.readingMode,false); $('#preferencesDialog').showModal(); }
function createReaderActions() {
  const actions=$('.top-actions');
  const mode=document.createElement('button'); mode.id='readingModeBtn'; mode.className='reader-mode-button'; mode.setAttribute('aria-label','切换 PDF 深色阅读'); mode.innerHTML=icon('moon')+'<span class="button-label">深色阅读</span>';
  mode.onclick=()=>applyReadingMode($('#readerPanel').dataset.readingMode==='original'?'dark':'original');
  const settings=document.createElement('button'); settings.id='readerPreferencesBtn'; settings.title='阅读颜色与界面偏好'; settings.setAttribute('aria-label','阅读偏好'); settings.innerHTML=icon('settings'); settings.onclick=openPreferences;
  const download=document.createElement('button'); download.title='下载当前 PDF'; download.setAttribute('aria-label','下载当前 PDF'); download.innerHTML=icon('download');
  download.onclick=()=>{const pane=panes[appState.activeSide];if(!pane.file){toast('请先打开一份 PDF。');return}const url=URL.createObjectURL(pane.file),link=document.createElement('a');link.href=url;link.download=pane.file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)};
  const history=document.createElement('button');history.id='readerHistoryBtn';history.title='历史文件：选择在左侧或右侧打开';history.setAttribute('aria-label','历史文件');history.innerHTML=icon('clock');history.onclick=openHistory;
  const images=document.createElement('button');images.id='pdfImageExportBtn';images.title='将当前 PDF 转为高清图片';images.setAttribute('aria-label','PDF 转图片');images.innerHTML=icon('image')+'<span class="button-label">转图片</span>';images.onclick=openImageExport;
  actions.prepend(mode,images,settings,download,history);
  $('#historyBtn').title='返回主页'; $('#historyBtn').setAttribute('aria-label','返回主页'); $('#historyBtn').innerHTML=icon('home');
  $('#historyBtn').onclick=()=>enqueueWorkspace(()=>showWorkspaceHome());
  const status=document.createElement('span'); status.className='reader-status-bar'; status.textContent='本地处理 · 自动保存阅读进度'; $('#readerPanel').append(status);
}
createReaderActions();
initImageExport();
for(const pane of Object.values(panes))installPdfTouch(pane);
restoreHistoryDoc=(rec,side,{silent=false}={})=>enqueueWorkspace(async()=>{
  if(!rec?.blob){toast('此历史文件没有保存副本，请重新选择 PDF。',true);return;}
  closeHistory();
  let tab=activeWorkspaceTab();
  if(!tab){tab=createWorkspaceTab('compare');await activateWorkspaceTab(tab.id);}
  tab.mode='compare';tab.layout='dual';setLayout('dual',false);
  if(panes[side].file)await panes[side].destroyDocument();
  tab.sources[side]={file:new File([rec.blob],rec.name,{type:'application/pdf',lastModified:rec.lastModified||0}),docId:rec.id,view:await dbGetView(rec.id,side).catch(()=>null)};
  await loadTabSource(tab,side);saveWorkspaceTabs();renderWorkspaceTabs();
});
function setupReaderOverflow(){
  const actions=$('.top-actions'),menu=document.createElement('div');menu.id='readerMoreMenu';menu.className='reader-overflow';menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','全部阅读工具');$('#readerPanel').append(menu);
  const more=document.createElement('button');more.id='readerMoreBtn';more.title='全部阅读工具';more.setAttribute('aria-label','全部阅读工具');more.setAttribute('aria-expanded','false');more.innerHTML=icon('more');actions.append(more);
  const items=[['readerHistoryBtn','历史文件'],['readerPreferencesBtn','阅读偏好'],['syncMenuBtn','双栏联动设置'],['fitAll','适合页面宽度'],['zenBtn','专注阅读'],['fullBtn','浏览器全屏']].map(([id,label])=>({button:document.getElementById(id),label}));
  const download=actions.querySelector('[aria-label="下载当前 PDF"]');items.push({button:download,label:'下载当前 PDF'});
  for(const item of items){const label=document.createElement('span');label.className='overflow-label';label.textContent=item.label;item.button.append(label);}
  function close(){menu.hidden=true;more.setAttribute('aria-expanded','false');}
  function arrange(){const compact=matchMedia('(max-width:700px)').matches;for(const {button} of items)(compact?menu:actions).append(button);more.hidden=!compact;close();}
  more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));};
  menu.addEventListener('click',event=>{if(event.target.closest('button'))close()});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#readerMoreMenu,#readerMoreBtn'))close()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close()});
  matchMedia('(max-width:700px)').addEventListener('change',arrange);arrange();
}
setupReaderOverflow();
applyWorkspaceTheme(workspacePrefs.theme,false); applyReadingMode(workspacePrefs.readingMode,false);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(workspacePrefs.theme==='system')applyWorkspaceTheme('system',false)});
$('#themeBtn').onclick=()=>applyWorkspaceTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('#preferencesBtn').onclick=openPreferences;
$('#helpBtn').onclick=()=>$('#helpDialog').showModal();
for(const button of document.querySelectorAll('[data-close-dialog]'))button.onclick=()=>button.closest('dialog').close();
for(const dialog of document.querySelectorAll('.app-dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close()}});
for(const button of document.querySelectorAll('[data-theme-choice]'))button.onclick=()=>applyWorkspaceTheme(button.dataset.themeChoice);
for(const button of document.querySelectorAll('button[data-reading-mode]'))button.onclick=()=>applyReadingMode(button.dataset.readingMode);

filePicker.onchange=event=>{const files=Array.from(event.target.files||[]);event.target.value='';if(files.length)enqueueWorkspace(()=>openWorkspaceFiles(files))};
$('#leftFile').multiple=true; $('#rightFile').multiple=true;
for(const side of ['left','right']){
  $(`#${side}File`).onchange=event=>{const files=Array.from(event.target.files||[]);event.target.value='';if(files.length)enqueueWorkspace(()=>openWorkspaceFiles(files,{targetSide:activeWorkspaceTab()?.mode==='compare'||appState.layout==='dual'?side:null}))};
  // Pane drop handlers and the legacy history drawer enter the same serialized path.
  panes[side].loadFile=(file)=>enqueueWorkspace(()=>openWorkspaceFiles([file],{targetSide:activeWorkspaceTab()?.mode==='compare'||appState.layout==='dual'?side:null}));
}
$('#homeTab').onclick=()=>enqueueWorkspace(()=>showWorkspaceHome());
$('#newTabBtn').onclick=()=>enqueueWorkspace(()=>showWorkspaceHome('recent'));
document.addEventListener('click',event=>{
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='open')filePicker.click();
  if(action==='preferences')openPreferences();
  if(action==='help')$('#helpDialog').showModal();
  if(action==='pdf-images')openImageExport();
  if(action==='tabs')enqueueWorkspace(async()=>{const tab=workspace.tabs.at(-1);if(tab)await activateWorkspaceTab(tab.id);else toast('打开 PDF 后，可通过顶部标签随时切换文档。')});
  if(action==='compare')enqueueWorkspace(async()=>{const tab=createWorkspaceTab('compare');await activateWorkspaceTab(tab.id);toast('在左右两侧分别打开 PDF，开始对照阅读。')});
  const section=event.target.closest('[data-section]');if(section)enqueueWorkspace(()=>showWorkspaceHome(section.dataset.section));
  const close=event.target.closest('[data-close-tab]');if(close){event.stopPropagation();enqueueWorkspace(()=>closeWorkspaceTab(close.dataset.closeTab));return}
  const tab=event.target.closest('[data-tab-id]');if(tab)enqueueWorkspace(()=>activateWorkspaceTab(tab.dataset.tabId));
  const recent=event.target.closest('[data-recent-id]');if(recent)enqueueWorkspace(()=>openRecentDoc(recent.dataset.recentId));
  const star=event.target.closest('[data-star-id]');if(star){const id=star.dataset.starId;workspacePrefs.starred=workspacePrefs.starred.includes(id)?workspacePrefs.starred.filter(value=>value!==id):[...workspacePrefs.starred,id];safeWrite(PREF_KEY,workspacePrefs);paintRecentFiles()}
  const remove=event.target.closest('[data-remove-id]');if(remove)enqueueWorkspace(()=>removeRecentDoc(remove.dataset.removeId));
  const view=event.target.closest('[data-view-mode]');if(view){workspacePrefs.fileView=view.dataset.viewMode;safeWrite(PREF_KEY,workspacePrefs);paintRecentFiles()}
});
$('#fileSearch').oninput=()=>{clearTimeout(homeRenderTimer);homeRenderTimer=setTimeout(paintRecentFiles,90)};
$('#fileSort').onchange=paintRecentFiles;
$('#tabList').addEventListener('auxclick',event=>{const tab=event.target.closest('[data-tab-id]');if(event.button===1&&tab){event.preventDefault();enqueueWorkspace(()=>closeWorkspaceTab(tab.dataset.tabId))}});
$('#tabList').addEventListener('keydown',event=>{
  const tabs=[$('#homeTab'),...$('#tabList').querySelectorAll('[role=tab].document-tab')];const current=tabs.indexOf(event.target);
  if(current<0)return;
  if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    const tab=tabs[index];enqueueWorkspace(async()=>{if(index===0)await showWorkspaceHome();else await activateWorkspaceTab(tab.dataset.tabId);const fresh=index===0?$('#homeTab'):document.getElementById(tab.id);fresh?.focus({preventScroll:true})});
  }else if((event.key==='Enter'||event.key===' ')&&event.target.dataset.tabId){event.preventDefault();enqueueWorkspace(()=>activateWorkspaceTab(event.target.dataset.tabId))}
  else if(event.key==='Delete'&&event.target.dataset.tabId){event.preventDefault();enqueueWorkspace(()=>closeWorkspaceTab(event.target.dataset.tabId))}
});
$('#tabList').addEventListener('dragstart',event=>{const tab=event.target.closest('[data-tab-id]');if(!tab)return;workspace.dragId=tab.dataset.tabId;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-dualpdf-tab',workspace.dragId)});
$('#tabList').addEventListener('dragover',event=>{if(workspace.dragId)event.preventDefault()});
$('#tabList').addEventListener('drop',event=>{if(!workspace.dragId)return;event.preventDefault();event.stopPropagation();const target=event.target.closest('[data-tab-id]');if(target&&target.dataset.tabId!==workspace.dragId){const from=workspace.tabs.findIndex(tab=>tab.id===workspace.dragId),to=workspace.tabs.findIndex(tab=>tab.id===target.dataset.tabId);const [tab]=workspace.tabs.splice(from,1);workspace.tabs.splice(to,0,tab);renderWorkspaceTabs();saveWorkspaceTabs()}workspace.dragId=null});
$('#tabList').addEventListener('dragend',()=>workspace.dragId=null);
$('#tabList').addEventListener('wheel',event=>{const list=event.currentTarget;if(list.scrollWidth>list.clientWidth&&Math.abs(event.deltaY)>Math.abs(event.deltaX)){event.preventDefault();list.scrollLeft+=event.deltaY;}},{passive:false});
function setupTabContextMenu(){
  const menu=document.createElement('div');menu.id='tabContextMenu';menu.className='tab-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','标签页操作');menu.hidden=true;$('.app').append(menu);
  const labels=[['close','关闭标签'],['others','关闭其他标签'],['right','关闭右侧标签'],['reopen','重新打开已关闭标签']];
  for(const [action,label] of labels){const button=document.createElement('button');button.setAttribute('role','menuitem');button.dataset.tabCommand=action;button.textContent=label;menu.append(button);}
  let target=null;
  $('#tabList').addEventListener('contextmenu',event=>{
    const tab=event.target.closest('[data-tab-id]');if(!tab)return;
    event.preventDefault();target=tab.dataset.tabId;
    menu.querySelector('[data-tab-command="reopen"]').disabled=!workspace.closed.length;
    menu.hidden=false;menu.style.left=`${Math.max(8,Math.min(event.clientX,innerWidth-224))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,innerHeight-188))}px`;menu.querySelector('button').focus();
  });
  menu.addEventListener('click',event=>{const command=event.target.closest('[data-tab-command]')?.dataset.tabCommand;if(!command)return;menu.hidden=true;const id=target;enqueueWorkspace(async()=>{
    if(command==='reopen'){await reopenClosedTab();return;}
    if(command==='close'){await closeWorkspaceTab(id);return;}
    const index=workspace.tabs.findIndex(tab=>tab.id===id);if(index<0)return;
    const ids=workspace.tabs.filter((tab,i)=>command==='others'?tab.id!==id:i>index).map(tab=>tab.id);
    if(ids.includes(workspace.active))await activateWorkspaceTab(id);
    for(const closeId of ids)await closeWorkspaceTab(closeId);
  });});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#tabContextMenu'))menu.hidden=true});
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.hidden=true;document.getElementById(`tab-${target}`)?.focus();}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});
}
setupTabContextMenu();
for(const select of document.querySelectorAll('select'))select._customControl=enhanceWorkspaceSelect(select);

let fileDragDepth=0;
document.addEventListener('dragenter',event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();fileDragDepth++;$('#dropOverlay').hidden=false},true);
document.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy'}},true);
document.addEventListener('dragleave',()=>{fileDragDepth=Math.max(0,fileDragDepth-1);if(!fileDragDepth)$('#dropOverlay').hidden=true},true);
document.addEventListener('drop',event=>{
  if(!Array.from(event.dataTransfer.types).includes('Files'))return;
  event.preventDefault();event.stopImmediatePropagation();fileDragDepth=0;$('#dropOverlay').hidden=true;
  const side=event.target.closest('[data-side]')?.dataset.side;
  const files=Array.from(event.dataTransfer.files);
  enqueueWorkspace(()=>openWorkspaceFiles(files,{targetSide:activeWorkspaceTab()?.mode==='compare'||appState.layout==='dual'?side:null}));
},true);
window.addEventListener('blur',()=>{fileDragDepth=0;$('#dropOverlay').hidden=true});
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]'))return;
  const editable=['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o'){event.preventDefault();event.stopImmediatePropagation();filePicker.click();return}
  if(event.altKey&&!event.ctrlKey&&!event.metaKey){
    if(event.shiftKey&&event.key.toLowerCase()==='t'){event.preventDefault();enqueueWorkspace(reopenClosedTab);return;}
    if(event.key.toLowerCase()==='t'){event.preventDefault();enqueueWorkspace(()=>showWorkspaceHome('recent'));return}
    if(event.key.toLowerCase()==='w'&&workspace.active){event.preventDefault();enqueueWorkspace(()=>closeWorkspaceTab(workspace.active));return}
    if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const ids=[null,...workspace.tabs.map(tab=>tab.id)],index=ids.indexOf(workspace.active),next=ids[(index+(event.key==='ArrowRight'?1:-1)+ids.length)%ids.length];enqueueWorkspace(()=>next?activateWorkspaceTab(next):showWorkspaceHome());return}
  }
  if(!workspace.active){
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopImmediatePropagation();$('#fileSearch').focus();return}
    if(!editable&&event.key==='/'){event.preventDefault();$('#fileSearch').focus();return}
    if(!editable&&['PageDown','PageUp','f','F',' '].includes(event.key)){event.stopImmediatePropagation();return}
  }
  if(!editable&&event.key==='?'){event.preventDefault();$('#helpDialog').showModal()}
},true);

// Persist on backgrounding as well as closing: mobile browsers often skip beforeunload.
function persistWorkspaceViews(){
  const tab=activeWorkspaceTab();if(tab){for(const side of ['left','right'])if(tab.sources[side]&&panes[side].pdf){tab.sources[side].view=viewOf(panes[side]);panes[side].persistView()}}
  saveWorkspaceTabs();
}
window.addEventListener('pagehide',persistWorkspaceViews);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')persistWorkspaceViews()});
// Restore the selected tab and tab order. Only the foreground PDF is parsed at startup.
enqueueWorkspace(async()=>{const saved=await restoreWorkspaceTabList();if(saved?.active&&workspace.tabs.some(tab=>tab.id===saved.active))await activateWorkspaceTab(saved.active);else await showWorkspaceHome(['recent','all','starred'].includes(saved?.section)?saved.section:'recent')});
