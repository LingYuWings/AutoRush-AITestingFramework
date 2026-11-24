"""Serve the standalone equipment-request demo and its JSON API on loopback."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


SITE = Path(__file__).resolve().parent / "site"
CATALOG = {
    "hub": {"name": "USB-C 扩展坞", "limit": 8},
    "keyboard": {"name": "无线键盘", "limit": 5},
    "headset": {"name": "会议耳机", "limit": 3},
}
ASSETS = {
    "/": ("index.html", "text/html"),
    "/style.css": ("style.css", "text/css"),
    "/app.js": ("app.js", "text/javascript"),
}


class DemoHandler(BaseHTTPRequestHandler):
    """Handle only the demo assets, catalog, and equipment requests."""

    def respond(self, status, body, media_type="application/json"):
        """Send a bounded response with explicit encoding and length."""
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{media_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        """Return a fixed asset or the sample catalog."""
        path = urlsplit(self.path).path
        if path == "/api/catalog":
            items = [{"id": key, **item} for key, item in CATALOG.items()]
            return self.respond(200, {"service": "autorush-equipment-demo", "items": items})
        if path in ASSETS:
            name, media_type = ASSETS[path]
            return self.respond(200, (SITE / name).read_bytes(), media_type)
        self.respond(404, {"message": "页面不存在"})

    def do_POST(self):
        """Validate one request and return a receipt for accepted quantities."""
        if urlsplit(self.path).path != "/api/requests":
            return self.respond(404, {"message": "接口不存在"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 4096:
                raise ValueError("invalid body length")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("expected an object")
        except (ValueError, RecursionError):
            return self.respond(400, {"message": "请发送有效的 JSON 请求"})

        item_id = request.get("item_id")
        item = CATALOG.get(item_id) if isinstance(item_id, str) else None
        if item is None:
            return self.respond(422, {"message": "请选择一种设备"})
        quantity = request.get("quantity")
        if type(quantity) is not int or not 1 <= quantity <= item["limit"]:
            limit = item["limit"]
            return self.respond(422, {"message": f"每次最多可领用 {limit} 件，请输入有效整数。", "limit": limit})
        self.respond(201, {"status": "approved", "item_id": item_id, "name": item["name"], "quantity": quantity})


def main():
    """Start the demo service with a configurable local port."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, choices=range(1, 65536), metavar="PORT", default=8766)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), DemoHandler) as server:
        print(f"Equipment demo: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
