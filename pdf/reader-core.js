
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
  MOTION_RENDER_SCALE_CAP: 1.25,
  MOTION_CANVAS_PIXELS: 1_000_000,
  SCROLL_RENDER_INTERVAL_MS: 80,
  TEXT_DOM_PAGES: 12,
  FAST_RENDER_SCALE_CAP: 1.75,
  SHARP_RENDER_SCALE_CAP: 3.2,
  FAST_CANVAS_PIXELS: 2_600_000,
  SHARP_CANVAS_PIXELS: 6_000_000,
  CANVAS_MEMORY_BUDGET: matchMedia("(pointer: coarse)").matches ? 50_331_648 : 134_217_728, // 128 MiB per pane
  WHEEL_ZOOM_SETTLE_MS: 110,
  SHARP_IDLE_MS: 340,
  TEXT_IDLE_MS: 180,
  SCROLL_IDLE_MS: 200,
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
  cancel(key) {
    // Resolve discarded work so callers awaiting a first canvas can finish.
    this.jobs = this.jobs.filter(job => { if (job.key !== key) return true; job.resolve(); return false; });
  }
  add(fn, priority = 0, key = null) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ fn, priority, key, resolve, reject, serial: this.serial++ });
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
    this.scrollRenderTimer = 0;
    this.lastScrollRenderAt = 0;
    this.motionRange = "";
    this.viewSaveTimer = 0;
    this.sharpTimer = 0;
    this.geometryTimer = 0;
    this.memoryPruneHandle = 0;
    this.textIdleSerial = 0;
    this.isScrolling = false;
    this.syncEcho = null;
    this.renderingModels = new Set();
    this.textRenderingModels = new Set();
    this.textModels = new Set();
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
    this.pauseBackgroundWork();
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
    this.armScrollIdle();
    resumePdfThumbnails();
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

    const generation=this.generation,pdf=this.pdf;
    const page = await pdf.getPage(model.n);
    if(generation!==this.generation || pdf!==this.pdf)return page;
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
    const generation=this.generation;
    const page = await this.ensurePage(model);
    const tc = await page.getTextContent();
    if(generation===this.generation)this.textCache.set(model.n, tc);
    return tc;
  }

  desiredRenderScale(model, quality = "fast") {
    const zoom = this.layoutScale;
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.DPR_CAP);
    const cap = quality === "motion" ? CFG.MOTION_RENDER_SCALE_CAP : quality === "sharp" ? CFG.SHARP_RENDER_SCALE_CAP : CFG.FAST_RENDER_SCALE_CAP;
    const pixelBudget = quality === "motion" ? CFG.MOTION_CANVAS_PIXELS : quality === "sharp" ? CFG.SHARP_CANVAS_PIXELS : CFG.FAST_CANVAS_PIXELS;

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
    model.renderQuality = quality;
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
        // Let a pending input/paint run between PDF.js operator-list slices.
        // Keep the completed bitmap visible until its replacement is ready.
        renderTask.onContinue = resume => {
          if (this.isScrolling || this.panState || this.zoomPreviewActive) setTimeout(resume, 0);
          else resume();
        };

        try { await renderTask.promise; }
        catch (error) { staged.width = staged.height = 1; throw error; }
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
      }, priority, model);
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
    renderQueue.cancel(model);
    try { model.renderTask?.cancel() } catch {}
    model.renderTask = null;
    model.rendering = false;
    model.renderPromise = null;
    model.pendingScale = 0;
    this.renderingModels.delete(model);
  }

  scheduleTextLayer(model) {
    if (this.paneEl.hidden || document.body.dataset.view === 'home') return;
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
    if (model.textReady) { model.textLastUsed = performance.now(); return; }
    if (!force && (this.isScrolling || this.panState || this.zoomPreviewActive)) return;
    if (model.textRendering) {
      if (!force || model.textForced) { await model.textPromise?.catch(()=>{}); return; }
      this.cancelTextWork(model);
    }

    const work = this.buildTextLayer(model, force);
    model.textPromise = work;
    await work;
  }

  async buildTextLayer(model, force) {
    const generation = this.generation;
    const ticket = ++model.textTicket;
    model.textScheduled = false;
    model.textRendering = true;
    model.textForced = force;
    this.textRenderingModels.add(model);
    const valid = () => generation === this.generation && ticket === model.textTicket && model.el.isConnected &&
      (force || (!this.paneEl.hidden && !this.isScrolling && !this.panState && !this.zoomPreviewActive && this.modelIntersectsViewport(model,96)));

    try {
      const page = await this.ensurePage(model);
      if (!valid()) return;
      const textContent = await this.getTextContent(model);
      if (!valid()) return;

      const viewport = page.getViewport({ scale: 1 });
      const staged = document.createElement("div");
      staged.className = "textLayer";
      staged.style.setProperty("--total-scale-factor", "1");

      const layer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: staged,
        viewport
      });
      model.pendingTextLayer = layer;
      await layer.render();

      if (!valid()) { layer.cancel(); return; }

      model.textLayerEl.replaceWith(staged);
      try { model.textLayer?.cancel?.() } catch {}
      model.textLayerEl = staged;
      model.textLayer = layer;
      model.textReady = true;
      model.textLastUsed = performance.now();
      this.textModels.add(model);
      paintSearchHits(this, model);
      this.scheduleCanvasPrune();
    } catch (err) {
      if (!/cancel/i.test(String(err?.message || ""))) console.warn("Text layer failed", this.side, model.n, err);
    } finally {
      if (ticket === model.textTicket) {
        model.textRendering = false;
        model.textPromise = null;
        model.pendingTextLayer = null;
        this.textRenderingModels.delete(model);
      }
    }
  }

  cancelTextWork(model) {
    ++model.textTicket;
    try { model.pendingTextLayer?.cancel(); } catch {}
    model.pendingTextLayer = null;
    model.textPromise = null;
    model.textRendering = false;
    model.textScheduled = false;
    this.textRenderingModels.delete(model);
  }

  pauseBackgroundWork() {
    for (const model of this.textRenderingModels) if (!model.textForced) this.cancelTextWork(model);
    if (!this.documentOpening) for (const model of this.renderingModels) {
      // Stop upgrades, but never discard the only usable bitmap of an opening PDF.
      if (model.renderQuality !== 'motion' && model.pendingScale > this.desiredRenderScale(model,'motion') * 1.1) this.cancelModelRender(model);
    }
    pausePdfThumbnails();
  }

  pruneTextLayers() {
    if (this.textModels.size <= CFG.TEXT_DOM_PAGES) return;
    const selection = document.getSelection();
    const candidates = [...this.textModels].filter(model => !this.modelIntersectsViewport(model,this.viewportH) &&
      !model.textRendering && !model.textLayerEl.contains(selection?.anchorNode) && !model.textLayerEl.contains(selection?.focusNode))
      .sort((a,b)=>(a.textLastUsed||0)-(b.textLastUsed||0));
    // Bounded DOM detach work per idle turn. Search rebuilds a layer on demand.
    for (const model of candidates.slice(0,2)) {
      if (this.textModels.size <= CFG.TEXT_DOM_PAGES) break;
      clearSearchDecoration(searchPageKey(this,model.n));
      model.textLayer?.cancel(); model.textLayer = null;
      model.textLayerEl.replaceChildren(); model.textReady = false;
      this.textModels.delete(model);
    }
  }

  scheduleCanvasPrune() {
    if ((this.canvasBytes <= CFG.CANVAS_MEMORY_BUDGET && this.textModels.size <= CFG.TEXT_DOM_PAGES) || this.memoryPruneHandle || this.isScrolling || this.panState || this.zoomPreviewActive) return;
    const run = deadline => {
      this.memoryPruneHandle = 0;
      if (this.isScrolling || this.panState || this.zoomPreviewActive) return;
      const beforeBytes=this.canvasBytes,beforeText=this.textModels.size;
      this.pruneTextLayers();
      if (!deadline || deadline.didTimeout || deadline.timeRemaining() > 3) this.pruneCanvasMemory();
      // All remaining pages may be visible or selected. Wait for the next
      // viewport change instead of spinning idle callbacks with no reclaimable work.
      if (this.canvasBytes < beforeBytes || this.textModels.size < beforeText) this.scheduleCanvasPrune();
    };
    if ("requestIdleCallback" in window) this.memoryPruneHandle = requestIdleCallback(run, { timeout: CFG.MEMORY_PRUNE_IDLE_MS });
    else this.memoryPruneHandle = setTimeout(run, CFG.MEMORY_PRUNE_IDLE_MS);
  }

  // One downsample per idle turn, one draw, no resize/redraw of the large live bitmap.
  pruneCanvasMemory() {
    if (this.canvasBytes <= CFG.CANVAS_MEMORY_BUDGET || this.isScrolling || this.panState || this.zoomPreviewActive) return;
    let victim;
    for (const model of this.models) {
      if (model.canvasBytes <= 160000 || model.rendering || model.textRendering || this.modelIntersectsViewport(model,this.viewportH)) continue;
      if (!victim || model.lastUsed < victim.lastUsed) victim = model;
    }
    if (!victim) return;
    const old = victim.canvas, thumb = document.createElement('canvas');
    const ratio = Math.min(1,160 / Math.max(old.width,old.height));
    thumb.className = 'pdf-bitmap';
    thumb.width = Math.max(1,Math.round(old.width*ratio));
    thumb.height = Math.max(1,Math.round(old.height*ratio));
    thumb.getContext('2d',{alpha:false}).drawImage(old,0,0,thumb.width,thumb.height);
    old.replaceWith(thumb); old.width = old.height = 1;
    const bytes = thumb.width * thumb.height * 4;
    this.canvasBytes += bytes - victim.canvasBytes;
    victim.canvas = thumb; victim.canvasBytes = bytes; victim.renderedScale = 0;
    try { victim.page?.cleanup?.(); } catch {}
  }

  releaseIfFar() { this.scheduleCanvasPrune(); }

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

    const margin = overscan ?? this.viewportH * (quality === 'motion' ? .65 : CFG.RENDER_OVERSCAN_VIEWPORTS);
    const models = this.modelsInViewport(margin);
    if (quality === 'motion') {
      const range = `${this.generation}:${models[0]?.n}:${models.at(-1)?.n}:${this.layoutScale}`;
      if (this.motionRange === range) return;
      this.motionRange = range;
    } else this.motionRange = '';

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
      // Cached and queued pages require no Promise allocation at scroll frequency.
      const target = this.desiredRenderScale(m,quality);
      if (m.canvas?.width > 1 && m.renderedScale >= target * .96) { m.lastUsed = performance.now(); continue; }
      if (m.rendering && m.pendingScale >= target * .96) continue;
      this.ensureRendered(m, priority, quality);
    }

    if (includeText) this.scheduleVisibleTextLayers();
  }

  scheduleVisibleTextLayers() {
    if (this.paneEl.hidden || document.body.dataset.view === 'home') return;
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
      if (!this.pdf || this.paneEl.hidden || document.body.dataset.view === 'home' || this.zoomPreviewActive || this.panState || this.isScrolling || this.documentOpening) return;
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
      this.motionRange = '';
      this.pauseBackgroundWork();
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
    clearTimeout(this.scrollRenderTimer); this.scrollRenderTimer = 0;
    this.motionRange = '';
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
    resumePdfThumbnails();
  }

  scheduleScrollRender() {
    if (this.scrollRenderTimer || this.zoomPreviewActive || this.documentOpening) return;
    const generation = this.generation;
    const delay = Math.max(0,CFG.SCROLL_RENDER_INTERVAL_MS - (performance.now() - this.lastScrollRenderAt));
    // A task after the scroll frame; drawing is never started inside its RAF.
    this.scrollRenderTimer = setTimeout(() => {
      this.scrollRenderTimer = 0;
      if (generation !== this.generation || !this.pdf || !this.isScrolling) return;
      this.lastScrollRenderAt = performance.now();
      this.renderNearViewport({quality:'motion',includeText:false});
    }, delay);
  }

