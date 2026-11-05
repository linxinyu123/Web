
let pdfjsLib;
let enginePromise;
let pdfAssetBase = new URL('./vendor/pdfjs/', import.meta.url).href;
async function getPdfEngine() {
  if (!enginePromise) enginePromise = (async () => {
    const cdn = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/';
    if (location.protocol === 'file:') pdfAssetBase = cdn;
    let lib;
    try { lib = await import(pdfAssetBase + 'build/pdf.min.mjs'); }
    catch (error) { if (pdfAssetBase === cdn) throw error; pdfAssetBase = cdn; lib = await import(cdn + 'build/pdf.min.mjs'); }
    pdfjsLib = lib;
    lib.GlobalWorkerOptions.workerSrc = pdfAssetBase + 'build/pdf.worker.min.mjs';
    return lib;
  })().catch(error => { enginePromise = null; throw new Error('PDF 引擎加载失败。请检查网络，或通过本地服务器打开包含 vendor 的完整项目。'); });
  return enginePromise;
}

const $ = s => document.querySelector(s);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CFG = Object.freeze({
  MIN_SCALE: .25,
  MAX_SCALE: 6,
  DEFAULT_SCALE: 1,
  ZOOM_STEP: 1.15,
  DPR_CAP: 1.5,
  FAST_RENDER_SCALE_CAP: 1.75,
  SHARP_RENDER_SCALE_CAP: 3.2,
  FAST_CANVAS_PIXELS: 2_600_000,
  SHARP_CANVAS_PIXELS: 6_000_000,
  CANVAS_MEMORY_BUDGET: matchMedia("(pointer: coarse)").matches ? 50_331_648 : 134_217_728, // 128 MiB per pane
  WHEEL_ZOOM_SETTLE_MS: 110,
  SHARP_IDLE_MS: 260,
  TEXT_IDLE_MS: 180,
  SCROLL_IDLE_MS: 96,
  GEOMETRY_SETTLE_MS: 120,
  MEMORY_PRUNE_IDLE_MS: 700,
  RENDER_OVERSCAN_VIEWPORTS: .9,
  RENDER_CANCEL_OVERSCAN_VIEWPORTS: 2.35,
  INTERACTIVE_RENDER_JOBS: 1,
  MAX_RENDER_JOBS: Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 4) / 3))),
  BUILD_BATCH: 100,
  TEXT_CACHE_PAGES: 36,
  HISTORY_LIMIT: 60,
  SETTINGS_KEY: "dualpdf:settings:v5",
  SESSION_KEY: "dualpdf:last-session:v5",
  DB_NAME: "dualpdf-enterprise-v5",
  DB_VERSION: 1
});

const defaultSettings = { syncScroll: true, syncPage: true, syncZoom: false, syncSelection: true, splitRatio: .5, layout: "left" };

function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(CFG.SETTINGS_KEY) || "{}") } }
  catch { return { ...defaultSettings } }
}

const appState = {
  activeSide: "left", scrollLock: false, spaceDown: false, ctrlDown: false,
  selectionToken: 0, lastSelection: null, ...loadSettings()
};

function persistSettings() {
  const out = { syncScroll: appState.syncScroll, syncPage: appState.syncPage, syncZoom: appState.syncZoom, syncSelection: appState.syncSelection, splitRatio: appState.splitRatio, layout: appState.layout };
  try { localStorage.setItem(CFG.SETTINGS_KEY, JSON.stringify(out)); } catch {}
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"]; let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 || v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatTime(ts) {
  if (!ts) return "";
  try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ts)) }
  catch { return new Date(ts).toLocaleString() }
}

let loadingCount = 0, loadingTimer = 0;
function setLoading(v) {
  loadingCount = Math.max(0, loadingCount + (v ? 1 : -1));
  if (!loadingCount) {clearTimeout(loadingTimer);loadingTimer=0;$("#loading").hidden=true;}
  else if (!loadingTimer) loadingTimer=setTimeout(()=>{if(loadingCount)$("#loading").hidden=false;},150);
}

let toastTimer = 0;
function toast(msg, error = false) {
  const el = $("#toast"); el.textContent = msg; el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = "toast", 3200);
}

class PriorityRenderQueue {
  constructor(limit) { this.limit = limit; this.active = 0; this.jobs = []; this.serial = 0 }
  setLimit(limit) {
    this.limit = Math.max(1, limit | 0);
    this.pump();
  }
  add(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ fn, priority, resolve, reject, serial: this.serial++ });
      this.jobs.sort((a, b) => b.priority - a.priority || a.serial - b.serial);
      this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.jobs.length) {
      const item = this.jobs.shift(); this.active++;
      Promise.resolve().then(item.fn).then(item.resolve, item.reject).finally(() => { this.active--; this.pump() });
    }
  }
}
const renderQueue = new PriorityRenderQueue(CFG.MAX_RENDER_JOBS);

class LruTextCache {
  constructor(limit) { this.limit = limit; this.map = new Map() }
  get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); this.map.set(k, v); while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value); }
  clear() { this.map.clear() }
}

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) { const s = db.createObjectStore("docs", { keyPath: "id" }); s.createIndex("lastOpened", "lastOpened"); }
      if (!db.objectStoreNames.contains("views")) db.createObjectStore("views", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode); const os = tx.objectStore(store);
    let result; try { result = fn(os) } catch (err) { reject(err); return }
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function dbGetDoc(id) { return id ? await idb("docs", "readonly", s => s.get(id)) : null }
async function dbPutDoc(rec) { return idb("docs", "readwrite", s => s.put(rec)) }
async function dbGetDocs() { const docs = await idb("docs", "readonly", s => s.getAll()); return (docs || []).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)); }
async function dbDeleteDoc(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["docs", "views"], "readwrite");
    tx.objectStore("docs").delete(id); tx.objectStore("views").delete(`${id}:left`); tx.objectStore("views").delete(`${id}:right`);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function dbGetView(id, side) { return id ? await idb("views", "readonly", s => s.get(`${id}:${side}`)) : null }
async function dbPutView(rec) { return idb("views", "readwrite", s => s.put(rec)) }

async function makeDocId(file) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  const meta = new TextEncoder().encode(`${file.name}\n${file.size}\n${file.lastModified || 0}\n`);
  const rawBytes = new Uint8Array(meta.length + head.length); rawBytes.set(meta); rawBytes.set(head, meta.length);
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", rawBytes);
    return [...new Uint8Array(buf)].slice(0, 12).map(x => x.toString(16).padStart(2, "0")).join("");
  }
  let h = 2166136261; for (const c of rawBytes) { h ^= c; h = Math.imul(h, 16777619) }
  return `f${(h >>> 0).toString(16)}`;
}

function getSession() { try { return JSON.parse(localStorage.getItem(CFG.SESSION_KEY) || "{}") } catch { return {} } }
function setSessionSide(side, id) { try { const s = getSession(); s[side] = id || null; localStorage.setItem(CFG.SESSION_KEY, JSON.stringify(s)); } catch {} }

async function trimHistory() {
  try {
    const docs = await dbGetDocs(); if (docs.length <= CFG.HISTORY_LIMIT) return;
    const session = getSession(); const keep = new Set([session.left, session.right].filter(Boolean));
    const victims = docs.slice(CFG.HISTORY_LIMIT).filter(d => !keep.has(d.id));
    for (const d of victims) await dbDeleteDoc(d.id);
  } catch (err) { console.warn("trim history failed", err) }
}

