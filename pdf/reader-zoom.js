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
      this.pauseBackgroundWork();
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
    resumePdfThumbnails();
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