onScroll() {
  if (!this.pdf || this.paneEl.hidden || document.body.dataset.view === 'home') return;
  // Mark interaction immediately, before asynchronous text/render work can resume.
  this.beginScrollActivity();
  if (this.scrollRaf) return;
  this.scrollRaf = requestAnimationFrame(() => {
    this.scrollRaf = 0;
    if (!this.pdf) return;

    // 滚动时显示底部阅读控制栏，
    // showReadingControls 内部会自动延迟隐藏。
    showReadingControls(this);

    this.updateCurrentPage();
    this.scheduleScrollRender();

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
    clearTimeout(this.scrollRenderTimer); this.scrollRenderTimer = 0;
    this.motionRange = '';
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
      this.cancelModelRender(m);
      this.cancelTextWork(m);
      try { m.renderTask?.cancel() } catch {}
      try { m.textLayer?.cancel?.() } catch {}
      if (m.canvas) {
        m.canvas.width = 1;
        m.canvas.height = 1;
      }
      try { m.page?.cleanup?.() } catch {}
    }

    this.models = [];
    this.textRenderingModels.clear(); this.textModels.clear();
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
      // Keep the results already shown; background extraction yields to reading.
      while (p.isScrolling || p.panState || p.zoomPreviewActive) { await sleep(50); if (!valid(target)) return; }
      try {
        const page = await getSearchPage(pdf, n, p);
        if (!valid(target)) return;
        while (p.isScrolling || p.panState || p.zoomPreviewActive) { await sleep(50); if (!valid(target)) return; }
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



function showReadingControls(p){
  const now=performance.now();
  if(p.controlsTimer && now-(p.controlsShownAt||0)<250)return;
  p.controlsShownAt=now;
  if(!p.controlsTimer)p.paneEl.classList.add('controls-visible');
  clearTimeout(p.controlsTimer);
  p.controlsTimer=setTimeout(()=>{p.controlsTimer=0;p.paneEl.classList.remove('controls-visible');},1700);
}
for(const p of Object.values(panes)){p.paneEl.addEventListener("pointermove",()=>showReadingControls(p),{passive:true});p.paneEl.addEventListener("pointerdown",()=>showReadingControls(p),{passive:true});p.paneEl.addEventListener("pointerleave",()=>{clearTimeout(p.controlsTimer);p.controlsTimer=0;p.paneEl.classList.remove("controls-visible")});p.viewer.tabIndex=0;p.viewer.setAttribute("aria-label",p.side==="left"?"左侧文档阅读区":"右侧文档阅读区");}
function setZen(value){document.body.classList.toggle("zen",value);$("#zenBtn").setAttribute("aria-pressed",String(value));$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false");Object.values(panes).forEach(p=>p.onResize());if(value)$("#exitZen").focus();else $("#zenBtn").focus()}
$("#zenBtn").onclick=()=>setZen(!document.body.classList.contains("zen"));$("#exitZen").onclick=()=>setZen(false);
$("#fitAll").onclick=()=>{for(const p of Object.values(panes)){if(p.pdf&&!p.paneEl.hidden){p.fitWidth({propagate:false});p.viewer.scrollLeft=0;showReadingControls(p)}}};
$("#fullBtn").onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{toast("此浏览器无法进入全屏，请使用浏览器的全屏命令。",true)}};
$("#syncMenuBtn").onclick=()=>{const menu=$("#syncMenu");menu.hidden=!menu.hidden;$("#syncMenuBtn").setAttribute("aria-expanded",String(!menu.hidden))};
document.addEventListener("pointerdown",e=>{if(!e.target.closest("#syncMenu,#syncMenuBtn")){$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false")}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){$("#syncMenu").hidden=true;$("#syncMenuBtn").setAttribute("aria-expanded","false");if(document.body.classList.contains("zen"))setZen(false)}if(e.code==="KeyF"&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)){e.preventDefault();setZen(!document.body.classList.contains("zen"))}});

refreshSessionHint();
