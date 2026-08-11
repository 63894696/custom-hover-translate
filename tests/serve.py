# 极简 http 服务:托管 replace-p0 测试页 + 真实 content.js
# 用法: python serve.py   然后浏览器开 http://127.0.0.1:8123/
import http.server, os

ROOT = os.path.dirname(os.path.abspath(__file__))           # tests/
CONTENT_JS = os.path.join(ROOT, "..", "extension", "src", "content.js")

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._serve(os.path.join(ROOT, "replace-p0-page.html"), "text/html")
        if self.path == "/content.js":
            return self._serve(CONTENT_JS, "application/javascript")
        self.send_error(404, "not found")

    def _serve(self, fp, mime):
        try:
            with open(fp, "rb") as f:
                data = f.read()
        except Exception as e:
            self.send_error(404, str(e)); return
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    print("serving on http://127.0.0.1:8123/  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", 8123), H).serve_forever()