class PdfPane {
  constructor(side) {
    this.side = side;
    this.otherSide = side === "left" ? "right" : "left";
    this.paneEl = $(`#${side}Pane`);
    this.viewer = $(`#${side}Viewer`);
    this.pagesEl = $(`#${side}Pages`);
    this.nameEl = $(`#${side}Name`);
    this.pageInput = $(`#${side}Page`);
    this.totalEl = $(`#${side}Total`);
    this.zoomEl = $(`#${side}Zoom`);
    this.statusEl = $(`#${side}Status`);

    // Hot-path layout metrics are cached so scroll handlers never need forced layout reads.
    this.viewportW = this.viewer.clientWidth || 1;
    this.viewportH = this.viewer.clientHeight || 1;
    this.surfaceW = this.viewportW;
    this.surfaceH = this.viewportH;

    this.file = null;
    this.docId = null;
    this.pdf = null;
    this.loadingTask = null;
    this.generation = 0;

    this.scale = CFG.DEFAULT_SCALE;          
    this.layoutScale = CFG.DEFAULT_SCALE;    
    this.zoomMode = "custom";
    this.currentPage = 0;

    this.models = [];
    this.plane = null;
    this.baseSurfaceW = 0;
    this.baseSurfaceH = 0;
    this.planeOffsetX = 0;

    this.scrollRaf = 0;
    this.resizeRaf = 0;
    this.panRaf = 0;
    this.scrollIdleTimer = 0;
    this.viewSaveTimer = 0;
    this.sharpTimer = 0;
    this.geometryTimer = 0;
    this.memoryPruneHandle = 0;
    this.textIdleSerial = 0;
    this.isScrolling = false;
    this.syncEcho = null;
    this.renderingModels = new Set();
    this.geometryDirtyModels = new Set();

    this.textCache = new LruTextCache(CFG.TEXT_CACHE_PAGES);
    this.panState = null;

    this.zoomPreviewActive = false;
    this.wheelZoomTargetScale = this.scale;
    this.wheelZoomTimer = 0;

    // 零漂移数学矩阵状态
    this.zoomAnchor = null;
    this.zoomBaseMx = 0;
    this.zoomBaseMy = 0;
    this.zoomBaseDocX = 0;
    this.zoomBaseDocY = 0;

    this.canvasBytes = 0;

    this.viewer.addEventListener("pointerdown", e => this.onPointerDown(e));
    this.viewer.addEventListener("pointermove", e => this.onPointerMove(e));
    this.viewer.addEventListener("pointerup", e => this.onPointerUp(e));
    this.viewer.addEventListener("pointercancel", e => this.onPointerUp(e));
    this.viewer.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.viewer.addEventListener("wheel", e => this.onWheel(e), { passive: false });
    this.pageInput.addEventListener("change", () => this.goToPage(+this.pageInput.value || 1, true));
    this.pageInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); this.goToPage(+this.pageInput.value || 1, true); this.pageInput.blur(); }
    });

    this.installDrop();
    this.showEmpty();
  }

  other() { return panes[this.otherSide] }

  showEmpty() {
    this.pagesEl.classList.add("empty-surface");
    this.pagesEl.style.cssText = "";
    this.pagesEl.innerHTML = `<div class="empty"><div class="empty-symbol">▤</div><strong>${this.side === "left" ? "打开左侧 PDF" : "打开右侧 PDF"}</strong>拖入 PDF，开始你的阅读。<button onclick="document.getElementById('${this.side}File').click()">选择 PDF</button><div class="tips">Ctrl + 滚轮缩放 · 空格 + 拖动平移<br>拖动中间分隔线，或用顶部按钮切换单栏。</div></div>`;
    this.statusEl.textContent = "";
    this.paneEl.classList.remove("loaded");
  }

  installDrop() {
    let depth = 0;
    this.viewer.addEventListener("dragenter", e => { e.preventDefault(); depth++; this.viewer.classList.add("drag-over") });
    this.viewer.addEventListener("dragover", e => e.preventDefault());
    this.viewer.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.viewer.classList.remove("drag-over");
    });
    this.viewer.addEventListener("drop", e => {
      e.preventDefault();
      depth = 0;
      this.viewer.classList.remove("drag-over");
      const f = [...e.dataTransfer.files].find(x => x.type === "application/pdf" || /\.pdf$/i.test(x.name));
      if (f) this.loadFile(f);
    });
  }

  onPointerDown(e) {
    appState.activeSide = this.side;
    if (e.pointerType === "touch") return;
    const shouldPan = e.button === 1 || (e.button === 0 && (e.ctrlKey || appState.ctrlDown || appState.spaceDown));
    if (!shouldPan) return;

    if (this.zoomPreviewActive) this.commitWheelZoom();
    e.preventDefault();

    this.panState = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      dy: 0
    };
    try { this.viewer.setPointerCapture(e.pointerId) } catch {}
    this.viewer.classList.add("panning");
    this.cancelSharpRender();
    updateRenderConcurrency();
  }

  // Pointer events can arrive far above display refresh rate. Accumulate deltas and write scroll only once per frame.
  onPointerMove(e) {
    if (!this.panState || this.panState.id !== e.pointerId) return;
    e.preventDefault();

    this.panState.dx += e.clientX - this.panState.x;
    this.panState.dy += e.clientY - this.panState.y;
    this.panState.x = e.clientX;
    this.panState.y = e.clientY;

    if (this.panRaf) return;
    this.panRaf = requestAnimationFrame(() => {
      this.panRaf = 0;
      const st = this.panState;
      if (!st) return;
      const dx = st.dx, dy = st.dy;
      st.dx = st.dy = 0;
      if (dx || dy) this.viewer.scrollBy({ left: -dx, top: -dy, behavior: "auto" });
    });
  }

  onPointerUp(e) {
    if (!this.panState || this.panState.id !== e.pointerId) return;
    if (this.panRaf) { cancelAnimationFrame(this.panRaf); this.panRaf = 0; }
    const st = this.panState;
    if (st.dx || st.dy) this.viewer.scrollBy({ left: -st.dx, top: -st.dy, behavior: "auto" });
    try { this.viewer.releasePointerCapture(e.pointerId) } catch {}
    this.panState = null;
    this.viewer.classList.remove("panning");
    updateRenderConcurrency();
    this.armScrollIdle(48);
  }

  async loadFile(file, { docId = null, restoreState = null, persistBlob = true, silent = false } = {}) {
    if (!file) return;
    const generation = ++this.generation;
    appState.activeSide = this.side;
    setLoading(true);
    this.documentOpening=true;this.paneEl.classList.add("document-opening");

    try {
      await this.destroyDocument(false);
      this.file = file;
      this.docId = docId || await makeDocId(file);
      this.nameEl.textContent = file.name;
      this.nameEl.title = file.name;
      this.paneEl.classList.add("loaded");
      this.setStatus(`读取 ${formatBytes(file.size)}…`);

      await getPdfEngine();
      const data = new Uint8Array(await file.arrayBuffer());
      if (generation !== this.generation) return;

      this.loadingTask = pdfjsLib.getDocument({
        data,
        isEvalSupported: false,
        stopAtErrors: false,
        useWorkerFetch: true,
        cMapUrl: pdfAssetBase + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: pdfAssetBase + 'standard_fonts/',
        wasmUrl: pdfAssetBase + 'wasm/',
        iccUrl: pdfAssetBase + 'iccs/'
      });
      this.loadingTask.onPassword = async (updatePassword, reason) => {
        const password = await requestPdfPassword(reason);
        if (password === null) { this.loadingTask?.destroy(); return; }
        updatePassword(password);
      };
      this.pdf = await this.loadingTask.promise;
      if (generation !== this.generation) return;

      if (persistBlob) {
        try {
          const previous = await dbGetDoc(this.docId);
          await dbPutDoc({
            ...previous,
            id: this.docId, name: file.name, size: file.size,
            lastModified: file.lastModified || 0,
            type: file.type || "application/pdf",
            blob: file.slice(0, file.size, file.type || "application/pdf"),
            lastOpened: Date.now()
          });
          trimHistory();
        } catch (err) { toast("文件已打开，但浏览器未能保存副本。请检查可用存储空间。", true); }
      } else {
        try {
          const rec = await dbGetDoc(this.docId);
          if (rec) { rec.lastOpened = Date.now(); await dbPutDoc(rec); }
        } catch {}
      }



      const saved = restoreState || await dbGetView(this.docId, this.side).catch(() => null);
      this.scale = clamp(Number(saved?.scale) || CFG.DEFAULT_SCALE, CFG.MIN_SCALE, CFG.MAX_SCALE);
      this.layoutScale = this.scale;
      this.wheelZoomTargetScale = this.scale;
      this.zoomMode = saved?.zoomMode || "fit-width";
      this.currentPage = this.pdf.numPages ? clamp(Number(saved?.currentPage) || 1, 1, this.pdf.numPages) : 0;
      this.pageInput.value = String(this.currentPage);
      this.totalEl.textContent = `/ ${this.pdf.numPages}`;
      this.updateZoomUI();

      await this.buildModels(generation);
      if (generation !== this.generation) return;
      await this.prepareOpeningGeometry(generation);
      if (generation !== this.generation) return;

      const refitLegacy = saved && !saved.viewportRevision;
      if(refitLegacy) this.zoomMode="fit-width";
      if (this.zoomMode === "fit-width") this.fitWidth({ propagate: false, persist: false });
      else this.updateSurfaceGeometry(this.layoutScale);

      await nextFrame();
      if (saved?.anchor && !refitLegacy) {
        this.restoreLocalAnchor(saved.anchor);
      } else if (saved && !refitLegacy && this.zoomMode === "fit-width") {
        this.goToPage(this.currentPage, false);
      } else if (saved && !refitLegacy) {
        this.viewer.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
        this.viewer.scrollLeft = Math.max(0, Number(saved.scrollLeft) || 0);
      } else if (this.currentPage > 1) {
        this.goToPage(this.currentPage, false);
      }

      this.updateCurrentPage();
      // Reveal only a completed first viewport at its final scale and position.
      for(let pass=0;pass<3;pass++){
        await Promise.all(this.modelsInViewport(0).map(model=>this.ensureRendered(model,400000,"fast")));
        if(generation!==this.generation)return;
        if(this.geometryDirtyModels.size)this.flushGeometryUpdates();
        else if(this.modelsInViewport(0).every(model=>model.canvas?.width>1))break;
      }
      this.documentOpening=false;this.paneEl.classList.remove("document-opening");
      this.updateZoomUI();this.updateCurrentPage();
      this.renderNearViewport({ quality: "fast" });
      this.scheduleSharpRender();

      this.setStatus(`${this.pdf.numPages} 页 · ${formatBytes(file.size)}`);
      setSessionSide(this.side, this.docId);
      if (!silent) toast(`${this.side === "left" ? "左侧" : "右侧"}已打开：${file.name}`);
      refreshSessionHint();
      compareDocumentPair();
      this.schedulePersistView();
    } catch (err) {
      console.error(err);
      this.pdf = null;
      this.pageInput.value = "0";
      this.totalEl.textContent = "/ 0";
      this.setStatus("加载失败");
      this.showEmpty();
      if (!silent) toast(`无法打开：${err?.message || err}`, true);
      throw err;
    } finally {
      if(generation===this.generation){this.documentOpening=false;this.paneEl.classList.remove("document-opening");}
      setLoading(false);
    }
  }

  async prepareOpeningGeometry(generation) {
    const target=this.currentPage||1,numbers=[...new Set([1,target-1,target,target+1])].filter(n=>n>=1&&n<=this.pdf.numPages);
    await Promise.all(numbers.map(async n=>{
      const model=this.models[n-1],page=model.page||await this.pdf.getPage(n);
      if(generation!==this.generation)return;
      const base=page.getViewport({scale:1});model.page=page;model.pageReady=true;
      model.actualW=model.baseW=base.width;model.actualH=model.baseH=base.height;
      model.el.style.width=`${base.width}px`;model.el.style.height=`${base.height}px`;model.el.style.containIntrinsicSize=`${base.width}px ${base.height}px`;
    }));
    if(generation===this.generation)this.recomputeBaseGeometry();
  }

  async buildModels(generation) {
    this.pagesEl.classList.remove("empty-surface");
    this.pagesEl.replaceChildren();
    this.models = new Array(this.pdf.numPages);
    this.canvasBytes = 0;

    let defaultW = 612, defaultH = 792;
    let firstPage = null;
    if (this.pdf.numPages) {
      firstPage = await this.pdf.getPage(1);
      const base = firstPage.getViewport({ scale: 1 });
      defaultW = base.width;
      defaultH = base.height;
    }

    const plane = document.createElement("div");
    plane.className = "page-plane";
    this.plane = plane;

    let frag = document.createDocumentFragment();
    for (let n = 1; n <= this.pdf.numPages; n++) {
      if (generation !== this.generation) return;

      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(n);
      el.style.width = `${defaultW}px`;
      el.style.height = `${defaultH}px`;
      el.style.containIntrinsicSize = `${defaultW}px ${defaultH}px`;

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-bitmap";
      canvas.width = 1;
      canvas.height = 1;

      const textLayerEl = document.createElement("div");
      textLayerEl.className = "textLayer";
      textLayerEl.style.setProperty("--total-scale-factor", "1");

      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = `第 ${n} 页`;

      const badge = document.createElement("div");
      badge.className = "page-no";
      badge.textContent = String(n);

      el.append(canvas, textLayerEl, ph, badge);
      frag.appendChild(el);

      this.models[n - 1] = {
        n,
        baseW: defaultW,
        baseH: defaultH,
        actualW: defaultW,
        actualH: defaultH,
        baseTop: 0,
        page: n === 1 ? firstPage : null,
        pageReady: n === 1,
        el,
        canvas,
        canvasBytes: 0,
        renderedScale: 0,
        pendingScale: 0,
        lastUsed: 0,
        renderTask: null,
        rendering: false,
        ticket: 0,
        placeholder: ph,
        textLayerEl,
        textLayer: null,
        textReady: false,
        textRendering: false,
        textScheduled: false,
        textTicket: 0
      };

      if (n % CFG.BUILD_BATCH === 0) {
        plane.appendChild(frag);
        frag = document.createDocumentFragment();
        await nextFrame();
      }
    }
    plane.appendChild(frag);
    this.pagesEl.appendChild(plane);
    this.recomputeBaseGeometry();
  }

  recomputeBaseGeometry() {
    if (!this.models.length || !this.plane) return;

    const PAD_X = 6, PAD_TOP = 6, PAD_BOTTOM = 24, GAP = 10;
    let maxW = 1, y = PAD_TOP;

    for (const m of this.models) {
      m.baseTop = y;
      maxW = Math.max(maxW, m.baseW);
      y += m.baseH + GAP;
    }
    if (this.models.length) y -= GAP;

    this.baseSurfaceW = maxW + PAD_X * 2;
    this.baseSurfaceH = Math.max(1, y + PAD_BOTTOM);

    this.plane.style.width = `${this.baseSurfaceW}px`;
    this.plane.style.height = `${this.baseSurfaceH}px`;
    this.updateSurfaceGeometry(this.layoutScale);
  }

  refreshViewportMetrics() {
    this.viewportW = Math.max(1, this.viewer.clientWidth);
    this.viewportH = Math.max(1, this.viewer.clientHeight);
  }

  maxScrollX() { return Math.max(0, this.surfaceW - this.viewportW) }
  maxScrollY() { return Math.max(0, this.surfaceH - this.viewportH) }

  updateSurfaceGeometry(scale = this.layoutScale) {
    if (!this.plane) return;
    const visualW = this.baseSurfaceW * scale;
    const visualH = this.baseSurfaceH * scale;
    const contentW = Math.max(this.viewportW, visualW);
    const contentH = Math.max(this.viewportH, visualH);
    // Overlay clearance extends scroll bounds only. It never changes centering,
    // the document scale or the viewport used by fit-width.
    const surfaceW = contentW + (this.searchInsetLeft || 0) + (this.searchInsetRight || 0);
    const surfaceH = contentH + (this.searchInsetBottom || 0);

    this.surfaceW = surfaceW;
    this.surfaceH = surfaceH;
    this.planeOffsetX = (this.searchInsetLeft || 0) + Math.max(0, (contentW - visualW) / 2);
    this.pagesEl.style.width = `${surfaceW}px`;
    this.pagesEl.style.height = `${surfaceH}px`;
    this.plane.style.left = `${this.planeOffsetX}px`;
    this.plane.style.transform = `scale(${scale})`;
  }

  queueGeometryUpdate(model, width, height) {
    model.actualW = width;
    model.actualH = height;
    this.geometryDirtyModels.add(model);
    clearTimeout(this.geometryTimer);
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = 0;
      if (this.isScrolling || this.panState || this.zoomPreviewActive) {
        this.queueGeometryFlush();
        return;
      }
      this.flushGeometryUpdates();
    }, this.isScrolling ? CFG.GEOMETRY_SETTLE_MS : 0);
  }

  queueGeometryFlush() {
    if (!this.geometryDirtyModels.size || this.geometryTimer) return;
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = 0;
      if (this.isScrolling || this.panState || this.zoomPreviewActive) { this.queueGeometryFlush(); return; }
      this.flushGeometryUpdates();
    }, CFG.GEOMETRY_SETTLE_MS);
  }

  flushGeometryUpdates() {
    if (!this.geometryDirtyModels.size || !this.pdf || !this.plane) return;
    const anchor = this.getScrollAnchor();
    for (const m of this.geometryDirtyModels) {
      m.baseW = m.actualW;
      m.baseH = m.actualH;
      m.el.style.width = `${m.baseW}px`;
      m.el.style.height = `${m.baseH}px`;
      m.el.style.containIntrinsicSize = `${m.baseW}px ${m.baseH}px`;
    }
    this.geometryDirtyModels.clear();
    this.recomputeBaseGeometry();
    if(this.zoomMode === "fit-width")this.fitWidth({propagate:false,persist:false});
    this.restoreLocalAnchor(anchor);
  }

  restoreLocalAnchor(anchor) {
    if (!anchor || !this.models.length) return;
    const page = clamp(anchor.page || 1, 1, this.models.length);
    const m = this.models[page - 1];
    const probeOffset = Math.min(150, this.viewportH * .25);
    const top = clamp((m.baseTop + anchor.y * m.baseH) * this.layoutScale - probeOffset, 0, this.maxScrollY());
    const regularMaxX = Math.max(0, this.baseSurfaceW * this.layoutScale - this.viewportW);
    const left = clamp(Number.isFinite(anchor.centerX) ? this.planeOffsetX + anchor.centerX * this.layoutScale - this.viewportW / 2 : (this.searchInsetLeft || 0) + anchor.x * regularMaxX, 0, this.maxScrollX());
    this.syncEcho = { top, left, until: performance.now() + 100 };
    this.viewer.scrollTo({ top, left, behavior: "auto" });
  }

  async ensurePage(model) {
    if (model.page) return model.page;

    const page = await this.pdf.getPage(model.n);
    model.page = page;
    const base = page.getViewport({ scale: 1 });

    model.actualW = base.width;
    model.actualH = base.height;
    if (Math.abs(base.width - model.baseW) > .1 || Math.abs(base.height - model.baseH) > .1) {
      this.queueGeometryUpdate(model, base.width, base.height);
    }

    model.pageReady = true;
    return page;
  }

  async getTextContent(model) {
    const cached = this.textCache.get(model.n);
    if (cached) return cached;
    const page = await this.ensurePage(model);
    const tc = await page.getTextContent();
    this.textCache.set(model.n, tc);
    return tc;
  }

  desiredRenderScale(model, quality = "fast") {
    const zoom = this.layoutScale;
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.DPR_CAP);
    const cap = quality === "sharp" ? CFG.SHARP_RENDER_SCALE_CAP : CFG.FAST_RENDER_SCALE_CAP;
    const pixelBudget = quality === "sharp" ? CFG.SHARP_CANVAS_PIXELS : CFG.FAST_CANVAS_PIXELS;

    let target = Math.min(zoom * dpr, cap);
    const maxByPixels = Math.sqrt(pixelBudget / Math.max(1, (model.actualW || model.baseW) * (model.actualH || model.baseH)));
    target = Math.min(target, maxByPixels);
    return clamp(target, .3, CFG.SHARP_RENDER_SCALE_CAP);
  }

  // Render off-DOM, then atomically swap the finished canvas. This avoids a second full-size drawImage copy on the main thread.
  async ensureRendered(model, priority = 1, quality = "fast") {
    if (!this.pdf || !model?.el?.isConnected) return;

    model.lastUsed = performance.now();
    const targetScale = this.desiredRenderScale(model, quality);

    if (model.renderedScale >= targetScale * .96 && model.canvas?.width > 1) {
      if (!this.isScrolling && !model.textReady) this.scheduleTextLayer(model);
      return;
    }

    if (model.rendering) {
      if (model.pendingScale >= targetScale * .96) {await model.renderPromise?.catch(()=>{});return;}
      this.cancelModelRender(model);
    }

    const generation = this.generation;
    const ticket = ++model.ticket;
    model.rendering = true;
    model.pendingScale = targetScale;
    this.renderingModels.add(model);

    try {
      const work = renderQueue.add(async () => {
        if (generation !== this.generation || ticket !== model.ticket || !model.el.isConnected) return;

        const page = await this.ensurePage(model);
        if (generation !== this.generation || ticket !== model.ticket || !model.el.isConnected) return;

        const renderScale = this.desiredRenderScale(model, quality);
        if (model.renderedScale >= renderScale * .96 && model.canvas?.width > 1) return;
        model.pendingScale = renderScale;
        const viewport = page.getViewport({ scale: renderScale });

        const staged = document.createElement("canvas");
        staged.className = "pdf-bitmap";
        staged.width = Math.max(1, Math.ceil(viewport.width));
        staged.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = staged.getContext("2d", { alpha: false, desynchronized: true });

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
          intent: "display",
          background: "rgb(255,255,255)"
        });
        model.renderTask = renderTask;

        await renderTask.promise;
        if (generation !== this.generation || ticket !== model.ticket || !model.el.isConnected) {
          staged.width = staged.height = 1;
          return;
        }

        const oldCanvas = model.canvas;
        const oldBytes = model.canvasBytes || 0;
        oldCanvas.replaceWith(staged);
        model.canvas = staged;
        oldCanvas.width = oldCanvas.height = 1;

        model.renderedScale = renderScale;
        model.canvasBytes = staged.width * staged.height * 4;
        model.lastUsed = performance.now();
        this.canvasBytes += model.canvasBytes - oldBytes;

        model.placeholder?.remove();
        model.placeholder = null;
        if (!this.isScrolling) this.scheduleTextLayer(model);
        this.scheduleCanvasPrune();
      }, priority);
      model.renderPromise=work;
      await work;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException" && !/cancel/i.test(String(err?.message || ""))) {
        console.warn("Render failed", this.side, model.n, err);
      }
    } finally {
      if (ticket === model.ticket) {
        model.rendering = false;
        model.renderPromise = null;
        model.renderTask = null;
        model.pendingScale = 0;
        this.renderingModels.delete(model);
      }
    }
  }

  cancelModelRender(model) {
    if (!model?.rendering) return;
    model.ticket++;
    try { model.renderTask?.cancel() } catch {}
    model.renderTask = null;
    model.rendering = false;
    model.pendingScale = 0;
    this.renderingModels.delete(model);
  }

  scheduleTextLayer(model) {
    if (!model || model.textReady || model.textRendering || model.textScheduled || !model.el.isConnected) return;
    model.textScheduled = true;
    const generation = this.generation;
    const run = () => {
      model.textScheduled = false;
      if (generation !== this.generation || this.isScrolling || this.panState || this.zoomPreviewActive) return;
      if (!this.modelIntersectsViewport(model, 96)) return;
      this.ensureTextLayer(model, false);
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(run, { timeout: CFG.TEXT_IDLE_MS + 260 });
    } else {
      setTimeout(run, CFG.TEXT_IDLE_MS);
    }
  }

  async ensureTextLayer(model, force = false) {
    if (!this.pdf || !model?.el?.isConnected) return;
    if (model.textReady) return;
    if (model.textRendering && !force) return;

    const generation = this.generation;
    const ticket = ++model.textTicket;
    model.textScheduled = false;
    model.textRendering = true;

    try {
      const page = await this.ensurePage(model);
      const textContent = await this.getTextContent(model);
      if (generation !== this.generation || ticket !== model.textTicket || !model.el.isConnected) return;

      const viewport = page.getViewport({ scale: 1 });
      const staged = document.createElement("div");
      staged.className = "textLayer";
      staged.style.setProperty("--total-scale-factor", "1");

      const layer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: staged,
        viewport
      });
      await layer.render();

      if (generation !== this.generation || ticket !== model.textTicket || !model.el.isConnected) return;

      model.textLayerEl.replaceWith(staged);
      try { model.textLayer?.cancel?.() } catch {}
      model.textLayerEl = staged;
      model.textLayer = layer;
      model.textReady = true;
      paintSearchHits(this, model);
    } catch (err) {
      if (!/cancel/i.test(String(err?.message || ""))) console.warn("Text layer failed", this.side, model.n, err);
    } finally {
      if (ticket === model.textTicket) model.textRendering = false;
    }
  }

  scheduleCanvasPrune() {
    if (this.canvasBytes <= CFG.CANVAS_MEMORY_BUDGET || this.memoryPruneHandle) return;
    const run = () => {
      this.memoryPruneHandle = 0;
      if (this.isScrolling || this.panState || this.zoomPreviewActive) { this.scheduleCanvasPrune(); return; }
      this.pruneCanvasMemory();
    };
    if ("requestIdleCallback" in window) {
      this.memoryPruneHandle = requestIdleCallback(run, { timeout: CFG.MEMORY_PRUNE_IDLE_MS });
    } else {
      this.memoryPruneHandle = setTimeout(run, CFG.MEMORY_PRUNE_IDLE_MS);
    }
  }

  // 缩略图降级：只在空闲期做重采样，避免滚动帧被同步 drawImage/resize 阻塞。
  pruneCanvasMemory() {
    if (this.canvasBytes <= CFG.CANVAS_MEMORY_BUDGET) return;

    const visible = new Set(this.modelsInViewport(0).map(m => m.n));
    const victims = this.models
      .filter(m => m.canvasBytes > 10000 && !visible.has(m.n) && !m.rendering)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const m of victims) {
      if (this.canvasBytes <= CFG.CANVAS_MEMORY_BUDGET * .82) break;

      if (m.canvas.width > 200) {
        const thumbW = Math.max(1, Math.floor(m.canvas.width / 6));
        const thumbH = Math.max(1, Math.floor(m.canvas.height / 6));
        const thumb = document.createElement("canvas");
        thumb.width = thumbW; thumb.height = thumbH;
        thumb.getContext("2d", { alpha: false }).drawImage(m.canvas, 0, 0, thumbW, thumbH);

        m.canvas.width = thumbW; m.canvas.height = thumbH;
        m.canvas.getContext("2d", { alpha: false }).drawImage(thumb, 0, 0);

        const newBytes = thumbW * thumbH * 4;
        this.canvasBytes -= (m.canvasBytes - newBytes);
        m.canvasBytes = newBytes;
        m.renderedScale = 0.1;
      } else {
        this.canvasBytes -= m.canvasBytes;
        m.canvasBytes = 0;
        m.renderedScale = 0;
        m.canvas.width = 1; m.canvas.height = 1;
      }
      try { m.page?.cleanup?.() } catch {}
    }
  }

  releaseIfFar(model) {
    this.pruneCanvasMemory();
  }

  modelIndexAtBaseY(y) {
    if (!this.models.length) return 0;
    let lo = 0, hi = this.models.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = this.models[mid];
      if (y < m.baseTop) hi = mid - 1;
      else if (y > m.baseTop + m.baseH) { ans = mid; lo = mid + 1; }
      else return mid;
    }
    return clamp(ans, 0, this.models.length - 1);
  }

  modelIndexAtOffset(y) {
    return this.modelIndexAtBaseY(y / Math.max(.00001, this.layoutScale));
  }

  modelsInViewport(overscanPx = 0) {
    if (!this.models.length) return [];
    const scale = Math.max(.00001, this.layoutScale);
    const top = Math.max(0, (this.viewer.scrollTop - overscanPx) / scale);
    const bottom = (this.viewer.scrollTop + this.viewportH + overscanPx) / scale;
    let i = this.modelIndexAtBaseY(top);
    const out = [];

    for (; i < this.models.length; i++) {
      const m = this.models[i];
      if (m.baseTop > bottom) break;
      if (m.baseTop + m.baseH >= top) out.push(m);
    }
    return out;
  }

  modelIntersectsViewport(model, overscanPx = 0) {
    if (!model) return false;
    const scale = Math.max(.00001, this.layoutScale);
    const top = Math.max(0, (this.viewer.scrollTop - overscanPx) / scale);
    const bottom = (this.viewer.scrollTop + this.viewportH + overscanPx) / scale;
    return model.baseTop <= bottom && model.baseTop + model.baseH >= top;
  }

  renderNearViewport({ quality = "fast", overscan = null, includeText = !this.isScrolling } = {}) {
    if (document.body.dataset.view === "home" || this.paneEl.hidden || !this.pdf || !this.models.length || this.zoomPreviewActive || this.documentOpening) return;

    const margin = overscan ?? this.viewportH * CFG.RENDER_OVERSCAN_VIEWPORTS;
    const models = this.modelsInViewport(margin);

    // Only inspect jobs that are actually pending/running. Never scan every page on a scroll frame.
    if (this.renderingModels.size) {
      const hardMargin = Math.max(margin, this.viewportH * CFG.RENDER_CANCEL_OVERSCAN_VIEWPORTS);
      const hardKeep = new Set(this.modelsInViewport(hardMargin));
      for (const m of [...this.renderingModels]) {
        if (!hardKeep.has(m)) this.cancelModelRender(m);
      }
    }

    const centerBase = (this.viewer.scrollTop + this.viewportH / 2) / Math.max(.00001, this.layoutScale);
    for (const m of models) {
      const distance = Math.abs((m.baseTop + m.baseH / 2) - centerBase);
      const priority = Math.max(1, 200000 - Math.round(distance * 100));
      this.ensureRendered(m, priority, quality);
    }

    if (includeText) this.scheduleVisibleTextLayers();
  }

  scheduleVisibleTextLayers() {
    if (this.isScrolling || this.panState || this.zoomPreviewActive) return;
    for (const m of this.modelsInViewport(96)) this.scheduleTextLayer(m);
  }

  cancelSharpRender() {
    clearTimeout(this.sharpTimer);
    this.sharpTimer = 0;
  }

  scheduleSharpRender() {
    this.cancelSharpRender();
    this.sharpTimer = setTimeout(() => {
      if (!this.pdf || this.zoomPreviewActive || this.panState || this.isScrolling || this.documentOpening) return;
      const visible = this.modelsInViewport(Math.min(220, this.viewportH * .18));
      const centerBase = (this.viewer.scrollTop + this.viewportH / 2) / Math.max(.00001, this.layoutScale);
      for (const m of visible) {
        const distance = Math.abs((m.baseTop + m.baseH / 2) - centerBase);
        this.ensureRendered(m, Math.max(1, 300000 - Math.round(distance * 100)), "sharp");
      }
    }, CFG.SHARP_IDLE_MS);
  }

  fitWidth({ propagate = true, persist = true } = {}) {
    if (!this.pdf || !this.models.length) return;
    const ref = this.models[this.currentPage ? this.currentPage - 1 : 0] || this.models[0];
    this.refreshViewportMetrics();
    const available = Math.max(80, this.viewportW - 2);
    this.setScale(available / Math.max(1, this.baseSurfaceW || ref.baseW + 12), { propagate: false, persist, mode: "fit-width" });
    if (propagate && appState.layout === "dual" && appState.syncZoom && this.other().pdf) this.other().fitWidth({ propagate: false, persist });
  }

  updateZoomUI() {
    if(this.documentOpening)return;
    this.zoomEl.textContent = `${Math.round(this.scale * 100)}%`;
  }

  mapPageTo(other, n) {
    if (!this.pdf || !other.pdf) return n;
    if (this.pdf.numPages === other.pdf.numPages) return clamp(n, 1, other.pdf.numPages);
    if (this.pdf.numPages <= 1) return 1;
    return clamp(Math.round(((n - 1) / (this.pdf.numPages - 1)) * (other.pdf.numPages - 1)) + 1, 1, other.pdf.numPages);
  }

  goToPage(n, propagate = true) {
    if (!this.pdf) return;
    if (this.zoomPreviewActive) this.commitWheelZoom();

    n = clamp(Math.round(n), 1, this.pdf.numPages);
    const m = this.models[n - 1];
    this.viewer.scrollTo({
      top: Math.max(0, m.baseTop * this.layoutScale - 8),
      behavior: "auto"
    });

    this.currentPage = n;
    this.pageInput.value = String(n);
    this.ensureRendered(m, 320000, "fast");
    this.scheduleSharpRender();

    if (propagate && appState.layout === "dual" && appState.syncPage && this.other().pdf) {
      this.other().goToPage(this.mapPageTo(this.other(), n), false);
    }
    this.schedulePersistView();
  }

  updateCurrentPage() {
    if (!this.models.length) return;
    const probe = this.viewer.scrollTop + Math.min(150, this.viewportH * .25);
    const idx = this.modelIndexAtOffset(probe);
    const best = this.models[idx]?.n || 1;
    if (best !== this.currentPage) {
      this.currentPage = best;
      this.pageInput.value = String(best);
    }
  }

  getScrollAnchor() {
    if (!this.models.length) return { page: 1, y: 0, x: 0 };
    const scale = Math.max(.00001, this.layoutScale);
    const probe = this.viewer.scrollTop + Math.min(150, this.viewportH * .25);
    const baseProbe = probe / scale;
    const idx = this.modelIndexAtBaseY(baseProbe);
    const m = this.models[idx];
    const y = clamp((baseProbe - m.baseTop) / Math.max(1, m.baseH), 0, 1);
    const maxX = Math.max(0, this.baseSurfaceW * scale - this.viewportW);
    return { page: m.n, y, x: maxX ? clamp((this.viewer.scrollLeft - (this.searchInsetLeft || 0)) / maxX, 0, 1) : 0, centerX: (this.viewer.scrollLeft + this.viewportW / 2 - this.planeOffsetX) / scale };
  }

  consumeSyncEcho() {
    const echo = this.syncEcho;
    if (!echo) return false;
    if (performance.now() > echo.until) { this.syncEcho = null; return false; }
    const matched = Math.abs(this.viewer.scrollTop - echo.top) < .75 && Math.abs(this.viewer.scrollLeft - echo.left) < .75;
    if (matched) this.syncEcho = null;
    return matched;
  }

  applySyncedAnchor(anchor, source) {
    if (!this.pdf || !this.models.length) return;
    const page = source.mapPageTo(this, anchor.page);
    const m = this.models[page - 1];
    const probeOffset = Math.min(150, this.viewportH * .25);
    const top = clamp((m.baseTop + anchor.y * m.baseH) * this.layoutScale - probeOffset, 0, this.maxScrollY());
    const left = clamp((this.searchInsetLeft || 0) + anchor.x * Math.max(0, this.baseSurfaceW * this.layoutScale - this.viewportW), 0, this.maxScrollX());

    if (Math.abs(this.viewer.scrollTop - top) < .25 && Math.abs(this.viewer.scrollLeft - left) < .25) return;
    this.syncEcho = { top, left, until: performance.now() + 100 };
    this.viewer.scrollTo({ top, left, behavior: "auto" });
  }

  beginScrollActivity(idleMs = CFG.SCROLL_IDLE_MS) {
    if (!this.isScrolling) {
      this.isScrolling = true;
      this.cancelSharpRender();
      updateRenderConcurrency();
    }
    this.armScrollIdle(idleMs);
  }

  armScrollIdle(idleMs = CFG.SCROLL_IDLE_MS) {
    clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = setTimeout(() => this.finishScrollActivity(), idleMs);
  }

  finishScrollActivity() {
    clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = 0;
    const wasScrolling = this.isScrolling;
    this.isScrolling = false;
    if (wasScrolling) updateRenderConcurrency();
    if (!this.pdf) return;

    if (this.geometryDirtyModels.size && !this.zoomPreviewActive && !this.panState) this.flushGeometryUpdates();
    this.updateCurrentPage();
    if (!this.zoomPreviewActive) this.renderNearViewport({ quality: "fast", includeText: true });
    this.scheduleVisibleTextLayers();
    this.scheduleSharpRender();
    this.schedulePersistView();
    this.scheduleCanvasPrune();
  }

