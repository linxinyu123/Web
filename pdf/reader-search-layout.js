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
