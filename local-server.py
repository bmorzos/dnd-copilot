"""Zero-dependency local HTTP server, D&D Beyond JSON proxy, and Google Drive Campaign Memory API."""

from functools import partial
import html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import gdrive_sync

ROOT_DIR = Path(__file__).resolve().parent
DDB_PROXY_RE = re.compile(r"^/api/ddb-character/(\d{4,12})(?:\?.*)?$")
TRANSCRIPT_HIGHLIGHTS_RE = re.compile(r"^/api/campaign-memory/transcript/([a-zA-Z0-9_-]+)/highlights$")
TRANSCRIPT_GET_RE = re.compile(r"^/api/campaign-memory/transcript/([a-zA-Z0-9_-]+)$")
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
AI_PROXY_TARGETS = {
    "/api/proxy/gemini-interactions": "https://generativelanguage.googleapis.com/v1beta/interactions",
    "/api/proxy/groq-chat": "https://api.groq.com/openai/v1/chat/completions",
    "/api/proxy/groq-whisper": "https://api.groq.com/openai/v1/audio/transcriptions",
}


class CopilotRequestHandler(SimpleHTTPRequestHandler):
    """Serves static dashboard files and provides local DDB & Google Drive campaign archive APIs."""

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
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        match = DDB_PROXY_RE.match(self.path)
        if match:
            return self._handle_ddb_proxy(match.group(1))

        if path == "/api/gdrive/status":
            return self._send_json_obj(200, gdrive_sync.get_status())

        if path == "/api/gdrive/auth-url":
            host = self.headers.get("Host") or "127.0.0.1:8765"
            default_redir = f"http://{host}/api/gdrive/oauth-callback"
            redirect_uri = (qs.get("redirect_uri") or [default_redir])[0]
            try:
                auth_url = gdrive_sync.start_oauth_flow(redirect_uri)
                return self._send_json_obj(200, {"authUrl": auth_url})
            except Exception as exc:
                return self._send_json_obj(400, {"error": str(exc)})

        if path == "/api/gdrive/oauth-callback":
            return self._handle_oauth_callback(qs)

        if path == "/api/campaign-memory/overview":
            return self._send_json_obj(200, gdrive_sync.get_overview())

        if path == "/api/campaign-memory/mysteries":
            return self._send_json_obj(200, gdrive_sync.extract_campaign_mysteries())

        if path == "/api/campaign-memory/transcripts":
            return self._send_json_obj(200, {"transcripts": gdrive_sync.list_cached_transcripts()})

        if path == "/api/campaign-memory/latest-transcript":
            tr = gdrive_sync.get_cached_transcript("latest")
            return self._send_json_obj(200 if tr else 404, tr or {"error": "No cached transcripts yet."})

        hi_match = TRANSCRIPT_HIGHLIGHTS_RE.match(path)
        if hi_match:
            hi = gdrive_sync.get_transcript_highlights(hi_match.group(1))
            return self._send_json_obj(200 if hi else 404, hi or {"error": "Transcript not found."})

        tr_match = TRANSCRIPT_GET_RE.match(path)
        if tr_match:
            tr = gdrive_sync.get_cached_transcript(tr_match.group(1))
            return self._send_json_obj(200 if tr else 404, tr or {"error": "Transcript not found."})

        if path == "/api/campaign-memory/export-bundle":
            bundle = gdrive_sync.export_archive_bundle()
            payload = json.dumps(bundle, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header(
                "Content-Disposition", 'attachment; filename="bugs-drive-archive.json"'
            )
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in AI_PROXY_TARGETS:
            return self._handle_ai_proxy(AI_PROXY_TARGETS[path])

        body = self._read_json_body()
        if body is None:
            return self._send_json_obj(400, {"error": "Invalid JSON request body."})

        try:
            if path == "/api/gdrive/oauth-client":
                raw = body.get("rawJson")
                if raw:
                    gdrive_sync.save_oauth_client(raw)
                elif body.get("installed") or body.get("web") or body.get("client_id"):
                    gdrive_sync.save_oauth_client(body)
                if any(k in body for k in ("folderId", "summariesDocId", "backstoriesDocId")):
                    gdrive_sync.save_drive_config(
                        body.get("folderId"),
                        body.get("summariesDocId"),
                        body.get("backstoriesDocId"),
                    )
                return self._send_json_obj(200, {"ok": True, "status": gdrive_sync.get_status()})

            if path == "/api/gdrive/disconnect":
                gdrive_sync.disconnect_oauth()
                return self._send_json_obj(200, {"ok": True, "status": gdrive_sync.get_status()})

            if path == "/api/gdrive/sync":
                folder_id = str(body.get("folderId") or "").strip()
                summaries_id = str(body.get("summariesDocId") or "").strip()
                backstories_id = str(body.get("backstoriesDocId") or "").strip()
                st = gdrive_sync.get_status()
                if st.get("connected"):
                    res = gdrive_sync.sync_from_drive_api(folder_id, summaries_id, backstories_id)
                elif st.get("cliAvailable"):
                    res = gdrive_sync.sync_from_gdrive_cli(folder_id, summaries_id, backstories_id)
                else:
                    return self._send_json_obj(
                        400,
                        {"error": "Google Drive is not connected yet. Click Connect Google Drive first."},
                    )
                return self._send_json_obj(200, {"ok": True, "status": res})

            if path == "/api/campaign-memory/search":
                parts = []
                if body.get("query"):
                    parts.append(str(body.get("query")))
                if body.get("customQuestion"):
                    parts.append(str(body.get("customQuestion")))
                recent_lines = body.get("recentLines")
                if isinstance(recent_lines, list):
                    parts.extend(str(x) for x in recent_lines if x)
                query_text = "\n".join(parts).strip()
                res = gdrive_sync.search_campaign_archive(
                    query_text,
                    max_summaries=int(body.get("maxSummaries") or 4),
                    max_snippets=int(body.get("maxSnippets") or 8),
                )
                return self._send_json_obj(200, res)

            if path == "/api/campaign-memory/import-bundle":
                res = gdrive_sync.import_archive_bundle(body)
                return self._send_json_obj(200, {"ok": True, "status": res})

            return self._send_json_obj(404, {"error": f"Unknown API endpoint: {path}"})
        except Exception as exc:
            return self._send_json_obj(500, {"error": str(exc)})

    def _handle_ai_proxy(self, target_url: str):
        try:
            length = int(self.headers.get("Content-Length") or "0")
            if length < 0 or length > 30 * 1024 * 1024:
                return self._send_json_obj(413, {"error": "Request body too large for AI proxy."})
            raw_body = self.rfile.read(length) if length > 0 else b""
            fwd_headers = {
                "User-Agent": BROWSER_UA,
                "Accept": "application/json",
            }
            for h_name in ("Content-Type", "Authorization", "x-goog-api-key", "Api-Revision"):
                val = self.headers.get(h_name)
                if val:
                    fwd_headers[h_name] = val
            req = urllib.request.Request(
                target_url,
                data=raw_body,
                method="POST",
                headers=fwd_headers,
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp_bytes = resp.read()
                self._send_json(resp.status, resp_bytes)
        except urllib.error.HTTPError as err:
            err_bytes = err.read() or json.dumps({"error": {"message": f"Upstream HTTP {err.code}"}}).encode("utf-8")
            self._send_json(err.code, err_bytes)
        except Exception as exc:
            self._send_json_obj(502, {"error": {"message": f"AI proxy error: {exc}"}})

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
            if length == 0:
                return {}
            if length > 80 * 1024 * 1024:
                return None
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
        except Exception:
            return None

    def _handle_ddb_proxy(self, char_id: str):
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
            self._send_json_obj(502, {"error": str(exc)})

    def _handle_oauth_callback(self, qs: dict):
        err_param = (qs.get("error") or [""])[0]
        code = (qs.get("code") or [""])[0]
        state = (qs.get("state") or [""])[0]
        if err_param:
            return self._send_oauth_html(False, f"Google OAuth returned error: {err_param}")
        try:
            gdrive_sync.complete_oauth_callback(code, state)
            return self._send_oauth_html(True, "Google Drive connected! You can return to D&D Copilot.")
        except Exception as exc:
            return self._send_oauth_html(False, f"Google Drive connection failed: {exc}")

    def _send_oauth_html(self, ok: bool, message: str):
        safe_msg = html.escape(message)
        status_title = "Google Drive Connected" if ok else "Connection Failed"
        post_script = (
            "<script>"
            "if (window.opener) {"
            "  try { window.opener.postMessage({ source: 'dnd-copilot-gdrive', type: 'GDRIVE_CONNECTED' }, '*'); } catch (_) {}"
            "}"
            "setTimeout(function () { window.close(); }, 1200);"
            "</script>"
            if ok
            else ""
        )
        page = (
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>"
            f"{status_title}</title>"
            "<style>body{background:#0f131d;color:#f3f6fc;font-family:sans-serif;display:flex;"
            "align-items:center;justify-content:center;height:100vh;margin:0;}"
            ".card{background:#171d2b;border:1px solid #2c3752;border-radius:12px;padding:24px 30px;"
            "max-width:440px;text-align:center;}h2{color:#f0c46c;margin-top:0;}</style></head>"
            f"<body><div class='card'><h2>{status_title}</h2><p>{safe_msg}</p></div>{post_script}</body></html>"
        ).encode("utf-8")
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def _send_json_obj(self, status_code: int, obj):
        payload = json.dumps(obj).encode("utf-8")
        self._send_json(status_code, payload)

    def _send_json(self, status_code: int, payload: bytes):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def _start_drive_auto_sync_thread():
    """Starts a daemon thread that incrementally checks Drive every 10 minutes for new episodes."""
    def _loop():
        time.sleep(15)
        while True:
            try:
                gdrive_sync.auto_sync_if_due(min_age_seconds=600)
            except Exception:
                pass
            time.sleep(600)

    t = threading.Thread(target=_loop, name="GDriveAutoSync", daemon=True)
    t.start()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    _start_drive_auto_sync_thread()
    handler = partial(CopilotRequestHandler, directory=str(ROOT_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"Serving D&D Table Copilot + DDB proxy on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