onScroll() {
  if (!this.pdf || this.scrollRaf) return;
  this.scrollRaf = requestAnimationFrame(() => {
    this.scrollRaf = 0;
    if (!this.pdf) return;

    // 滚动时显示底部阅读控制栏，
    // showReadingControls 内部会自动延迟隐藏。
    showReadingControls(this);

    this.beginScrollActivity();
    this.updateCurrentPage();

    if (!this.zoomPreviewActive) {
      this.renderNearViewport({
        quality: "fast",
        includeText: false
      });
    }

    const isEcho = this.consumeSyncEcho();

    if (
      appState.layout === "dual" &&
      appState.syncScroll &&
      !isEcho && !this.zoomPreviewActive &&
      this.other().pdf
    ) {
      this.other().applySyncedAnchor(
        this.getScrollAnchor(),
        this
      );
    }
  });
}

  onResize() {
    if (this.paneEl.hidden || document.body.dataset.view === "home") return;
    if (this.zoomPreviewActive) {
      this.refreshViewportMetrics();
      this.applyAnchoredZoom(this.wheelZoomTargetScale);
      return;
    }
    const widthChanged = this.viewer.clientWidth !== this.viewportW;
    const anchor=this.pdf && widthChanged ? this.getScrollAnchor() : null;
    cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf=requestAnimationFrame(()=>{
      this.resizeRaf=0; this.refreshViewportMetrics();
      if(!this.pdf)return;
      if(widthChanged && this.zoomMode === "fit-width")this.fitWidth({propagate:false,persist:false});
      else this.updateSurfaceGeometry(this.layoutScale);
      if(anchor)this.restoreLocalAnchor(anchor);
      this.updateCurrentPage();this.renderNearViewport({quality:"fast",includeText:!this.isScrolling});this.scheduleSharpRender();
    });
  }

  setStatus(text) { this.statusEl.textContent = text }

  schedulePersistView() {
    if (!this.docId || !this.pdf) return;
    clearTimeout(this.viewSaveTimer);
    this.viewSaveTimer = setTimeout(() => this.persistView(), 520);
  }

  async persistView() {
    if (!this.docId || !this.pdf) return;
    try {
      await dbPutView({
        key: `${this.docId}:${this.side}`,
        docId: this.docId,
        side: this.side,
        scale: this.scale,
        zoomMode: this.zoomMode,
        currentPage: this.currentPage,
        scrollTop: this.viewer.scrollTop,
        scrollLeft: this.viewer.scrollLeft,
        anchor: this.getScrollAnchor(),
        viewportRevision: 2,
        updated: Date.now()
      });
    } catch (err) {}
  }

  async destroyDocument(resetUI = true) {
    this.cancelTouch?.();
    if (this.zoomRaf) { cancelAnimationFrame(this.zoomRaf); this.zoomRaf = 0; }
    clearTimeout(this.viewSaveTimer);
    clearTimeout(this.wheelZoomTimer);
    clearTimeout(this.sharpTimer);
    clearTimeout(this.scrollIdleTimer);
    clearTimeout(this.geometryTimer);
    cancelAnimationFrame(this.scrollRaf);
    cancelAnimationFrame(this.resizeRaf);
    cancelAnimationFrame(this.panRaf);
    if (this.memoryPruneHandle) {
      if ("cancelIdleCallback" in window) cancelIdleCallback(this.memoryPruneHandle);
      else clearTimeout(this.memoryPruneHandle);
    }
    this.memoryPruneHandle = 0;

    this.zoomPreviewActive = false;
    this.isScrolling = false;
    this.viewer.classList.remove("zoom-preview");
    updateRenderConcurrency();
    this.zoomAnchor = null;
    this.syncEcho = null;
    this.renderingModels.clear();
    this.geometryDirtyModels.clear();

    try { await this.persistView() } catch {}

    for (const m of this.models) {
      m.ticket++;
      m.textTicket++;
      try { m.renderTask?.cancel() } catch {}
      try { m.textLayer?.cancel?.() } catch {}
      if (m.canvas) {
        m.canvas.width = 1;
        m.canvas.height = 1;
      }
      try { m.page?.cleanup?.() } catch {}
    }

    this.models = [];
    this.plane = null;
    this.baseSurfaceW = 0;
    this.baseSurfaceH = 0;
    this.canvasBytes = 0;
    this.textCache.clear();

    if (this.loadingTask) {
      try { await this.loadingTask.destroy() } catch {}
      this.loadingTask = null;
    }
    this.pdf = null;

    if (resetUI) {
      this.file = null;
      this.docId = null;
      this.nameEl.textContent = `打开${this.side === "left" ? "左" : "右"}侧 PDF`;
      this.nameEl.title = "";
      this.pageInput.value = "0";
      this.totalEl.textContent = "/ 0";
      this.scale = CFG.DEFAULT_SCALE;
      this.layoutScale = CFG.DEFAULT_SCALE;
      this.wheelZoomTargetScale = CFG.DEFAULT_SCALE;
      this.zoomMode = "custom";
      this.updateZoomUI();
      this.showEmpty();
      setSessionSide(this.side, null);
    }
  }
}

for(const side of ["left","right"]){const pane=$(`#${side}Pane`),controls=document.createElement("div");controls.className="reading-controls";controls.setAttribute("aria-label",`${side==="left"?"左侧":"右侧"}阅读工具`);pane.querySelectorAll(".tool-group").forEach(group=>controls.append(group));pane.append(controls);}
const panes = { left: new PdfPane("left"), right: new PdfPane("right") };

function updateRenderConcurrency() {
  const interactive = Object.values(panes).some(p => p.isScrolling || p.panState || p.zoomPreviewActive);
  renderQueue.setLimit(interactive ? CFG.INTERACTIVE_RENDER_JOBS : CFG.MAX_RENDER_JOBS);
}

function updateToggleUI() { for (const id of ["syncScroll", "syncPage", "syncZoom", "syncSelection"]) $(`#${id}`).setAttribute("aria-pressed", String(!!appState[id])); }
function updatePanCursor() { for (const p of Object.values(panes)) { p.viewer.classList.toggle("ctrl-pan-ready", !!appState.ctrlDown); p.viewer.classList.toggle("hand-ready", !!appState.spaceDown); } }
updateToggleUI(); updatePanCursor();

function refreshSessionHint() {
  const loaded = [panes.left.pdf && "左", panes.right.pdf && "右"].filter(Boolean).join(" / ");
  $("#sessionHint").textContent = loaded ? `${loaded}侧已载入 · 自动保存` : "状态会自动保存";
}

function compareDocumentPair() {
  const a = panes.left, b = panes.right; if (!a.pdf || !b.pdf) return;
  const ratio = Math.min(a.pdf.numPages, b.pdf.numPages) / Math.max(a.pdf.numPages, b.pdf.numPages);
  if (ratio < .75) toast("两份 PDF 页数差异较大：同步选中会改用相对页码 + 版面位置匹配。", false);
}

$("#openLeft").onclick = () => $("#leftFile").click();
$("#openRight").onclick = () => $("#rightFile").click();
$("#leftFile").onchange = e => { const f = e.target.files?.[0]; if (f) panes.left.loadFile(f); e.target.value = "" };
$("#rightFile").onchange = e => { const f = e.target.files?.[0]; if (f) panes.right.loadFile(f); e.target.value = "" };

for (const id of ["syncScroll", "syncPage", "syncZoom", "syncSelection"]) {
  $(`#${id}`).onclick = () => { appState[id] = !appState[id]; updateToggleUI(); persistSettings(); if (id === "syncSelection" && !appState.syncSelection) clearMirrorSelection(); };
}

