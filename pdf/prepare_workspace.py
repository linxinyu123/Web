"""Build the standalone reader from maintained source files."""
from pathlib import Path
import base64
root = Path(__file__).parent
read = lambda name: (root / name).read_text(encoding='utf-8')
js = '\n'.join(read(name) for name in ('reader-core.js', 'reader-zoom.js', 'reader-search-layout.js', 'touch.js', 'controls.js', 'image-export-core.js', 'image-export.js', 'workspace.js', 'page-navigator.js'))
js += "\nif(new URLSearchParams(location.search).get('perf')==='1')import('./tests/perf-probe.js').then(m=>m.installPdfPerfProbe({panes,renderQueue}));\n"
(root / 'app.js').write_text(js, encoding='utf-8')
shell = read('shell.html')
for part in ('toolbar', 'main', 'search', 'overlays'):
    shell = shell.replace('<!-- READER_' + part.upper() + ' -->', read('reader-' + part + '.html'))
for name in ('vendor/pdfjs/web/pdf_viewer.css', 'reader.css', 'workspace.css', 'design-system.css'):
    css = read(name)
    if name == 'design-system.css':
        data = base64.b64encode((root / 'fonts/nunito-latin.woff2').read_bytes()).decode('ascii')
        css = css.replace("url('fonts/nunito-latin.woff2')", "url('data:font/woff2;base64," + data + "')")
    shell = shell.replace('<link rel="stylesheet" href="' + name + '">', '<style>\n' + css + '\n</style>')
shell = shell.replace('<script type="module" src="app.js"></script>', '<script type="module">\n' + js + '\n</script>')
(root / 'index.html').write_text(shell, encoding='utf-8')
print('Built standalone index.html and app.js.')
