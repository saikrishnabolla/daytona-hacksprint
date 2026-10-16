"""Intentionally vulnerable, synthetic search target for the owned hackathon demo."""
import html
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "demo-vulnerable-1"
ARTICLES = [
    ("Getting started", "Create your workspace and invite your team."),
    ("Managing projects", "Keep your projects, tasks, and notes in one place."),
    ("Account security", "Protect your account with two-factor authentication."),
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json({"ok": True, "version": VERSION})
            return
        if parsed.path not in ("/", "/search"):
            self.send_error(404)
            return
        query = parse_qs(parsed.query, keep_blank_values=True).get("q", [""])[0][:2048]
        query_html = query
        matches = [item for item in ARTICLES if query.lower() in " ".join(item).lower()]
        results = "".join(f'<article><h3>{html.escape(title)}</h3><p>{html.escape(body)}</p></article>' for title, body in matches)
        if not results:
            results = '<p class="empty">No articles match this search.</p>'
        body = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Help Center</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f8fafc;color:#152238;font:15px system-ui,sans-serif}}header{{border-bottom:1px solid #e2e8f0;background:white;padding:20px 6%;display:flex;justify-content:space-between}}header strong{{letter-spacing:-.5px}}header span{{font-size:12px;color:#64748b}}main{{max-width:760px;margin:64px auto;padding:0 24px}}.eyebrow{{font-size:12px;color:#64748b}}h1{{font-size:32px;letter-spacing:-1px;margin:12px 0}}.intro{{color:#64748b}}form{{display:flex;gap:10px;margin:28px 0}}input{{flex:1;min-width:0;padding:12px 14px;border:1px solid #cbd5e1;border-radius:5px;font:inherit}}button{{padding:12px 20px;border:0;border-radius:5px;background:#2563eb;color:white;font:inherit;cursor:pointer}}h2{{font-size:17px;margin-top:32px}}article{{padding:16px 0;border-bottom:1px solid #e2e8f0}}h3{{font-size:15px;margin:0 0 8px}}article p,.empty{{font-size:14px;color:#64748b}}footer{{margin-top:48px;color:#94a3b8;font-size:11px}}
</style></head><body><header><strong>acme / help center</strong><span>Hackathon demo · synthetic data</span></header><main><span class="eyebrow">KNOWLEDGE BASE</span><h1>How can we help?</h1><p class="intro">Find guides for your workspace, projects, and account.</p><form action="/search" method="get"><input aria-label="Search articles" name="q" value="{html.escape(query, quote=True)}" placeholder="Search articles…"><button type="submit">Search</button></form><h2>Results for {query_html}</h2><section>{results}</section><footer>Intentionally vulnerable training app · {VERSION}</footer></main></body></html>'''
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Demo-Version", VERSION)
        self.end_headers()
        self.wfile.write(encoded)

    def send_json(self, value):
        encoded = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    print(f"Acme help center {VERSION} listening on :3000", flush=True)
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "3000"))), Handler).serve_forever()
