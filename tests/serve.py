# 极简 http 服务:托管 replace-p0 测试页 + 真实 content.js + 字幕/图片 E2E 页
# 用法: python serve.py [port]   默认 8123;E2E 用 8765(避开常见占用)
import http.server, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))           # tests/
CONTENT_JS = os.path.join(ROOT, "..", "extension", "src", "content.js")

ROUTES = {
    "/":                          ("replace-p0-page.html",       "text/html"),
    "/index.html":                ("replace-p0-page.html",       "text/html"),
    "/attr-p1a-page.html":        ("attr-p1a-page.html",         "text/html"),
    "/script-misattack-page.html":("script-misattack-page.html", "text/html"),
    "/texttrack.html":            ("texttrack.html",             "text/html"),
    "/image.html":                ("image.html",                 "text/html"),
    "/subs.vtt":                  ("subs.vtt",                   "text/vtt"),
    "/sample.mp4":                ("sample.mp4",                 "video/mp4"),
    "/video.mp4":                 ("sample.mp4",                 "video/mp4"),
}

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/content.js":
            return self._serve(CONTENT_JS, "application/javascript")
        hit = ROUTES.get(self.path)
        if hit:
            return self._serve(os.path.join(ROOT, hit[0]), hit[1])
        self.send_error(404, "not found")

    def _serve(self, fp, mime):
        try:
            with open(fp, "rb") as f:
                data = f.read()
        except Exception as e:
            self.send_error(404, str(e)); return
        rng = self.headers.get("Range")
        if rng:
            try:
                unit, _, span = rng.partition("=")
                start_s, _, end_s = span.partition("-")
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else len(data) - 1
                end = min(end, len(data) - 1)
                chunk = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return
            except Exception:
                pass
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"serving on http://127.0.0.1:{port}/  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
