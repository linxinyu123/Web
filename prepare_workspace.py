from pathlib import Path
import base64
import re, tarfile, io, urllib.request

root = Path(__file__).parent
backup = root / '.backups' / 'index-before-workspace.html'
backup.parent.mkdir(exist_ok=True)
if not backup.exists():
    backup.write_bytes((root / 'index.html').read_bytes())
source = backup.read_text(encoding='utf-8')
css = re.search(r'<style>(.*?)</style>', source, re.S).group(1)
js = re.search(r'<script type="module">(.*?)</script>', source, re.S).group(1)
main = re.search(r'  <main class="main".*?</main>', source, re.S).group(0)
toolbar = re.search(r'  <header class="topbar">.*?</header>', source, re.S).group(0)
overlays = source.split('</main>')[1].split('<script type="module">')[0]
overlays = overlays.replace('\n</div>', '', 1)
js = re.sub(r'const pdfjsLib = await import\(.*?pdfjsLib.GlobalWorkerOptions.workerSrc = .*?;\n', '''let pdfjsLib;
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
''', js, count=1, flags=re.S)
js = js.replace('HISTORY_LIMIT: 12', 'HISTORY_LIMIT: 60')
js = js.replace('CANVAS_MEMORY_BUDGET: 134_217_728,', 'CANVAS_MEMORY_BUDGET: matchMedia("(pointer: coarse)").matches ? 50_331_648 : 134_217_728,')
js = js.replace('e.preventDefault(); this.pageInput.blur();', 'e.preventDefault(); this.goToPage(+this.pageInput.value || 1, true); this.pageInput.blur();')
main = main.replace('class="tool-group" aria-label="左侧页码"', 'class="tool-group" aria-label="左侧页码导航"').replace('class="tool-group" aria-label="右侧页码"', 'class="tool-group" aria-label="右侧页码导航"')
overlays = overlays.replace('最近 12 份', '最近 60 份')
js = js.replace('function setSessionSide(side, id) { const s = getSession(); s[side] = id || null; localStorage.setItem(CFG.SESSION_KEY, JSON.stringify(s)); }', 'function setSessionSide(side, id) { try { const s = getSession(); s[side] = id || null; localStorage.setItem(CFG.SESSION_KEY, JSON.stringify(s)); } catch {} }')
js = js.replace('layout: window.matchMedia("(max-width: 600px)").matches ? "left" : "dual"', 'layout: "left"')
js = js.replace('localStorage.setItem(CFG.SETTINGS_KEY, JSON.stringify(out));', 'try { localStorage.setItem(CFG.SETTINGS_KEY, JSON.stringify(out)); } catch {}')
js = js.replace('      const data = new Uint8Array(await file.arrayBuffer());', '      await getPdfEngine();\n      const data = new Uint8Array(await file.arrayBuffer());')
js = js.replace('        useWorkerFetch: true', """        useWorkerFetch: true,
        cMapUrl: pdfAssetBase + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: pdfAssetBase + 'standard_fonts/',
        wasmUrl: pdfAssetBase + 'wasm/',
        iccUrl: pdfAssetBase + 'iccs/'""")
js = js.replace('      this.pdf = await this.loadingTask.promise;', '''      this.loadingTask.onPassword = (updatePassword, reason) => {
        const password = window.prompt(reason === 2 ? '密码不正确，请重新输入 PDF 密码：' : '此 PDF 已加密，请输入打开密码：');
        if (password === null) { this.loadingTask?.destroy(); return; }
        updatePassword(password);
      };
      this.pdf = await this.loadingTask.promise;''')
