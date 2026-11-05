"""Start the local, offline-capable PDF workspace. No third-party dependencies."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
import argparse
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import unquote, urlsplit
        parts = Path(unquote(urlsplit(self.path).path)).parts
        if any(part.startswith('.') for part in parts if part not in ('/', '\\')):
            self.send_error(404); return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def main():
    parser = argparse.ArgumentParser(description='对读 PDF 工作空间')
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--no-open', action='store_true')
    options = parser.parse_args()
    url = f'http://127.0.0.1:{options.port}/'
    try:
        server = ThreadingHTTPServer(('127.0.0.1', options.port), partial(Handler, directory=str(ROOT)))
    except OSError as error:
        try:
            with urlopen(url, timeout=2) as response:
                existing = response.read()
            if '对读 · PDF 工作空间'.encode() not in existing:
                raise error
            print(f'Workspace is already running: {url}')
            if not options.no_open: webbrowser.open(url)
            return
        except Exception:
            raise SystemExit(f'Port {options.port} is in use. Try: python serve.py --port 4174') from None
    print(f'PDF Workspace: {url}\nPress Ctrl+C to stop. Files stay in this browser.')
    if not options.no_open:
        threading.Timer(.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__': main()