document.addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav) { const p = panes[nav.dataset.side], d = nav.dataset.nav === "next" ? 1 : -1; p.goToPage((p.currentPage || 1) + d, true); return }
  const zoom = e.target.closest("[data-zoom]");
  if (zoom) {
    const p = panes[zoom.dataset.side]; appState.activeSide = zoom.dataset.side; const op = zoom.dataset.zoom;
    if (op === "in") p.setScale(p.scale * CFG.ZOOM_STEP, { propagate: true });
    else if (op === "out") p.setScale(p.scale / CFG.ZOOM_STEP, { propagate: true });
    else if (op === "reset") p.setScale(1, { propagate: true });
    else if (op === "fit") p.fitWidth({ propagate: true });
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeHistory(); clearMirrorSelection(); }
  if (e.key === "Control" && !e.repeat) { appState.ctrlDown = true; updatePanCursor() }
  if (e.code === "Space" && !e.repeat) { appState.spaceDown = true; updatePanCursor() }
  const tag = document.activeElement?.tagName || ""; if (["INPUT","TEXTAREA","SELECT","BUTTON"].includes(tag)) return;
  const p = panes[appState.activeSide];
  if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); p.setScale(p.scale * CFG.ZOOM_STEP, { propagate: true }) }
  else if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); p.setScale(p.scale / CFG.ZOOM_STEP, { propagate: true }) }
  else if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); p.setScale(1, { propagate: true }) }
  else if (e.key === "PageDown") { e.preventDefault(); p.goToPage((p.currentPage || 1) + 1, true) }
  else if (e.key === "PageUp") { e.preventDefault(); p.goToPage((p.currentPage || 1) - 1, true) }
  else if (e.key.toLowerCase() === "f" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); p.fitWidth({ propagate: true }) }
  else if (e.key === "Escape") { clearMirrorSelection(); closeHistory() }
});

document.addEventListener("keyup", e => {
  if (e.key === "Control") { appState.ctrlDown = false; updatePanCursor() }
  if (e.code === "Space") { appState.spaceDown = false; updatePanCursor() }
});
window.addEventListener("blur", () => { appState.spaceDown = false; appState.ctrlDown = false; updatePanCursor() });

const main = $("#main"), divider = $("#divider"); let resizing = false, splitRaf = 0, pendingSplitRatio = appState.splitRatio;
function applySplitRatio(ratio) {
  ratio = clamp(Number(ratio)||.5, .10, .90); appState.splitRatio = ratio;
  main.style.gridTemplateColumns = `minmax(0,${ratio}fr) var(--divider-w) minmax(0,${1-ratio}fr)`;
  divider.setAttribute("aria-valuenow", Math.round(ratio*100));
}
function setLayout(mode, save=true) {
  appState.layout = ["left","right","dual"].includes(mode) ? mode : "dual";
  document.body.dataset.layout=appState.layout;
  for (const side of ["left","right"]) {
    panes[side].paneEl.hidden=appState.layout!=="dual" && appState.layout!==side;
    if (panes[side].paneEl.hidden) { panes[side].cancelSharpRender(); for(const m of panes[side].renderingModels) panes[side].cancelModelRender(m); }
  }
  if(appState.layout!=="dual") appState.activeSide=appState.layout;
  document.querySelectorAll("button[data-layout]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.layout===appState.layout)));
  document.querySelectorAll("[data-focus]").forEach(b=>b.textContent=appState.layout==="dual"?"展开 ↗":"恢复双栏 ↔");
  requestAnimationFrame(()=>Object.values(panes).filter(p=>!p.paneEl.hidden).forEach(p=>p.onResize()));
  if(save) persistSettings();
}
applySplitRatio(appState.splitRatio);setLayout(appState.layout,false);
document.querySelectorAll("button[data-layout]").forEach(b=>b.onclick=()=>setLayout(b.dataset.layout));
document.querySelectorAll("[data-focus]").forEach(b=>b.onclick=()=>setLayout(appState.layout==="dual"?b.dataset.focus:"dual"));
divider.tabIndex=0;divider.setAttribute("aria-valuemin","10");divider.setAttribute("aria-valuemax","90");divider.title="拖到边缘收起一侧 · 双击居中 · 方向键调整";
divider.addEventListener("dblclick",()=>{applySplitRatio(.5);setLayout("dual")});
divider.addEventListener("keydown",e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();applySplitRatio(appState.splitRatio+(e.key==="ArrowLeft"?-.05:.05));persistSettings()}if(e.key==="Home"){applySplitRatio(.5);persistSettings()}});
divider.addEventListener("pointerdown",e=>{resizing=true;pendingSplitRatio=appState.splitRatio;divider.setPointerCapture(e.pointerId);document.body.style.userSelect="none"});
divider.addEventListener("pointermove",e=>{if(!resizing)return;const r=main.getBoundingClientRect();pendingSplitRatio=(e.clientX-r.left)/r.width;if(!splitRaf)splitRaf=requestAnimationFrame(()=>{splitRaf=0;applySplitRatio(pendingSplitRatio)});divider.title=pendingSplitRatio<.10?"松手收起左侧":pendingSplitRatio>.90?"松手收起右侧":"拖到边缘收起一侧"});
function finishSplit(e){if(!resizing)return;resizing=false;if(splitRaf){cancelAnimationFrame(splitRaf);splitRaf=0}document.body.style.userSelect="";if(e.type!=="pointercancel" && (pendingSplitRatio<.10||pendingSplitRatio>.90)){const mode=pendingSplitRatio<.10?"right":"left";applySplitRatio(.5);setLayout(mode);toast("已切换单栏，点击顶部「双栏」恢复")}else{applySplitRatio(pendingSplitRatio);persistSettings()}Object.values(panes).forEach(p=>p.onResize())}
divider.addEventListener("pointerup",finishSplit);divider.addEventListener("pointercancel",finishSplit);
const ro = new ResizeObserver(entries=>{for(const entry of entries){const p=Object.values(panes).find(p=>p.viewer===entry.target);if(p&&!p.paneEl.hidden)p.onResize()}});Object.values(panes).forEach(p=>ro.observe(p.viewer));

let selectionTimer = 0; document.addEventListener("selectionchange", () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(handleSelectionChange, 70); });
function normalizeText(s) { return (s || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""); }
function textSignals(s) { return new Set(((s || "").normalize("NFKC").match(/[A-Z]{2,}|\p{N}+(?:[.,:]\p{N}+)*/gu) || []).map(x => x.toLowerCase())); }
function intersectsSafe(range, node) { try { return range.intersectsNode(node) } catch { return false } }
function visibleTextSpans(model) { return model.textLayerEl ? [...model.textLayerEl.querySelectorAll("span")].filter(s => s.textContent?.trim()) : [] }
function exactSpanMatch(spans, sourceText) {
  const needle = normalizeText(sourceText); if (needle.length < 3 || !spans.length) return null;
  let hay = "", ranges = [];
  for (let i = 0; i < spans.length; i++) {
    const part = normalizeText(spans[i].textContent || ""); if (!part) continue;
    const start = hay.length; hay += part; ranges.push({ i, start, end: hay.length });
  }
  const pos = hay.indexOf(needle); if (pos < 0) return null;
  const end = pos + needle.length; const hit = ranges.filter(r => r.end > pos && r.start < end).map(r => spans[r.i]);
  return hit.length ? hit : null;
}
function geometrySpanMatch(sourceModel, selectedSpans, targetModel, targetSpans, sourceText) {
  if (!selectedSpans.length || !targetSpans.length) return [];
  const srcAll = visibleTextSpans(sourceModel), srcPage = sourceModel.el.getBoundingClientRect(), targetPage = targetModel.el.getBoundingClientRect();
  const idxs = selectedSpans.map(s => srcAll.indexOf(s)).filter(i => i >= 0).sort((a, b) => a - b);
  const start = idxs[0] ?? 0, end = idxs[idxs.length - 1] ?? start;
  const centerRatio = ((start + end) / 2) / Math.max(1, srcAll.length - 1);
  const selectedRects = selectedSpans.map(s => s.getBoundingClientRect()).filter(r => r.width || r.height);
  const yCenter = selectedRects.length ? selectedRects.reduce((a, r) => a + ((r.top + r.bottom) / 2 - srcPage.top) / Math.max(1, srcPage.height), 0) / selectedRects.length : .5;
  const xCenter = selectedRects.length ? selectedRects.reduce((a, r) => a + ((r.left + r.right) / 2 - srcPage.left) / Math.max(1, srcPage.width), 0) / selectedRects.length : .5;
  const count = clamp(Math.round(Math.max(1, selectedSpans.length) * targetSpans.length / Math.max(1, srcAll.length)), 1, Math.min(48, targetSpans.length));
  const predicted = Math.round(centerRatio * Math.max(0, targetSpans.length - 1));
  const signals = textSignals(sourceText);
  let best = { score: Infinity, start: clamp(predicted - Math.floor(count / 2), 0, Math.max(0, targetSpans.length - count)) };
  const lo = Math.max(0, best.start - 34), hi = Math.min(Math.max(0, targetSpans.length - count), best.start + 34);
  for (let s = lo; s <= hi; s++) {
    const group = targetSpans.slice(s, s + count), rects = group.map(x => x.getBoundingClientRect());
    const gy = rects.reduce((a, r) => a + ((r.top + r.bottom) / 2 - targetPage.top) / Math.max(1, targetPage.height), 0) / rects.length;
    const gx = rects.reduce((a, r) => a + ((r.left + r.right) / 2 - targetPage.left) / Math.max(1, targetPage.width), 0) / rects.length;
    const gr = ((s + (s + count - 1)) / 2) / Math.max(1, targetSpans.length - 1);
    let score = Math.abs(gr - centerRatio) * 1.05 + Math.abs(gy - yCenter) * 1.8 + Math.abs(gx - xCenter) * .18;
    if (signals.size) {
      const gs = textSignals(group.map(x => x.textContent).join(" "));
      let overlap = 0; for (const t of signals) if (gs.has(t)) overlap++;
      score -= Math.min(.55, overlap * .18);
    }
    if (score < best.score) best = { score, start: s };
  }
  return targetSpans.slice(best.start, best.start + count);
}
function clearMirrorSelection() {
  appState.selectionToken++; for (const el of document.querySelectorAll(".mirror-selected")) el.classList.remove("mirror-selected");
  appState.lastSelection = null; $("#selectionTools").hidden = true;
}
async function handleSelectionChange() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { if (!sel || sel.isCollapsed) clearMirrorSelection(); return; }
  const range = sel.getRangeAt(0); const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest?.(".textLayer");
  if (!startEl) return;
  const paneEl = startEl.closest(".pane"), side = paneEl?.dataset.side; if (!side) return;
  appState.activeSide = side; const source = panes[side], target = source.other(), sourceText = sel.toString().trim();
  if (!sourceText) return;
  const selectionRect = range.getBoundingClientRect(); showSelectionTools(selectionRect, "已选择");
  if (appState.layout !== "dual" || !appState.syncSelection || !target.pdf) { appState.lastSelection = { sourceText, targetText: "", side }; return; }

  const token = ++appState.selectionToken; for (const el of document.querySelectorAll(".mirror-selected")) el.classList.remove("mirror-selected");
  const pageEls = [...source.pagesEl.querySelectorAll(".page")].filter(page => {
    const tl = page.querySelector(".textLayer"); if (!tl) return false; try { return range.intersectsNode(tl) } catch { return false }
  }).slice(0, 8);
  let mirroredText = [], modes = [];
  for (const pageEl of pageEls) {
    if (token !== appState.selectionToken) return;
    const sourceModel = source.models[Number(pageEl.dataset.page) - 1];
    await source.ensureTextLayer(sourceModel, true);
    const srcSpans = visibleTextSpans(sourceModel), selected = srcSpans.filter(s => intersectsSafe(range, s));
    if (!selected.length) continue;
    const targetPage = source.mapPageTo(target, sourceModel.n), targetModel = target.models[targetPage - 1]; if (!targetModel) continue;
    await target.ensureRendered(targetModel, 260000, "fast");
    await target.ensureTextLayer(targetModel, true);
    if (token !== appState.selectionToken) return;
    const targetSpans = visibleTextSpans(targetModel); if (!targetSpans.length) continue;
    const localText = pageEls.length === 1 ? sourceText : selected.map(x => x.textContent).join(" ");
    let hits = exactSpanMatch(targetSpans, localText), mode = "文本命中";
    if (!hits) { hits = geometrySpanMatch(sourceModel, selected, targetModel, targetSpans, localText); mode = "版面对齐" }
    for (const h of hits) h.classList.add("mirror-selected");
    if (hits.length) mirroredText.push(hits.map(x => x.textContent).join(" ").replace(/\s+/g, " ").trim());
    modes.push(mode);
  }
  const targetText = mirroredText.join("\n").trim(); appState.lastSelection = { sourceText, targetText, side };
  const mode = modes.includes("版面对齐") ? "同步：版面 + 顺序" : modes.length ? "同步：文本匹配" : "未找到对应文本层";
  showSelectionTools(selectionRect, mode);
}
function showSelectionTools(rect, label) {
  const el = $("#selectionTools"), state = $("#selectionState"); state.textContent = label; el.hidden = false;
  requestAnimationFrame(() => {
    const w = el.offsetWidth, h = el.offsetHeight; let left = clamp(rect.left + (rect.width - w) / 2, 8, window.innerWidth - w - 8);
    let top = rect.top - h - 8; if (top < 8) top = Math.min(window.innerHeight - h - 8, rect.bottom + 8);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  });
}
async function copyText(text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast("已复制") }
  catch { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("已复制"); }
}
$("#selectionTools").addEventListener("pointerdown", e => e.preventDefault());
$("#copySource").onclick = () => copyText(appState.lastSelection?.sourceText || document.getSelection()?.toString() || "");
$("#copyBilingual").onclick = () => { const s = appState.lastSelection; if (!s) return; copyText(s.targetText ? `${s.sourceText}\n\n——\n\n${s.targetText}` : s.sourceText); };