js = js.replace('const saved = restoreState || await dbGetView(this.docId, this.side);', 'const saved = restoreState || await dbGetView(this.docId, this.side).catch(() => null);')
# Commit the browser-local file only after PDF.js has accepted the PDF.
persist_start = js.index('      if (persistBlob) {')
persist_end = js.index('      await getPdfEngine();', persist_start)
persist_block = js[persist_start:persist_end]
persist_block = persist_block.replace('          await dbPutDoc({', '          const previous = await dbGetDoc(this.docId);\n          await dbPutDoc({\n            ...previous,')
persist_block = persist_block.replace('        } catch (err) {}', '        } catch (err) { toast("文件已打开，但浏览器未能保存副本。请检查可用存储空间。", true); }')
js = js[:persist_start] + js[persist_end:]
parse_marker = '      this.pdf = await this.loadingTask.promise;\n      if (generation !== this.generation) return;'
js = js.replace(parse_marker, parse_marker + '\n\n' + persist_block)
js = js.replace('        viewportRevision: 2,', '        anchor: this.getScrollAnchor(),\n        viewportRevision: 2,')
js = js.replace('      if (saved && !refitLegacy) {', '      if (saved?.anchor && !refitLegacy) {\n        this.restoreLocalAnchor(saved.anchor);\n      } else if (saved && !refitLegacy && this.zoomMode === "fit-width") {\n        this.goToPage(this.currentPage, false);\n      } else if (saved && !refitLegacy) {')
js = js.replace('      if (!silent) toast(`无法打开：${err?.message || err}`, true);', '      if (!silent) toast(`无法打开：${err?.message || err}`, true);\n      throw err;')
js = js.replace('    if(this.paneEl.hidden) return;', '    if(this.paneEl.hidden || document.body.dataset.view === "home") return;')
js = js.replace('    if (this.paneEl.hidden || !this.pdf', '    if (document.body.dataset.view === "home" || this.paneEl.hidden || !this.pdf')
js=js.replace('this.setScale(available / (ref.baseW + 12),', 'this.setScale(available / Math.max(1, this.baseSurfaceW || ref.baseW + 12),')
js=js.replace('    this.recomputeBaseGeometry();\n    this.restoreLocalAnchor(anchor);', '    this.recomputeBaseGeometry();\n    if(this.zoomMode === "fit-width")this.fitWidth({propagate:false,persist:false});\n    this.restoreLocalAnchor(anchor);')
resize_start=js.index('  onResize() {')
resize_end=js.index('  setStatus(text)',resize_start)
js=js[:resize_start]+'''  onResize() {
    if (this.paneEl.hidden || document.body.dataset.view === "home") return;
    const anchor=this.pdf ? this.getScrollAnchor() : null;
    cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf=requestAnimationFrame(()=>{
      this.resizeRaf=0; this.refreshViewportMetrics();
      if(!this.pdf)return;
      if(this.zoomMode === "fit-width")this.fitWidth({propagate:false,persist:false});
      else this.updateSurfaceGeometry(this.layoutScale);
      if(anchor)this.restoreLocalAnchor(anchor);
      this.updateCurrentPage();this.renderNearViewport({quality:"fast",includeText:!this.isScrolling});this.scheduleSharpRender();
    });
  }

'''+js[resize_end:]
js=js.replace('this.loadingTask.onPassword = (updatePassword, reason) =>', 'this.loadingTask.onPassword = async (updatePassword, reason) =>')
js=js.replace("window.prompt(reason === 2 ? '密码不正确，请重新输入 PDF 密码：' : '此 PDF 已加密，请输入打开密码：')", 'await requestPdfPassword(reason)')
js=js.replace('if(!confirm(`从历史中删除', 'if(!await confirmWorkspaceAction(`从历史中删除')
js = js.replace('refreshSessionHint(); restoreLastSession();', 'refreshSessionHint();\n' + (root / 'touch.js').read_text(encoding='utf-8') + '\n' + (root / 'controls.js').read_text(encoding='utf-8') + '\n' + (root / 'image-export-core.js').read_text(encoding='utf-8') + '\n' + (root / 'image-export.js').read_text(encoding='utf-8') + '\n' + (root / 'workspace.js').read_text(encoding='utf-8'))
(root / 'app.js').write_text(js, encoding='utf-8')
(root / 'reader.css').write_text(css, encoding='utf-8')
shell = (root / 'shell.html').read_text(encoding='utf-8')
shell = shell.replace('<!-- READER_TOOLBAR -->', toolbar).replace('<!-- READER_MAIN -->', main).replace('<!-- READER_OVERLAYS -->', overlays)
(root / 'index.html').write_text(shell, encoding='utf-8')

vendor = root / 'vendor' / 'pdfjs'
if not (vendor / 'build' / 'pdf.min.mjs').exists():
    data = urllib.request.urlopen('https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz').read()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            name = member.name.removeprefix('package/')
            if not member.isfile() or not (name in ('build/pdf.min.mjs','build/pdf.worker.min.mjs','web/pdf_viewer.css','LICENSE') or name.startswith(('cmaps/', 'standard_fonts/', 'wasm/', 'iccs/'))):
                continue
            target = (vendor / name).resolve()
            if not target.is_relative_to(vendor.resolve()):
                raise RuntimeError('Invalid vendor archive path')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
print('Workspace built; PDF.js 6.3.289 bundled locally.')

# Keep the deliverable usable as a single HTML file, like the original project.
# A local server uses bundled PDF.js; a copied HTML or file:// uses the CDN fallback.
viewer_css = (vendor / 'web' / 'pdf_viewer.css').read_text(encoding='utf-8')
workspace_css = (root / 'workspace.css').read_text(encoding='utf-8')
design_css = (root / 'design-system.css').read_text(encoding='utf-8')
font_data = base64.b64encode((root / 'fonts' / 'nunito-latin.woff2').read_bytes()).decode('ascii')
design_css = design_css.replace("url('fonts/nunito-latin.woff2')", "url('data:font/woff2;base64," + font_data + "')")
shell = shell.replace('<link rel="stylesheet" href="vendor/pdfjs/web/pdf_viewer.css">', '<style>\n' + viewer_css + '\n</style>')
shell = shell.replace('<link rel="stylesheet" href="reader.css">', '<style>\n' + css + '\n</style>')
shell = shell.replace('<link rel="stylesheet" href="workspace.css">', '<style>\n' + workspace_css + '\n</style>')
shell = shell.replace('<link rel="stylesheet" href="design-system.css">', '<style>\n' + design_css + '\n</style>')
shell = shell.replace('<script type="module" src="app.js"></script>', '<script type="module">\n' + js + '\n</script>')
(root / 'index.html').write_text(shell, encoding='utf-8')
