"""Zero-dependency local HTTP server + D&D Beyond character JSON proxy for D&D Table Copilot."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent
DDB_PROXY_RE = re.compile(r"^/api/ddb-character/(\d{4,12})(?:\?.*)?$")


class CopilotRequestHandler(SimpleHTTPRequestHandler):
    """Serves static dashboard files with fresh headers and proxies DDB character v5 JSON."""

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif any(
            self.path.split("?", 1)[0].endswith(ext)
            for ext in (".html", ".js", ".css", "/")
        ) or self.path == "/":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        match = DDB_PROXY_RE.match(self.path)
        if not match:
            return super().do_GET()

        char_id = match.group(1)
        target_url = (
            f"https://character-service.dndbeyond.com/character/v5/character/{char_id}"
            f"?includeCustomItems=true&_t={int(time.time() * 1000)}"
        )
        req = urllib.request.Request(
            target_url,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; DnDTableCopilot/1.0)",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                body = resp.read()
                self._send_json(resp.status, body)
        except urllib.error.HTTPError as err:
            body = err.read() or b'{"error":"Upstream D&D Beyond error"}'
            self._send_json(err.code, body)
        except Exception as exc:
            err_payload = f'{{"error":{repr(str(exc))}}}'.replace("'", '"').encode("utf-8")
            self._send_json(502, err_payload)

    def _send_json(self, status_code: int, payload: bytes):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = partial(CopilotRequestHandler, directory=str(ROOT_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"Serving D&D Table Copilot + DDB proxy on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