const drawer = $("#historyDrawer"), backdrop = $("#drawerBackdrop"), historyList = $("#historyList");
async function openHistory() { drawer.inert=false; drawer.classList.add("open"); backdrop.classList.add("show"); $(".app").inert=true; $("#historyFilter").focus(); await renderHistory() }
function closeHistory() { const wasOpen=drawer.classList.contains("open"); drawer.classList.remove("open"); drawer.inert=true; $(".app").inert=false; backdrop.classList.remove("show"); if(wasOpen) ($("#readerHistoryBtn")||$("#homeTab")).focus() }
$("#historyFilter").oninput = () => { clearTimeout(window.historyFilterTimer); window.historyFilterTimer=setTimeout(renderHistory,150); };
$("#closeHistory").onclick = closeHistory; backdrop.onclick = closeHistory;
async function renderHistory() {
  historyList.innerHTML = `<div class="history-empty">正在读取历史…</div>`;
  try {
    const docs = await dbGetDocs();
    if (!docs.length) { historyList.innerHTML = `<div class="history-empty">还没有历史文件。打开 PDF 后会自动出现在这里。</div>`; return }
    const frag = document.createDocumentFragment();
    const views = await idb("views", "readonly", store => store.getAll());
    for (const d of docs.filter(d=>d.name.toLocaleLowerCase().includes($("#historyFilter").value.trim().toLocaleLowerCase()))) {
      const row = document.createElement("div"); row.className = "history-item";
      const meta = document.createElement("div"); meta.className = "history-meta";
      const name = document.createElement("div"); name.className = "history-name"; name.textContent = d.name; name.title = d.name;
      const sub = document.createElement("div"); sub.className = "history-sub"; sub.textContent = `${formatBytes(d.size || 0)} · ${formatTime(d.lastOpened)}${d.blob ? "" : " · 仅记录"}`;
      const lastView=(views||[]).filter(v=>v.docId===d.id).sort((a,b)=>(b.updated||0)-(a.updated||0))[0];
      if(lastView) sub.textContent+=` · 上次读到第 ${lastView.currentPage} 页`;
      meta.append(name, sub);
      const actions = document.createElement("div"); actions.className = "history-actions";
      const left = document.createElement("button"); left.textContent = "在左侧打开"; left.onclick = () => restoreHistoryDoc(d, "left");
      const right = document.createElement("button"); right.textContent = "在右侧打开"; right.onclick = () => restoreHistoryDoc(d, "right");
      const del = document.createElement("button"); del.textContent = "删除"; del.title = "删除历史"; del.onclick = async () => { if(!await confirmWorkspaceAction(`从历史中删除「${d.name}」及阅读记录？当前已打开的文档不受影响。`)) return; await dbDeleteDoc(d.id); const s = getSession(); if (s.left === d.id) setSessionSide("left", null); if (s.right === d.id) setSessionSide("right", null); renderHistory() };
      actions.append(left, right, del); row.append(meta, actions); frag.appendChild(row);
    }
    historyList.replaceChildren(frag);
    if(!historyList.children.length) historyList.textContent="没有匹配的文件。";
  } catch (err) { historyList.innerHTML = `<div class="history-empty">读取历史失败：${String(err?.message || err)}</div>` }
}
async function restoreHistoryDoc(rec, side, { silent = false } = {}) {
  if (!rec?.blob) { toast("这个历史项没有保存文件副本，请重新选择原 PDF。", true); return }
  const file = new File([rec.blob], rec.name, { type: rec.type || "application/pdf", lastModified: rec.lastModified || Date.now() });
  const view = await dbGetView(rec.id, side);
  await panes[side].loadFile(file, { docId: rec.id, restoreState: view, persistBlob: false, silent });
  if (!silent) { if(panes[side].paneEl.hidden) setLayout(side); closeHistory(); }
}
async function restoreLastSession() {
  try {
    try { navigator.storage?.persist?.() } catch {}
    const s = getSession(); const jobs = [];
    for (const side of ["left", "right"]) {
      if (!s[side]) continue;
      const rec = await dbGetDoc(s[side]); if (rec?.blob) jobs.push(restoreHistoryDoc(rec, side, { silent: true }));
    }
    if (jobs.length) { await Promise.allSettled(jobs); toast("已恢复上次阅读现场") }
  } catch (err) {}
}
window.addEventListener("beforeunload", () => { panes.left.persistView(); panes.right.persistView(); persistSettings(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { panes.left.persistView(); panes.right.persistView(); persistSettings() } });

// Search owns only indexing, results and decoration; PDF text nodes stay untouched.
const SEARCH_LIMITS = Object.freeze({ cacheBytes: 24 * 1024 * 1024, hits: 2000, rows: 60, debounce: 160 });
const searchState = {
  token: 0, jumpToken: 0, timer: 0, hits: [], byPage: new Map(), index: -1,
  query: "", cache: new Map(), bytes: 0, documents: new WeakMap(), nextDocument: 0,
  pending: new Map(), decorations: new Map(), listPage: 0, running: false, summary: ""
};
const nativeSearchHighlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
const searchHighlights = nativeSearchHighlights ? { all: new Highlight(), current: new Highlight() } : null;
if (searchHighlights) {
  searchHighlights.current.priority = 1;
  CSS.highlights.set("pdf-search-hit", searchHighlights.all);
  CSS.highlights.set("pdf-search-current", searchHighlights.current);
}
const searchPageKey = (p, n) => `${p.side}:${p.generation}:${n}`;
function searchDocumentId(pdf) {
  if (!searchState.documents.has(pdf)) searchState.documents.set(pdf, ++searchState.nextDocument);
  return searchState.documents.get(pdf);
}
function searchHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
// Preserve explicit whitespace. Infer separators only when PDF item geometry
// indicates a real word gap or line break; adjacent glyph runs remain joined.
function searchSeparator(previous, item) {
  if (!previous) return "";
  if (previous.hasEOL) return "\n";
  if (/\s$/u.test(previous.str) || /^\s/u.test(item.str)) return "";
  const a = previous.transform, b = item.transform;
  if (!a || !b || previous.dir === "ttb" || item.dir === "ttb") return "";
  const size = Math.hypot(a[0], a[1]) || Math.hypot(a[2], a[3]) || 1;
  const ux = a[0] / size, uy = a[1] / size;
  const dx = b[4] - a[4], dy = b[5] - a[5];
  if (Math.abs(-dx * uy + dy * ux) > size * .55) return "\n";
  const advance = dx * ux + dy * uy;
  const gap = previous.dir === "rtl" ? -advance - Math.abs(item.width || 0) : advance - Math.abs(previous.width || 0);
  return gap > size * .12 ? " " : "";
}
function buildSearchPage(content) {
  const parts = [], rawParts = [], segments = [];
  let length = 0, rawLength = 0, previous = null;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    if (!item.str) { if (item.hasEOL && previous) previous = { ...previous, hasEOL: true }; continue; }
    const separator = searchSeparator(previous, item);
    parts.push(separator, item.str); length += separator.length;
    segments.push({ start: length, end: length + item.str.length, rawStart: rawLength });
    rawParts.push(item.str); length += item.str.length; rawLength += item.str.length;
    previous = item;
  }
  const raw = rawParts.join("");
  return { text: parts.join(""), segments, rawLength, hash: searchHash(raw), normalized: new Map(), bytes: length * 2 + segments.length * 32 };
}
// Every normalized UTF-16 unit maps back to the original display text. This
// handles ligatures, composed accents and case expansions without offset drift.
function* searchNormalizationSteps(text, caseSensitive) {
  let processed = 0;
  const chunks = [], starts = [], ends = [];
  for (const match of text.matchAll(/[^\p{M}]\p{M}*|\p{M}+/gu)) {
    if (++processed % 1024 === 0) yield;
    const from = match.index, to = from + match[0].length;
    let part = match[0].normalize("NFKC").replace(/[\u00ad\u200b\ufeff]/gu, "");
    if (!caseSensitive) part = part.toLowerCase();
    for (const character of part) {
      if (/\s/u.test(character)) {
        if (chunks[chunks.length - 1] === " ") { ends[ends.length - 1] = to; continue; }
        chunks.push(" "); starts.push(from); ends.push(to);
      } else {
        chunks.push(character);
        for (let j = 0; j < character.length; j++) { starts.push(from); ends.push(to); }
      }
    }
  }
  return { text: chunks.join(""), starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}
function normalizeSearch(text, caseSensitive) {
  const steps = searchNormalizationSteps(text, caseSensitive);
  let result; do { result = steps.next(); } while (!result.done);
  return result.value;
}
async function normalizeSearchPage(text, sensitive, valid) {
  const steps = searchNormalizationSteps(text, sensitive);
  let result, deadline = performance.now() + 8;
  do {
    if (!valid()) return null;
    result = steps.next();
    if (!result.done && performance.now() >= deadline) { await sleep(0); deadline = performance.now() + 8; }
  } while (!result.done);
  return result.value;
}
function isSearchWord(character) {
  return !!character && /[\p{L}\p{M}\p{N}\p{Pc}]/u.test(character) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u.test(character);
}
function searchCodePointBefore(text, offset) {
  if (!offset) return "";
  const last = text.charCodeAt(offset - 1);
  return text.slice(offset - (last >= 0xdc00 && last <= 0xdfff && offset > 1 ? 2 : 1), offset);
}
function isWholeSearchMatch(text, start, end, query) {
  const first = String.fromCodePoint(query.codePointAt(0)), last = searchCodePointBefore(query, query.length);
  return !(isSearchWord(first) && isSearchWord(searchCodePointBefore(text, start))) &&
    !(isSearchWord(last) && isSearchWord(end < text.length ? String.fromCodePoint(text.codePointAt(end)) : ""));
}
function sourceSearchOffset(page, offset, end = false) {
  let low = 0, high = page.segments.length;
  while (low < high) { const mid = (low + high) >>> 1; if (page.segments[mid].end <= offset && ! (end && page.segments[mid].end === offset)) low = mid + 1; else high = mid; }
  const segment = page.segments[Math.min(low, page.segments.length - 1)];
  return segment ? segment.rawStart + Math.max(0, Math.min(segment.end - segment.start, offset - segment.start)) : 0;
}
function evictSearchCache() {
  while (searchState.bytes > SEARCH_LIMITS.cacheBytes && searchState.cache.size) {
    const key = searchState.cache.keys().next().value;
    searchState.bytes -= searchState.cache.get(key).bytes; searchState.cache.delete(key);
  }
}
async function getSearchPage(pdf, n, p) {
  const key = `${searchDocumentId(pdf)}:${n}`;
  if (searchState.cache.has(key)) {
    const page = searchState.cache.get(key); searchState.cache.delete(key); searchState.cache.set(key, page); return page;
  }
  if (searchState.pending.has(key)) return searchState.pending.get(key);
  const task = (async () => {
    const cached = p.pdf === pdf ? p.textCache.get(n) : null;
    const content = cached || await (await pdf.getPage(n)).getTextContent();
    const page = buildSearchPage(content);
    // Do not retain indexes belonging to a replaced document.
    if (p.pdf === pdf && page.bytes <= SEARCH_LIMITS.cacheBytes) {
      searchState.cache.set(key, page); searchState.bytes += page.bytes; evictSearchCache();
    }
    return page;
  })();
  searchState.pending.set(key, task);
  try { return await task; } finally { searchState.pending.delete(key); }
}
async function getNormalizedSearchPage(page, sensitive, valid) {
  if (!page.normalized.has(sensitive)) {
    const normalized = await normalizeSearchPage(page.text, sensitive, valid);
    if (!normalized || !valid()) return null;
    page.normalized.set(sensitive, normalized);
    const added = normalized.text.length * 2 + normalized.starts.byteLength + normalized.ends.byteLength;
    page.bytes += added;
    if ([...searchState.cache.values()].includes(page)) { searchState.bytes += added; evictSearchCache(); }
  }
  return page.normalized.get(sensitive);
}
function clearSearchDecoration(key) {
  const record = searchState.decorations.get(key); if (!record) return;
  if (searchHighlights) for (const { range } of record.ranges) { searchHighlights.all.delete(range); searchHighlights.current.delete(range); }
  record.overlay?.remove(); searchState.decorations.delete(key);
}
function clearSearchDecorations() { for (const key of searchState.decorations.keys()) clearSearchDecoration(key); }
function searchRange(nodes, start, end) {
  if (end <= start || !nodes.length) return null;
  const locate = (offset, ending) => {
    let low = 0, high = nodes.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (nodes[mid].end < offset || (!ending && nodes[mid].end === offset)) low = mid + 1;
      else high = mid;
    }
    return nodes[low];
  };
  const first = locate(start, false), last = locate(end, true);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  return range;
}
function paintSearchHits(p, m) {
  const key = searchPageKey(p, m.n); clearSearchDecoration(key);
  if (!m.textLayerEl || !searchState.query || $("#searchPanel").hidden) return;
  const hits = searchState.byPage.get(key); if (!hits?.length) return;
  // Use leaf text nodes, not whole spans: one PDF span can contain a full line.
  const nodes = [], parts = []; let offset = 0;
  const walker = document.createTreeWalker(m.textLayerEl, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue || "";
    if (value.length) { nodes.push({ node, start: offset, end: offset + value.length }); parts.push(value); offset += value.length; }
  }
  // A mismatched extraction must never paint unrelated text.
  if (offset !== hits[0].rawLength || searchHash(parts.join("")) !== hits[0].hash) return;
  const record = { layer: m.textLayerEl, ranges: [], overlay: null };
  const current = searchState.hits[searchState.index];
  let box, scaleX, scaleY;
  if (!searchHighlights) {
    record.overlay = document.createElement("div"); record.overlay.className = "search-overlay"; record.overlay.setAttribute("aria-hidden", "true");
    box = m.textLayerEl.getBoundingClientRect(); scaleX = box.width / m.textLayerEl.offsetWidth; scaleY = box.height / m.textLayerEl.offsetHeight;
  }
  for (const hit of hits) {
    const range = searchRange(nodes, hit.rawStart, hit.rawEnd); if (!range) continue;
    record.ranges.push({ hit, range });
    if (searchHighlights) { searchHighlights.all.add(range); if (hit === current) searchHighlights.current.add(range); }
    else if (scaleX > 0 && scaleY > 0) for (const rect of range.getClientRects()) {
      const mark = document.createElement("i"); mark.className = "search-rect" + (hit === current ? " current" : "");
      Object.assign(mark.style, { left: `${(rect.left - box.left) / scaleX}px`, top: `${(rect.top - box.top) / scaleY}px`, width: `${rect.width / scaleX}px`, height: `${rect.height / scaleY}px` });
      record.overlay.append(mark);
    }
  }
  if (record.overlay) m.textLayerEl.append(record.overlay);
  searchState.decorations.set(key, record);
}
function repaintSearch() {
  for (const [key, record] of searchState.decorations) if (!record.layer.isConnected) clearSearchDecoration(key);
  for (const p of Object.values(panes)) for (const m of p.models) if (m.textReady) paintSearchHits(p, m);
}
function resetSearch() {
  ++searchState.token; ++searchState.jumpToken; clearTimeout(searchState.timer);
  searchState.hits = []; searchState.byPage.clear(); searchState.index = -1; searchState.query = "";
  searchState.listPage = 0; searchState.running = false; searchState.summary = ""; clearSearchDecorations(); renderSearchResults();
}
function closeSearch() { resetSearch(); $("#searchPanel").hidden = true; refreshSearchOverlayLayout(); $("#searchBtn").focus({preventScroll:true}); }
function openSearch() { $("#searchPanel").hidden = false; refreshSearchOverlayLayout(); $("#searchInput").focus({preventScroll:true}); $("#searchInput").select(); queueSearch(); }
function queueSearch() {
  resetSearch(); const token = searchState.token;
  $("#searchStatus").textContent = $("#searchInput").value.trim() ? "等待搜索…" : "支持完整词匹配、短语与中文。";
  if (!$("#searchInput").value.trim()) return;
  searchState.timer = setTimeout(() => { runSearch(token).catch(error => {
    if (token !== searchState.token) return;
    searchState.running = false; $("#searchStatus").textContent = "搜索未完成，请重试。"; renderSearchResults(); console.warn("PDF search failed", error);
  }); }, SEARCH_LIMITS.debounce);
}
async function runSearch(token) {
  if (token !== searchState.token) return;
  const sensitive = $("#searchCase").checked, whole = $("#searchWhole").checked;
  const query = normalizeSearch($("#searchInput").value.trim(), sensitive).text.trim();
  if (!query) { $("#searchStatus").textContent = "请输入有效关键词。"; return; }
  searchState.query = query;
  const scope = $("#searchScope").value;
  const targets = Object.values(panes).filter(p => p.pdf && (scope === "both" || scope === p.side)).map(p => ({ p, pdf: p.pdf, generation: p.generation }));
  if (!targets.length) { $("#searchStatus").textContent = "请先在所选范围打开 PDF。"; return; }
  let done = 0, failed = 0, capped = false, lastPublish = 0, sliceStart = performance.now();
  const total = targets.reduce((sum, target) => sum + target.pdf.numPages, 0);
  searchState.running = true;
  const valid = target => token === searchState.token && target.p.pdf === target.pdf && target.p.generation === target.generation;
  const publish = () => {
    $("#searchStatus").textContent = `正在搜索 ${done} / ${total} 页 · ${searchState.hits.length} 处匹配`;
    renderSearchResults(); lastPublish = performance.now();
  };
  publish();
  for (const target of targets) {
    const { p, pdf, generation } = target;
    for (let n = 1; n <= pdf.numPages; n++) {
      if (!valid(target)) return;
      try {
        const page = await getSearchPage(pdf, n, p);
        if (!valid(target)) return;
        const normalized = await getNormalizedSearchPage(page, sensitive, () => valid(target));
        if (!normalized || !valid(target)) return;
        const text = normalized.text;
        const pageHits = []; let cursor = 0, start;
        while ((start = text.indexOf(query, cursor)) !== -1) {
          const end = start + query.length; cursor = end;
          if (!whole || isWholeSearchMatch(text, start, end, query)) {
            // Never match just half of a normalization expansion (e.g. ﬁ -> fi).
            if ((start === 0 || normalized.starts[start - 1] !== normalized.starts[start]) &&
                (end === text.length || normalized.ends[end - 1] !== normalized.ends[end])) {
              const displayStart = normalized.starts[start], displayEnd = normalized.ends[end - 1];
              const snippetStart = Math.max(0, displayStart - 45), snippetEnd = Math.min(page.text.length, displayEnd + 75);
              const hit = {
                side: p.side, page: n, generation, pdf, rawLength: page.rawLength, hash: page.hash,
                rawStart: sourceSearchOffset(page, displayStart), rawEnd: sourceSearchOffset(page, displayEnd, true),
                before: (snippetStart ? "…" : "") + page.text.slice(snippetStart, displayStart).replace(/\s+/gu, " "),
                match: page.text.slice(displayStart, displayEnd).replace(/\s+/gu, " "),
                after: page.text.slice(displayEnd, snippetEnd).replace(/\s+/gu, " ") + (snippetEnd < page.text.length ? "…" : "")
              };
              pageHits.push(hit); searchState.hits.push(hit);
              if (searchState.hits.length >= SEARCH_LIMITS.hits) { capped = true; break; }
            }
          }
          if (performance.now() - sliceStart > 8) { await sleep(0); sliceStart = performance.now(); if (!valid(target)) return; }
        }
        if (pageHits.length) { searchState.byPage.set(searchPageKey(p, n), pageHits); const m = p.models[n - 1]; if (m?.textReady) paintSearchHits(p, m); }
      } catch (error) { if (!valid(target)) return; failed++; console.warn("PDF search page failed", p.side, n, error); }
      done++;
      if (performance.now() - lastPublish > 100) publish();
      if (performance.now() - sliceStart > 8) { await sleep(0); sliceStart = performance.now(); }
      if (capped) break;
    }
    if (capped) break;
  }
  if (token !== searchState.token) return;
  searchState.running = false;
  searchState.summary = searchState.hits.length ? `${searchState.hits.length}${capped ? "+" : ""} 处匹配${whole ? " · 完整词" : " · 部分匹配"}${capped ? " · 达到 2000 处上限，请缩小范围" : ""}` : "未找到匹配。可取消“完整词”扩大范围；扫描件需 OCR。";
  if (failed) searchState.summary += ` · ${failed} 页读取失败`;
  $("#searchStatus").textContent = searchState.summary; renderSearchResults();
}
function renderSearchResults() {
  const list = $("#searchResults"), fragment = document.createDocumentFragment();
  const pages = Math.max(1, Math.ceil(searchState.hits.length / SEARCH_LIMITS.rows));
  searchState.listPage = Math.min(searchState.listPage, pages - 1);
  const base = searchState.listPage * SEARCH_LIMITS.rows, end = Math.min(searchState.hits.length, base + SEARCH_LIMITS.rows);
  for (let i = base; i < end; i++) {
    const hit = searchState.hits[i], button = document.createElement("button");
    button.type = "button"; button.className = "search-result" + (i === searchState.index ? " active" : ""); button.dataset.resultIndex = i;
    button.setAttribute("aria-current", i === searchState.index ? "true" : "false");
    const label = document.createElement("strong"); label.textContent = `${hit.side === "left" ? "左侧" : "右侧"} · 第 ${hit.page} 页 · #${i + 1}`;
    const snippet = document.createElement("span"), mark = document.createElement("mark"); mark.textContent = hit.match;
    snippet.append(hit.before, mark, hit.after); button.append(label, snippet); fragment.append(button);
  }
  // Explicit pagination keeps every result reachable while bounding DOM work.
  if (pages > 1) {
    const pager = document.createElement("div"); pager.className = "search-pager";
    for (const [delta, title] of [[-1, "上一组"], [1, "下一组"]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = title; button.dataset.resultPage = searchState.listPage + delta;
      button.disabled = searchState.listPage + delta < 0 || searchState.listPage + delta >= pages; pager.append(button);
      if (delta === -1) { const caption = document.createElement("span"); caption.textContent = `${base + 1}–${end} / ${searchState.hits.length}`; pager.append(caption); }
    }
    fragment.append(pager);
  }
  const focus = list.contains(document.activeElement) ? document.activeElement?.dataset : null;
  const focusedIndex = focus?.resultIndex, focusedPage = focus?.resultPage;
  list.replaceChildren(fragment);
  if (focusedIndex !== undefined) list.querySelector(`[data-result-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
  else if (focusedPage !== undefined) list.querySelector(`[data-result-page="${focusedPage}"]`)?.focus({ preventScroll: true });
  $("#searchPrev").disabled = $("#searchNext").disabled = !searchState.hits.length;
}
async function jumpSearch(index) {
  if (!searchState.hits.length) return;
  const jump = ++searchState.jumpToken;
  const old = searchState.hits[searchState.index];
  searchState.index = (index + searchState.hits.length) % searchState.hits.length;
  const hit = searchState.hits[searchState.index], p = panes[hit.side];
  if (hit.pdf !== p.pdf || hit.generation !== p.generation) { queueSearch(); return; }
  searchState.listPage = Math.floor(searchState.index / SEARCH_LIMITS.rows);
  if (p.paneEl.hidden) setLayout(hit.side);
  appState.activeSide = hit.side; p.goToPage(hit.page, false);
  const model = p.models[hit.page - 1];
  try {
    await p.ensureRendered(model, 300000, "fast"); await p.ensureTextLayer(model, true);
    if (jump !== searchState.jumpToken || hit.pdf !== p.pdf || hit.generation !== p.generation) return;
    if (old) { const pane = panes[old.side], m = pane.models[old.page - 1]; if (m?.textReady && pane.generation === old.generation) paintSearchHits(pane, m); }
    paintSearchHits(p, model); renderSearchResults();
    const range = searchState.decorations.get(searchPageKey(p, hit.page))?.ranges.find(entry => entry.hit === hit)?.range;
    if (range) {
      const rect = range.getBoundingClientRect(), viewport = p.viewer.getBoundingClientRect();
      const visibleLeft = viewport.left + (p.searchInsetLeft || 0);
      const visibleRight = viewport.left + p.viewer.clientWidth - (p.searchInsetRight || 0);
      const visibleHeight = Math.max(48, p.viewer.clientHeight - (p.searchInsetBottom || 0));
      p.viewer.scrollTop += rect.top - viewport.top - visibleHeight * .35;
      if (rect.left < visibleLeft + 16) p.viewer.scrollLeft += rect.left - visibleLeft - 24;
      else if (rect.right > visibleRight - 16) p.viewer.scrollLeft += rect.right - visibleRight + 24;
    }
    $("#searchStatus").textContent = `第 ${searchState.index + 1} / ${searchState.hits.length} 处 · ${hit.side === "left" ? "左侧" : "右侧"}第 ${hit.page} 页${range ? "" : " · 已定位到页面，文字层暂不可用"}${searchState.running ? " · 搜索仍在继续" : ""}`;
    $("#searchResults").querySelector(".active")?.scrollIntoView({ block: "nearest" });
  } catch { if (jump === searchState.jumpToken) toast("该结果暂时无法定位，请重试。", true); }
}
$("#searchBtn").onclick = openSearch; $("#closeSearch").onclick = closeSearch;
for (const selector of ["#searchInput", "#searchScope", "#searchCase", "#searchWhole"]) $(selector)[selector === "#searchInput" ? "oninput" : "onchange"] = queueSearch;
$("#searchResults").onclick = event => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  if (button.dataset.resultIndex !== undefined) jumpSearch(Number(button.dataset.resultIndex));
  else if (button.dataset.resultPage !== undefined) { searchState.listPage = Number(button.dataset.resultPage); renderSearchResults(); $("#searchResults").scrollTop = 0; $("#searchResults").querySelector("button")?.focus({ preventScroll: true }); }
};
$("#searchPrev").onclick = () => jumpSearch(searchState.index < 0 ? searchState.hits.length - 1 : searchState.index - 1);
$("#searchNext").onclick = () => jumpSearch(searchState.index + 1);
$("#searchInput").onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); if (event.shiftKey) $("#searchPrev").click(); else $("#searchNext").click(); } };
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); openSearch(); }
  if (event.key === "Escape" && !$("#searchPanel").hidden) { event.preventDefault(); closeSearch(); }
}, true);
for (const p of Object.values(panes)) {
  p.paneEl.addEventListener("pointerdown", () => { appState.activeSide = p.side; });
  const originalLoad = p.loadFile.bind(p), originalDestroy = p.destroyDocument.bind(p);
  p.loadFile = async (...args) => { resetSearch(); try { return await originalLoad(...args); } finally { if (!$("#searchPanel").hidden) queueSearch(); } };
  p.destroyDocument = async (...args) => {
    const pdf = p.pdf; resetSearch();
    if (pdf) { const prefix = `${searchDocumentId(pdf)}:`; for (const [key, page] of searchState.cache) if (key.startsWith(prefix)) { searchState.bytes -= page.bytes; searchState.cache.delete(key); } }
    try { return await originalDestroy(...args); } finally { if (!$("#searchPanel").hidden) queueSearch(); }
  };
}
renderSearchResults();



function showReadingControls(p){p.paneEl.classList.add("controls-visible");clearTimeout(p.controlsTimer);p.controlsTimer=setTimeout(()=>p.paneEl.classList.remove("controls-visible"),1700)}
for(const p of Object.values(panes)){p.paneEl.addEventListener("pointermove",()=>showReadingControls(p),{passive:true});p.paneEl.addEventListener("pointerdown",()=>showReadingControls(p),{passive:true});p.paneEl.addEventListener("pointerleave",()=>{clearTimeout(p.controlsTimer);p.paneEl.classList.remove("controls-visible")});p.viewer.tabIndex=0;p.viewer.setAttribute("aria-label",p.side==="left"?"左侧文档阅读区":"右侧文档阅读区");}
function setZen(value){document.body.classList.toggle("zen",value);$("#zenBtn").setAttribute("aria-pressed",String(value));$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false");Object.values(panes).forEach(p=>p.onResize());if(value)$("#exitZen").focus();else $("#zenBtn").focus()}
$("#zenBtn").onclick=()=>setZen(!document.body.classList.contains("zen"));$("#exitZen").onclick=()=>setZen(false);
$("#fitAll").onclick=()=>{for(const p of Object.values(panes)){if(p.pdf&&!p.paneEl.hidden){p.fitWidth({propagate:false});p.viewer.scrollLeft=0;showReadingControls(p)}}};
$("#fullBtn").onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{toast("此浏览器无法进入全屏，请使用浏览器的全屏命令。",true)}};
$("#syncMenuBtn").onclick=()=>{const menu=$("#syncMenu");menu.hidden=!menu.hidden;$("#syncMenuBtn").setAttribute("aria-expanded",String(!menu.hidden))};
document.addEventListener("pointerdown",e=>{if(!e.target.closest("#syncMenu,#syncMenuBtn")){$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false")}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false");if(document.body.classList.contains("zen"))setZen(false)}if(e.code==="KeyF"&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)){e.preventDefault();setZen(!document.body.classList.contains("zen"))}});

refreshSessionHint();

// One coordinate system for mouse, buttons and touch. Geometry and scroll bounds
// change together during the gesture; releasing only schedules sharper canvases.
Object.assign(PdfPane.prototype, {
  captureWheelZoomGesture(clientX, clientY) {
    const rect = this.viewer.getBoundingClientRect();
    const localX = clamp(clientX - rect.left, 0, this.viewportW);
    const localY = clamp(clientY - rect.top, 0, this.viewportH);
    const scale = Math.max(.00001, this.layoutScale);
    return {
      localX, localY,
      baseX: (this.viewer.scrollLeft + localX - this.planeOffsetX) / scale,
      baseY: (this.viewer.scrollTop + localY) / scale
    };
  },

  beginZoomPreview(clientX, clientY) {
    this.refreshViewportMetrics();
    this.zoomAnchor = this.captureWheelZoomGesture(clientX, clientY);
    if (!this.zoomPreviewActive) {
      this.zoomPreviewActive = true;
      this.viewer.classList.add('zoom-preview');
      this.cancelSharpRender();
      updateRenderConcurrency();
    }
    this.wheelZoomTargetScale = this.scale;
  },

  applyAnchoredZoom(next, anchor = this.zoomAnchor) {
    if (!this.pdf || !this.plane || !anchor) return;
    next = clamp(next, CFG.MIN_SCALE, CFG.MAX_SCALE);
    this.scale = this.layoutScale = this.wheelZoomTargetScale = next;
    this.updateSurfaceGeometry(next);
    // A horizontal scrollbar can change the usable height. Reconcile it once,
    // before clamping, so preview and committed positions stay identical.
    if (this.viewer.clientWidth !== this.viewportW || this.viewer.clientHeight !== this.viewportH) {
      this.refreshViewportMetrics();
      this.updateSurfaceGeometry(next);
    }
    const left = clamp(this.planeOffsetX + anchor.baseX * next - anchor.localX, 0, this.maxScrollX());
    const top = clamp(anchor.baseY * next - anchor.localY, 0, this.maxScrollY());
    this.viewer.scrollLeft = left;
    this.viewer.scrollTop = top;
    this.syncEcho = {left: this.viewer.scrollLeft, top: this.viewer.scrollTop, until: performance.now() + 150};
    this.updateZoomUI();
  },

  flushZoomFrame() {
    if (this.zoomRaf) { cancelAnimationFrame(this.zoomRaf); this.zoomRaf = 0; }
    if (!this.zoomPreviewActive || !this.pdf) return;
    this.applyAnchoredZoom(this.wheelZoomTargetScale);
  },

  onWheel(event) {
    if (!this.pdf) return;
    if (!(event.ctrlKey || event.metaKey)) {
      if (this.zoomPreviewActive) this.commitWheelZoom();
      return;
    }
    event.preventDefault();
    appState.activeSide = this.side;
    const rect = this.viewer.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, this.viewportW);
    const y = clamp(event.clientY - rect.top, 0, this.viewportH);
    if (!this.zoomPreviewActive) this.beginZoomPreview(event.clientX, event.clientY);
    else if (Math.abs(x - this.zoomAnchor.localX) > .5 || Math.abs(y - this.zoomAnchor.localY) > .5) {
      this.flushZoomFrame();
      this.zoomAnchor = this.captureWheelZoomGesture(event.clientX, event.clientY);
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(320, this.viewportH) : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    this.wheelZoomTargetScale = clamp(this.wheelZoomTargetScale * Math.exp(-delta * .0015), CFG.MIN_SCALE, CFG.MAX_SCALE);
    if (!this.zoomRaf) this.zoomRaf = requestAnimationFrame(() => { this.zoomRaf = 0; this.flushZoomFrame(); });
    clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = setTimeout(() => this.commitWheelZoom(), CFG.WHEEL_ZOOM_SETTLE_MS);
  },

  commitWheelZoom({propagate = true} = {}) {
    clearTimeout(this.wheelZoomTimer); this.wheelZoomTimer = 0;
    if (!this.zoomPreviewActive || !this.pdf) return;
    this.flushZoomFrame();
    this.zoomPreviewActive = false;
    this.zoomMode = 'custom';
    this.zoomAnchor = null;
    this.viewer.classList.remove('zoom-preview');
    updateRenderConcurrency();
    this.updateCurrentPage();
    this.renderNearViewport({quality: 'fast'});
    this.scheduleSharpRender();
    this.schedulePersistView();
    if (propagate && appState.layout === 'dual' && appState.syncZoom && this.other().pdf) {
      this.other().setScale(this.scale, {propagate: false});
    }
  },

  setScale(next, {anchorClientX = null, anchorClientY = null, propagate = true, persist = true, mode = 'custom'} = {}) {
    if (!this.pdf) return;
    if (this.zoomPreviewActive) this.commitWheelZoom({propagate: false});
    next = clamp(next, CFG.MIN_SCALE, CFG.MAX_SCALE);
    this.refreshViewportMetrics();
    const rect = this.viewer.getBoundingClientRect();
    const anchor = this.captureWheelZoomGesture(anchorClientX ?? rect.left + this.viewportW / 2, anchorClientY ?? rect.top + this.viewportH / 2);
    this.zoomMode = mode;
    this.applyAnchoredZoom(next, anchor);
    this.updateCurrentPage();
    this.renderNearViewport({quality: 'fast'});
    this.scheduleSharpRender();
    if (persist) this.schedulePersistView();
    if (propagate && appState.layout === 'dual' && appState.syncZoom && this.other().pdf) {
      this.other().setScale(next, {propagate: false, persist, mode});
    }
  }
});

// Search floats over the reader. Only scrollable clearance grows; the document
// plane, viewport width, fit scale and current scroll position stay unchanged.
function searchOverlayClearance(viewer, panel, bottom = false) {
  const overlapX = Math.max(0, Math.min(viewer.right, panel.right) - Math.max(viewer.left, panel.left));
  const overlapY = Math.max(0, Math.min(viewer.bottom, panel.bottom) - Math.max(viewer.top, panel.top));
  if (!overlapX || !overlapY) return {right:0, bottom:0};
  return bottom ? {right:0, bottom:Math.ceil(overlapY)} : {right:Math.ceil(overlapX), bottom:0};
}
function refreshSearchOverlayLayout() {
  const panel = $('#searchPanel');
  const rect = panel.hidden ? null : panel.getBoundingClientRect();
  const navigator = $('#pdfNavigator');
  const navRect = navigator && !navigator.hidden ? navigator.getBoundingClientRect() : null;
  const bottom = matchMedia('(max-width:760px)').matches;
  for (const pane of Object.values(panes)) {
    const bounds = pane.viewer.getBoundingClientRect();
    const clearance = rect && !pane.paneEl.hidden ? searchOverlayClearance(bounds, rect, bottom) : {right:0,bottom:0};
    const insetLeft = navRect && !pane.paneEl.hidden ? searchOverlayClearance(bounds, navRect).right : 0;
    if ((pane.searchInsetLeft || 0) === insetLeft && (pane.searchInsetRight || 0) === clearance.right && (pane.searchInsetBottom || 0) === clearance.bottom) continue;
    const left = pane.viewer.scrollLeft + insetLeft - (pane.searchInsetLeft || 0), top = pane.viewer.scrollTop;
    pane.searchInsetLeft = insetLeft;
    pane.searchInsetRight = clearance.right;
    pane.searchInsetBottom = clearance.bottom;
    if (!pane.pdf || !pane.plane) continue;
    pane.refreshViewportMetrics();
    pane.updateSurfaceGeometry(pane.layoutScale);
    // Clamp only when closing removes clearance the user had scrolled into.
    pane.viewer.scrollLeft = clamp(left,0,pane.maxScrollX());
    pane.viewer.scrollTop = clamp(top,0,pane.maxScrollY());
    pane.syncEcho = {left:pane.viewer.scrollLeft,top:pane.viewer.scrollTop,until:performance.now()+150};
  }
}
let searchOverlayRaf = 0;
function queueSearchOverlayLayout() {
  if (searchOverlayRaf) return;
  searchOverlayRaf = requestAnimationFrame(() => {searchOverlayRaf=0;refreshSearchOverlayLayout();});
}
const searchOverlayObserver = new ResizeObserver(queueSearchOverlayLayout);
searchOverlayObserver.observe($('#searchPanel'));
for (const pane of Object.values(panes)) searchOverlayObserver.observe(pane.viewer);

// Native one-finger scrolling; pinch shares exactly the same geometry as mouse zoom.
function installPdfTouch(pane) {
  let pinch = null, frame = 0, pending = null, tap = null, lastTap = null;
  const center = touches => ({x:(touches[0].clientX+touches[1].clientX)/2, y:(touches[0].clientY+touches[1].clientY)/2});
  const distance = touches => Math.hypot(touches[0].clientX-touches[1].clientX, touches[0].clientY-touches[1].clientY);
  function paint() {
    frame = 0;
    if (!pinch || !pending || !pane.pdf || !pane.zoomPreviewActive) return;
    const rect = pane.viewer.getBoundingClientRect();
    pane.zoomAnchor.localX = pending.point.x - rect.left;
    pane.zoomAnchor.localY = pending.point.y - rect.top;
    pane.applyAnchoredZoom(pending.scale);
  }
  function finish() {
    if (frame) {cancelAnimationFrame(frame); frame=0;}
    paint();
    if (pinch && pane.zoomPreviewActive) pane.commitWheelZoom();
    pinch=null;pending=null;
  }
  pane.viewer.addEventListener('touchstart',event=>{
    if (!pane.pdf) return;
    appState.activeSide=pane.side;
    if (event.touches.length===1) {
      if (pane.zoomPreviewActive) pane.commitWheelZoom();
      const t=event.touches[0];tap={x:t.clientX,y:t.clientY,time:performance.now()};return;
    }
    tap=null;lastTap=null;
    if (event.touches.length!==2) {finish();return;}
    if (event.cancelable) event.preventDefault();
    finish();
    if (pane.zoomPreviewActive) pane.commitWheelZoom();
    const point=center(event.touches);
    pinch={distance:Math.max(1,distance(event.touches)),scale:pane.scale};
    pane.beginZoomPreview(point.x,point.y);
    // Stop residual native momentum at the point where two fingers take control.
    pane.viewer.scrollTo({left:pane.viewer.scrollLeft,top:pane.viewer.scrollTop,behavior:'instant'});
    clearTimeout(pane.wheelZoomTimer);
  },{passive:false});
  pane.viewer.addEventListener('touchmove',event=>{
    if (tap && event.touches.length===1 && Math.hypot(event.touches[0].clientX-tap.x,event.touches[0].clientY-tap.y)>8) tap=null;
    if (!pinch || event.touches.length!==2 || !pane.zoomPreviewActive) return;
    if (event.cancelable) event.preventDefault();
    pending={point:center(event.touches),scale:clamp(pinch.scale*distance(event.touches)/pinch.distance,CFG.MIN_SCALE,CFG.MAX_SCALE)};
    if (!frame) frame=requestAnimationFrame(paint);
  },{passive:false});
  pane.viewer.addEventListener('touchend',event=>{
    if (pinch) {if (event.touches.length<2) finish();return;}
    if (event.touches.length || !tap || performance.now()-tap.time>280) {tap=null;return;}
    const now=performance.now();
    if (lastTap && now-lastTap.time<320 && Math.hypot(lastTap.x-tap.x,lastTap.y-tap.y)<28 && !document.getSelection()?.toString()) {
      if (event.cancelable) event.preventDefault();
      if (pane.zoomMode==='fit-width') pane.setScale(Math.min(CFG.MAX_SCALE,pane.scale*1.7),{anchorClientX:tap.x,anchorClientY:tap.y,propagate:true});
      else pane.fitWidth({propagate:true});
      lastTap=null;
    } else lastTap={...tap,time:now};
    tap=null;
  },{passive:false});
  pane.viewer.addEventListener('touchcancel',()=>{tap=null;lastTap=null;finish();},{passive:true});
  pane.cancelTouch=()=>{tap=null;lastTap=null;finish();};
}

// Custom controls keep the original form values, events and keyboard semantics.
function enhanceWorkspaceSelect(select){
  const wrapper=document.createElement('div');wrapper.className='custom-select';select.before(wrapper);wrapper.append(select);select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const button=document.createElement('button');button.className='custom-select-button';button.type='button';button.id=`${select.id}Control`;button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',`${select.id}Options`);button.setAttribute('aria-label',select.getAttribute('aria-label')||'选择选项');
  const label=document.createElement('span');button.append(label);const arrow=document.createElementNS('http://www.w3.org/2000/svg','svg');arrow.setAttribute('viewBox','0 0 24 24');arrow.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m7 10 5 5 5-5');arrow.append(path);button.append(arrow);wrapper.append(button);
  const popup=document.createElement('div');popup.id=`${select.id}Options`;popup.className='custom-select-popup';popup.setAttribute('role','listbox');popup.setAttribute('aria-label',select.getAttribute('aria-label')||'选择选项');popup.hidden=true;(select.closest('dialog')||document.body).append(popup);
  let active=select.selectedIndex,typeahead='',typeTimer;
  function position(){if(popup.hidden)return;const rect=button.getBoundingClientRect(),width=Math.min(Math.max(rect.width,170),innerWidth-20);popup.style.width=`${width}px`;popup.style.left=`${clamp(rect.left,10,Math.max(10,innerWidth-width-10))}px`;const height=popup.offsetHeight;popup.style.top=`${rect.bottom+height+10<innerHeight?rect.bottom+10:Math.max(10,rect.top-height-10)}px`;}
  function highlight(){for(const item of popup.children)item.classList.toggle('is-highlighted',Number(item.dataset.index)===active);const item=popup.children[active];if(item){button.setAttribute('aria-activedescendant',item.id);if(!popup.hidden)item.scrollIntoView({block:'nearest'});}}
  function paint(){label.textContent=select.options[select.selectedIndex]?.textContent||'';button.disabled=select.disabled;popup.replaceChildren();for(let index=0;index<select.options.length;index++){const option=select.options[index],item=document.createElement('div');item.id=`${select.id}Option${index}`;item.className='custom-select-option';item.dataset.index=index;item.setAttribute('role','option');item.setAttribute('aria-selected',String(index===select.selectedIndex));item.setAttribute('aria-disabled',String(option.disabled));const text=document.createElement('span');text.textContent=option.textContent;const check=document.createElement('span');check.className='custom-option-check';check.innerHTML='<svg viewBox="0 0 24 24" focusable="false"><path d="m5 12 4 4L19 6"/></svg>';check.setAttribute('aria-hidden','true');item.append(text,check);popup.append(item);}highlight();}
  function close(){popup.hidden=true;button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');}
  function open(){document.dispatchEvent(new CustomEvent('workspace-select-open',{detail:select.id}));active=select.selectedIndex;paint();popup.hidden=false;button.setAttribute('aria-expanded','true');highlight();position();}
  function commit(index){const option=select.options[index];if(!option||option.disabled)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));paint();close();button.focus({preventScroll:true});}
  function move(delta){let next=active;for(let i=0;i<select.options.length;i++){next=(next+delta+select.options.length)%select.options.length;if(!select.options[next].disabled){active=next;break;}}highlight();}
  button.onclick=()=>popup.hidden?open():close();popup.onclick=event=>{const item=event.target.closest('[data-index]');if(item)commit(Number(item.dataset.index));};
  button.onkeydown=event=>{if(['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape'].includes(event.key)){event.preventDefault();if(event.key==='Escape'){close();return;}if(popup.hidden){open();if(['Enter',' '].includes(event.key))return;}if(event.key==='ArrowDown')move(1);else if(event.key==='ArrowUp')move(-1);else if(event.key==='Home'){active=0;highlight();}else if(event.key==='End'){active=select.options.length-1;highlight();}else commit(active);}else if(event.key==='Tab')close();else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){clearTimeout(typeTimer);typeahead+=event.key.toLocaleLowerCase();const index=Array.from(select.options).findIndex(option=>!option.disabled&&option.textContent.toLocaleLowerCase().startsWith(typeahead));if(index>=0){if(popup.hidden)open();active=index;highlight();}typeTimer=setTimeout(()=>typeahead='',650);}};
  select.addEventListener('change',paint);document.addEventListener('workspace-select-open',event=>{if(event.detail!==select.id)close();});document.addEventListener('pointerdown',event=>{if(!wrapper.contains(event.target)&&!popup.contains(event.target))close();});document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});window.addEventListener('resize',close);document.addEventListener('scroll',event=>{if(!popup.contains(event.target))close();},{capture:true,passive:true});paint();return {close,paint};
}
function requestPdfPassword(reason){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='app-dialog credential-dialog';dialog.setAttribute('aria-labelledby','passwordTitle');const title=document.createElement('h2');title.id='passwordTitle';title.textContent=reason===2?'密码不正确':'此 PDF 需要密码';const description=document.createElement('p');description.textContent=reason===2?'请重新输入此文档的打开密码。':'输入密码后，继续在本机打开这份文档。';const form=document.createElement('form');form.method='dialog';const field=document.createElement('input');field.type='password';field.autocomplete='off';field.setAttribute('aria-label','PDF 密码');field.required=true;field.placeholder='输入 PDF 密码';const actions=document.createElement('div');actions.className='credential-actions';const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary-button';cancel.textContent='取消';const submit=document.createElement('button');submit.type='submit';submit.className='primary-button';submit.textContent='打开文档';actions.append(cancel,submit);form.append(field,actions);dialog.append(title,description,form);document.body.append(dialog);let value=null;form.onsubmit=event=>{event.preventDefault();value=field.value;dialog.close();};cancel.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();resolve(value);},{once:true});dialog.showModal();field.focus();
  });
}
function confirmWorkspaceAction(message){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='app-dialog confirmation-dialog';dialog.setAttribute('aria-labelledby','confirmTitle');const title=document.createElement('h2');title.id='confirmTitle';title.textContent='移除历史文件？';const copy=document.createElement('p');copy.textContent=message;const actions=document.createElement('div');actions.className='credential-actions';const cancel=document.createElement('button');cancel.className='secondary-button';cancel.textContent='取消';const accept=document.createElement('button');accept.className='primary-button';accept.textContent='确认移除';actions.append(cancel,accept);dialog.append(title,copy,actions);document.body.append(dialog);let confirmed=false;accept.onclick=()=>{confirmed=true;dialog.close();};cancel.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();resolve(confirmed);},{once:true});dialog.showModal();cancel.focus();
  });
}

function parsePdfPageRange(value,total){
  if(!Number.isInteger(total)||total<1)throw new Error('请先选择有效的 PDF。');
  const text=String(value||'').trim();
  if(!text||/^(全部|所有|all)$/i.test(text))return Array.from({length:total},(_,i)=>i+1);
  const pages=new Set();
  for(const token of text.replace(/\s*[-–—~～]\s*/g,'-').split(/[,，、;；\s]+/).filter(Boolean)){
    const match=/^(\d+)(?:-(\d+))?$/.exec(token);if(!match)throw new Error(`页码格式不正确：${token}。例如 1-5, 8, 10-12。`);
    const start=Number(match[1]),end=Number(match[2]||match[1]);
    if(start<1||end>total||start>end)throw new Error(`页码范围应在 1–${total} 页之间，起始页不能大于结束页。`);
    for(let n=start;n<=end;n++)pages.add(n);
  }
  if(!pages.size)throw new Error('请输入要转换的页码。');
  return [...pages].sort((a,b)=>a-b);
}
function imageFilePrefix(value){
  let name=String(value||'PDF').replace(/\.pdf$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').trim().slice(0,100)||'PDF';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
  return name;
}
let imageZipCrcTable;
function imageZipCrc(bytes){
  if(!imageZipCrcTable){imageZipCrcTable=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;imageZipCrcTable[n]=c>>>0;}}
  let crc=0xFFFFFFFF;for(const byte of bytes)crc=imageZipCrcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xFFFFFFFF)>>>0;
}
async function buildImageZip(records){
  const encoder=new TextEncoder(),parts=[],central=[];let offset=0,centralSize=0;
  for(const record of records){
    const name=encoder.encode(record.name),bytes=new Uint8Array(await record.blob.arrayBuffer()),crc=imageZipCrc(bytes),size=record.blob.size;
    const local=new Uint8Array(30+name.length),view=new DataView(local.buffer);view.setUint32(0,0x04034B50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);view.setUint16(26,name.length,true);local.set(name,30);parts.push(local,record.blob);
    const entry=new Uint8Array(46+name.length),cv=new DataView(entry.buffer);cv.setUint32(0,0x02014B50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);entry.set(name,46);central.push(entry);centralSize+=entry.length;offset+=local.length+size;
  }
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054B50,true);ev.setUint16(8,records.length,true);ev.setUint16(10,records.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}

const imageExport={sources:new Map(),file:null,pdf:null,task:null,renderTask:null,token:0,running:false,cancelled:false,folder:null};
function initImageExport(){
  const dialog=document.createElement('dialog');dialog.id='imageExportDialog';dialog.className='app-dialog export-dialog';dialog.setAttribute('aria-labelledby','imageExportTitle');
  dialog.innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">PDF TO IMAGES</span><h2 id="imageExportTitle">PDF 转图片</h2></div><button id="closeImageExport" aria-label="关闭 PDF 转图片">${icon('close')}</button></div><div class="export-scroll"><section class="preference-group"><div class="export-section-heading"><h3>选择文档</h3><button id="browseExportPdf" class="text-button">${icon('folder')}选择其他 PDF</button></div><select id="imageExportSource" aria-label="要转换的 PDF"></select><input id="exportPdfFile" type="file" accept="application/pdf,.pdf" hidden><p id="imageExportInfo" class="export-file-info">选择一份 PDF，开始逐页转换。</p></section><section class="preference-group"><h3>转换设置</h3><label class="export-field"><span>页码范围 <small>留空表示全部页面</small></span><input id="imageExportRange" type="text" inputmode="text" placeholder="例如 1-5, 8, 10-12" aria-label="转换页码范围"><small id="imageExportRangeHint">可使用逗号分隔页码与范围。</small></label><div class="export-settings-grid"><label class="export-field"><span>清晰度</span><select id="imageExportDpi" aria-label="图片清晰度"><option value="150">150 DPI · 标准</option><option value="300" selected>300 DPI · 高清</option><option value="450">450 DPI · 超清</option><option value="600">600 DPI · 印刷级</option></select></label><label class="export-field"><span>图片格式</span><select id="imageExportFormat" aria-label="图片格式"><option value="png">PNG · 无损</option><option value="jpeg">JPG · 高质量</option></select></label></div><label class="export-field"><span>文件名前缀</span><input id="imageExportPrefix" type="text" placeholder="自动使用 PDF 文件名" aria-label="导出文件名前缀"><small id="imageExportNamePreview">每张图片都会自动添加原文档页码。</small></label><p id="imageExportDimensions" class="export-dimensions"></p></section><section class="preference-group"><h3>保存位置</h3><div class="theme-options export-target-options"><button id="exportToFolder" aria-pressed="true">${icon('folder')}指定文件夹</button><button id="exportToZip" aria-pressed="false">${icon('download')}ZIP 下载</button></div><button id="chooseExportFolder" class="export-folder-picker">${icon('folder')}<span id="exportFolderName">选择保存文件夹</span>${icon('arrow')}</button><p id="imageExportTargetHint" class="export-target-hint">将自动创建以 PDF 命名的子文件夹；重名图片会保留现有文件。</p></section></div><div id="imageExportProgress" class="export-progress" hidden><div><strong id="imageExportProgressText">准备转换…</strong><span id="imageExportPercent">0%</span></div><div class="export-progress-track"><i id="imageExportProgressBar"></i></div></div><div class="export-footer"><p id="imageExportStatus" role="status" aria-live="polite">原始颜色导出 · 本地处理</p><button id="cancelImageExport" class="secondary-button" hidden>取消转换</button><button id="startImageExport" class="primary-button" disabled>开始转换</button></div>`;
  document.body.append(dialog);
  $('#closeImageExport').onclick=()=>{if(imageExport.running){imageExport.cancelled=true;imageExport.renderTask?.cancel();return;}dialog.close();};
  dialog.addEventListener('cancel',event=>{if(imageExport.running){event.preventDefault();imageExport.cancelled=true;imageExport.renderTask?.cancel();}});
  dialog.addEventListener('close',()=>{++imageExport.token;imageExport.task?.destroy();imageExport.task=null;imageExport.pdf=null;imageExport.file=null;});
  $('#browseExportPdf').onclick=()=>$('#exportPdfFile').click();
  $('#exportPdfFile').onchange=event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;const key=`external-${Date.now()}`;imageExport.sources.set(key,{file,name:file.name});const option=new Option(file.name,key);$('#imageExportSource').append(option);$('#imageExportSource').value=key;$('#imageExportSource')._customControl?.paint();loadImageExportSource(key);};
  $('#imageExportSource').onchange=()=>loadImageExportSource($('#imageExportSource').value);
  for(const id of ['imageExportRange','imageExportDpi','imageExportFormat','imageExportPrefix'])$(`#${id}`).addEventListener(id.includes('Range')||id.includes('Prefix')?'input':'change',updateImageExportDetails);
  $('#exportToFolder').onclick=()=>setImageExportTarget('folder');$('#exportToZip').onclick=()=>setImageExportTarget('zip');
  $('#chooseExportFolder').onclick=chooseImageExportFolder;
  $('#startImageExport').onclick=runImageExport;$('#cancelImageExport').onclick=()=>{imageExport.cancelled=true;imageExport.renderTask?.cancel();};
}
async function openImageExport(){
  if($('#imageExportDialog').open)return;
  imageExport.sources.clear();imageExport.pdf=null;imageExport.file=null;$('#imageExportRange').value='';$('#imageExportPrefix').value='';$('#imageExportProgress').hidden=true;$('#imageExportStatus').textContent='原始颜色导出 · 本地处理';$('#exportFolderName').textContent=imageExport.folder?.name||'选择 Downloads 或其他文件夹';
  const active=activeWorkspaceTab();
  for(const tab of [active,...workspace.tabs].filter(Boolean))for(const side of ['left','right']){const source=tab.sources[side];if(source?.file&&!imageExport.sources.has(source.docId))imageExport.sources.set(source.docId,{...source,name:source.file.name});}
  for(const record of await dbGetDocs().catch(()=>[]))if(record.blob&&!imageExport.sources.has(record.id))imageExport.sources.set(record.id,{record,name:record.name});
  const select=$('#imageExportSource');select.replaceChildren();for(const [id,source]of imageExport.sources)select.append(new Option(source.name,id));if(!select.options.length)select.append(new Option('先选择一份 PDF',''));
  select._customControl?.paint();setImageExportTarget(typeof window.showDirectoryPicker==='function'?'folder':'zip');$('#imageExportDialog').showModal();
  if(select.value)await loadImageExportSource(select.value);else updateImageExportDetails();
}
function setImageExportTarget(mode){
  const supports=typeof window.showDirectoryPicker==='function';imageExport.target=mode==='folder'&&supports?'folder':'zip';
  $('#exportToFolder').disabled=!supports;$('#exportToFolder').setAttribute('aria-pressed',String(imageExport.target==='folder'));$('#exportToZip').setAttribute('aria-pressed',String(imageExport.target==='zip'));$('#chooseExportFolder').hidden=imageExport.target!=='folder';
  $('#imageExportTargetHint').textContent=imageExport.target==='folder'?'建议在 Downloads 中新建普通文件夹后选择。若提示“包含系统文件”，请选择新建的子文件夹。图片按 PDF 名称归档，已有图片会保留。':supports?'兼容下载方式。直接保存图片请选择“指定文件夹”。':'此浏览器不能直接写入本地文件夹，可使用 Chrome 或 Edge 选择 Downloads 中的普通子文件夹。';updateImageExportDetails();
}
async function chooseImageExportFolder(){
  const status=$('#imageExportStatus'),picker=$('#chooseExportFolder');
  const name=imageFilePrefix(imageExport.file?.name||'PDF 图片');
  status.textContent=`请在 Downloads 中选择普通子文件夹，也可以新建“${name}”后选择。`;
  try{
    // Do not reuse a remembered sensitive directory from the old picker ID.
    const folder=await window.showDirectoryPicker({mode:'readwrite',startIn:'downloads'});
    imageExport.folder=folder;imageExport.folderIssue='';picker.classList.remove('is-unavailable');
    $('#exportFolderName').textContent=folder.name;
    status.textContent=`保存到 ${folder.name}${folder.name===name?'':' / '+name}，点击转换开始保存。`;
  }catch(error){
    imageExport.folderIssue=error.name==='AbortError'?'未选择新目录。若浏览器提示包含系统文件，请在 Downloads 中新建普通子文件夹后重新选择。':'浏览器未允许写入此目录，请选择 Downloads 中的普通子文件夹并允许保存。';
    status.textContent=imageExport.folderIssue+(imageExport.folder?' 仍保留上次可用的目录。':'');
    if(!imageExport.folder)picker.classList.add('is-unavailable');
  }
  updateImageExportDetails();
}
async function imageExportDirectory(parent,pdfName){
  if(parent.queryPermission){
    let permission=await parent.queryPermission({mode:'readwrite'});
    if(permission!=='granted')permission=await parent.requestPermission({mode:'readwrite'});
    if(permission!=='granted')throw new DOMException('请重新选择保存文件夹并允许写入。','NotAllowedError');
  }
  const name=imageFilePrefix(pdfName);
  // Selecting the PDF-named folder directly must not create PDF/PDF nesting.
  return parent.name===name?parent:parent.getDirectoryHandle(name,{create:true});
}
async function loadImageExportSource(id){
  const source=imageExport.sources.get(id);if(!source)return;const token=++imageExport.token;imageExport.pdf=null;$('#startImageExport').disabled=true;$('#imageExportInfo').textContent='正在读取 PDF…';await imageExport.task?.destroy();
  try{
    const file=source.file||new File([source.record.blob],source.record.name,{type:'application/pdf'});imageExport.file=file;await getPdfEngine();if(token!==imageExport.token)return;
    const task=pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,cMapUrl:pdfAssetBase+'cmaps/',cMapPacked:true,standardFontDataUrl:pdfAssetBase+'standard_fonts/',wasmUrl:pdfAssetBase+'wasm/',iccUrl:pdfAssetBase+'iccs/'});imageExport.task=task;
    task.onPassword=async(update,reason)=>{const value=await requestPdfPassword(reason);if(value===null)task.destroy();else update(value);};
    const pdf=await task.promise;if(token!==imageExport.token){await task.destroy();return;}imageExport.pdf=pdf;$('#imageExportInfo').textContent=`${file.name} · ${pdf.numPages} 页 · ${formatBytes(file.size)}`;$('#imageExportPrefix').value=imageFilePrefix(file.name);$('#imageExportRangeHint').textContent=`共 ${pdf.numPages} 页，可输入 1-${pdf.numPages} 或多个不连续范围。`;updateImageExportDetails();
  }catch(error){if(token!==imageExport.token)return;$('#imageExportInfo').textContent='无法读取此 PDF，请重新选择。';$('#imageExportStatus').textContent=error.message||'文档加载失败';}
}
async function updateImageExportDetails(){
  const pdf=imageExport.pdf,button=$('#startImageExport');button.disabled=!pdf||imageExport.running||(imageExport.target==='folder'&&!imageExport.folder);
  if(pdf&&!imageExport.running&&imageExport.target==='folder'&&!imageExport.folder)$('#imageExportStatus').textContent=imageExport.folderIssue||'请先选择 Downloads 内的普通文件夹，也可以新建文件夹后选择。';
  const prefix=imageFilePrefix($('#imageExportPrefix').value||imageExport.file?.name),extension=$('#imageExportFormat').value==='png'?'png':'jpg';$('#imageExportNamePreview').textContent=`文件名示例：${prefix}_page-0001.${extension}`;
  if(!pdf){$('#imageExportDimensions').textContent='';return;}
  try{const pages=parsePdfPageRange($('#imageExportRange').value,pdf.numPages);button.textContent=`转换 ${pages.length} 页`;const page=await pdf.getPage(pages[0]);if(imageExport.pdf!==pdf)return;const viewport=page.getViewport({scale:Number($('#imageExportDpi').value)/72});$('#imageExportDimensions').textContent=`首张约 ${Math.ceil(viewport.width-1e-6)} × ${Math.ceil(viewport.height-1e-6)} 像素 · ${$('#imageExportDpi').value} DPI`;$('#imageExportRange').setAttribute('aria-invalid','false');}catch(error){button.disabled=true;$('#imageExportDimensions').textContent=error.message;$('#imageExportRange').setAttribute('aria-invalid','true');}
}
function setImageExportBusy(busy){
  imageExport.running=busy;$('#cancelImageExport').hidden=!busy;$('#startImageExport').hidden=busy;$('#closeImageExport').setAttribute('aria-label',busy?'取消转换':'关闭 PDF 转图片');
  for(const element of $('#imageExportDialog').querySelectorAll('.export-scroll input,.export-scroll select,.export-scroll button'))element.disabled=busy;
  if(!busy){$('#exportToFolder').disabled=typeof window.showDirectoryPicker!=='function';updateImageExportDetails();}
}
async function writeExportImage(directory,name,blob){
  const dot=name.lastIndexOf('.'),base=name.slice(0,dot),extension=name.slice(dot);let candidate=name,index=1;
  for(;;){try{await directory.getFileHandle(candidate);candidate=`${base}-${++index}${extension}`;}catch(error){if(error.name==='NotFoundError')break;throw error;}}
  const handle=await directory.getFileHandle(candidate,{create:true}),stream=await handle.createWritable();try{await stream.write(blob);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
}
async function runImageExport(){
  const pdf=imageExport.pdf;if(!pdf||imageExport.running)return;let pages;try{pages=parsePdfPageRange($('#imageExportRange').value,pdf.numPages);}catch(error){$('#imageExportStatus').textContent=error.message;return;}
  const dpi=Number($('#imageExportDpi').value),format=$('#imageExportFormat').value,prefix=imageFilePrefix($('#imageExportPrefix').value||imageExport.file.name),extension=format==='png'?'png':'jpg';
  const records=[];let bytes=0,completed=0,directory=null,canvas;
  imageExport.cancelled=false;setImageExportBusy(true);$('#imageExportProgress').hidden=false;$('#imageExportProgressBar').style.width='0%';$('#imageExportPercent').textContent='0%';
  try{
    if(imageExport.target==='folder'){if(!imageExport.folder)throw new Error('请先选择保存文件夹。');directory=await imageExportDirectory(imageExport.folder,imageExport.file.name);}
    const limit=matchMedia('(pointer: coarse)').matches?16_000_000:48_000_000;
    for(const number of pages){
      if(imageExport.cancelled)break;$('#imageExportProgressText').textContent=`正在转换第 ${number} 页 · ${completed+1} / ${pages.length}`;
      const page=await pdf.getPage(number),viewport=page.getViewport({scale:dpi/72}),width=Math.ceil(viewport.width-1e-6),height=Math.ceil(viewport.height-1e-6);
      if(width*height>limit||width>16384||height>16384)throw new Error(`第 ${number} 页在此清晰度下尺寸过大，请降低 DPI 后重试。`);
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      imageExport.renderTask=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)',intent:'print'});await imageExport.renderTask.promise;imageExport.renderTask=null;
      if(imageExport.cancelled)break;
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图片编码失败，请降低清晰度重试。')),format==='png'?'image/png':'image/jpeg',.98));
      const name=`${prefix}_page-${String(number).padStart(Math.max(4,String(pdf.numPages).length),'0')}.${extension}`;
      if(directory)await writeExportImage(directory,name,blob);else{bytes+=blob.size;if(bytes>512*1024*1024)throw new Error('图片总量较大，请缩小页码范围，或改为保存到文件夹。');records.push({name,blob});}
      canvas.width=canvas.height=1;canvas=null;page.cleanup();completed++;const percent=Math.round(completed/pages.length*100);$('#imageExportProgressBar').style.width=`${percent}%`;$('#imageExportPercent').textContent=`${percent}%`;$('#imageExportStatus').textContent=`已转换 ${completed} / ${pages.length} 页`;await nextFrame();
    }
    if(imageExport.cancelled){$('#imageExportStatus').textContent=directory?`已取消，已保存 ${completed} 页，其余页面未导出。`:'已取消，未生成压缩包。';return;}
    if(!directory){$('#imageExportProgressText').textContent='正在打包图片…';const zip=await buildImageZip(records);if(imageExport.cancelled){$('#imageExportStatus').textContent='已取消，未下载压缩包。';return;}const url=URL.createObjectURL(zip),link=document.createElement('a');link.href=url;link.download=`${prefix}_pages.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    $('#imageExportProgressText').textContent='转换完成';$('#imageExportStatus').textContent=directory?`已保存 ${completed} 张图片到 ${directory.name}`:`已生成 ${completed} 张图片的 ZIP 下载`;
  }catch(error){
    if(!imageExport.cancelled&&imageExport.target==='folder'&&['NotAllowedError','SecurityError','NotFoundError','InvalidStateError'].includes(error.name)){
      imageExport.folder=null;imageExport.folderIssue='所选目录不可写入或权限已失效。请在 Downloads 中新建普通子文件夹，再选择该文件夹并允许保存。';
      $('#exportFolderName').textContent='重新选择保存文件夹';$('#chooseExportFolder').classList.add('is-unavailable');
    }
    $('#imageExportStatus').textContent=imageExport.cancelled?(directory?`已取消，已保存 ${completed} 页。`:'已取消，未生成压缩包。'):`${imageExport.folderIssue||error.message||'转换失败'}${completed&&directory?` 已保存 ${completed} 页。`:''}`;
  }
  finally{if(canvas)canvas.width=canvas.height=1;imageExport.renderTask=null;records.length=0;setImageExportBusy(false);}
}

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
  const active=activeWorkspaceTab(),expected=active?['left','right'].filter(side=>active.sources[side]):[];
  $('#readerPanel').classList.toggle('tab-preparing',!!active&&(active.loading||(active.mode==='single'&&!expected.length)||expected.some(side=>panes[side].docId!==active.sources[side].docId||!panes[side].pdf||panes[side].documentOpening)));
  $('#homeTab').setAttribute('aria-selected', String(!workspace.active));
  $('#homeTab').tabIndex = workspace.active ? -1 : 0;
  if (workspace.active) $('#readerPanel').setAttribute('aria-labelledby', `tab-${workspace.active}`);
  document.title = workspace.active ? `${tabTitle(activeWorkspaceTab())} · 对读` : '对读 · PDF 工作空间';
  syncPdfNavigator();
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
  pane.refreshViewportMetrics();
  if(pane.zoomMode==='fit-width')pane.fitWidth({propagate:false,persist:false});
  else pane.updateSurfaceGeometry(pane.layoutScale);
  if(snapshot.view.anchor)pane.restoreLocalAnchor(snapshot.view.anchor);
  else {pane.viewer.scrollTop = snapshot.view.scrollTop; pane.viewer.scrollLeft = snapshot.view.scrollLeft;}
  pane.onResize(); pane.renderNearViewport(); pane.scheduleSharpRender();
}
function parkCurrentTab() {
  const tab = activeWorkspaceTab();
  if (!tab) return;
  if (document.body.classList.contains('zen')) setZen(false);
  closePdfNavigator();
  resetSearch(); $('#searchPanel').hidden = true; refreshSearchOverlayLayout(); clearMirrorSelection();
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
  if(!Object.values(tab.snapshots).some(snapshot=>snapshot?.pdf))await nextFrame();
  for (const side of ['left','right']) {
    const snapshot = tab.snapshots[side]; tab.snapshots[side] = null;
    if (snapshot?.pdf) restorePane(panes[side],snapshot);
    else if (tab.sources[side]) await loadTabSource(tab,side);
  }
  refreshSessionHint(); renderWorkspaceTabs(); saveWorkspaceTabs(); await evictWorkspaceCache();
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
    const badge = document.createElement('span'); badge.className = 'file-type-icon'; badge.innerHTML = icon('file'); badge.setAttribute('aria-hidden','true');
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
  const actions=$('#readerToolsRight');
  const mode=document.createElement('button'); mode.id='readingModeBtn'; mode.className='reader-mode-button'; mode.setAttribute('aria-label','切换 PDF 深色阅读'); mode.innerHTML=icon('moon')+'<span class="button-label">深色阅读</span>';
  mode.onclick=()=>applyReadingMode($('#readerPanel').dataset.readingMode==='original'?'dark':'original');
  const settings=document.createElement('button'); settings.id='readerPreferencesBtn'; settings.title='阅读颜色与界面偏好'; settings.setAttribute('aria-label','阅读偏好'); settings.innerHTML=icon('settings'); settings.onclick=openPreferences;
  const download=document.createElement('button'); download.title='下载当前 PDF'; download.setAttribute('aria-label','下载当前 PDF'); download.innerHTML=icon('download');
  download.onclick=()=>{const pane=panes[appState.activeSide];if(!pane.file){toast('请先打开一份 PDF。');return}const url=URL.createObjectURL(pane.file),link=document.createElement('a');link.href=url;link.download=pane.file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)};
  const images=document.createElement('button');images.id='pdfImageExportBtn';images.title='将当前 PDF 转为高清图片';images.setAttribute('aria-label','PDF 转图片');images.innerHTML=icon('image')+'<span class="button-label">转图片</span>';images.onclick=openImageExport;
  actions.prepend(mode,images,settings,download);
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
  const actions=$('#readerToolsRight'),menu=document.createElement('div');menu.id='readerMoreMenu';menu.className='reader-overflow';menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','全部阅读工具');$('#readerPanel').append(menu);
  const more=document.createElement('button');more.id='readerMoreBtn';more.title='全部阅读工具';more.setAttribute('aria-label','全部阅读工具');more.setAttribute('aria-expanded','false');more.innerHTML=icon('more');actions.append(more);
  const items=[['readerPreferencesBtn','阅读偏好'],['syncMenuBtn','双栏联动设置'],['fitAll','适合页面宽度'],['zenBtn','专注阅读'],['fullBtn','浏览器全屏']].map(([id,label])=>({button:document.getElementById(id),label}));
  const download=actions.querySelector('[aria-label="下载当前 PDF"]');items.push({button:download,label:'下载当前 PDF'});
  items.push({button:$('#readingModeBtn'),label:'深色阅读',narrowOnly:true},{button:$('#pdfImageExportBtn'),label:'PDF 转图片',narrowOnly:true});
  for(const item of items){const label=document.createElement('span');label.className='overflow-label';label.textContent=item.label;item.button.append(label);}
  function close(){menu.hidden=true;more.setAttribute('aria-expanded','false');}
  function arrange(){const compact=matchMedia('(max-width:1100px)').matches,narrow=matchMedia('(max-width:500px)').matches;for(const {button,narrowOnly} of items)((narrowOnly?narrow:compact)?menu:actions).append(button);if(!narrow)actions.prepend($('#readingModeBtn'),$('#pdfImageExportBtn'));more.hidden=!compact;close();}
  more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));};
  menu.addEventListener('click',event=>{if(event.target.closest('button'))close()});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#readerMoreMenu,#readerMoreBtn'))close()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close()});
  for(const query of ['(max-width:1100px)','(max-width:500px)'])matchMedia(query).addEventListener('change',arrange);arrange();
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
$('#newTabBtn').onclick=()=>filePicker.click();
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
