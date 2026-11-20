"""Zero-dependency Google Drive campaign archive sync, OAuth 2.0 loopback auth, and full-text search."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent
CACHE_DIR = ROOT_DIR / ".gdrive-cache"
TRANSCRIPTS_DIR = CACHE_DIR / "transcripts"
INDEX_FILE = CACHE_DIR / "index.json"
SUMMARIES_MD_FILE = CACHE_DIR / "summaries.md"
BACKSTORIES_TXT_FILE = CACHE_DIR / "backstories.txt"
TOKEN_FILE = ROOT_DIR / ".gdrive-token.json"
OAUTH_CLIENT_FILE = ROOT_DIR / ".gdrive-oauth.json"
CONFIG_FILE = ROOT_DIR / ".gdrive-config.json"

DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

_OAUTH_LOCK = threading.Lock()
_PENDING_OAUTH: dict[str, dict] = {}
_SYNC_LOCK = threading.Lock()
_AUTO_SYNC_STATE = {
    "enabled": True,
    "intervalMinutes": 10,
    "lastCheckAt": None,
    "lastNewCount": 0,
    "lastError": "",
}

_SESSION_NUM_RE = re.compile(r"\b(?:BUGS|Session)\s+(\d+)\b", re.IGNORECASE)
_STOPWORDS = {
    "about", "after", "again", "against", "around", "because", "before", "being",
    "between", "could", "should", "would", "there", "these", "those", "their",
    "where", "which", "while", "going", "table", "check", "damage", "attack",
    "spell", "magic", "level", "rolled", "initiative", "saving", "throw",
    "action", "bonus", "recording", "speaker", "other", "right", "think",
    "maybe", "something", "someone", "anyone", "everyone", "really", "actually",
    "pretty", "still", "first", "second", "third", "asking", "asked", "looks"
}
_SKIP_EXTS = (
    ".m4a", ".mp3", ".mp4", ".wav", ".webm", ".ogg", ".flac", ".mov",
    ".avi", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"
)


def extract_drive_id(raw: str) -> str:
    """Extracts a Google Drive folder or file ID from a URL or raw ID string."""
    clean = str(raw or "").strip()
    if not clean:
        return ""
    for pat in (
        r"/folders/([a-zA-Z0-9_-]{10,})",
        r"/d/([a-zA-Z0-9_-]{10,})",
        r"[?&]id=([a-zA-Z0-9_-]{10,})"
    ):
        m = re.search(pat, clean)
        if m:
            return m.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", clean):
        return clean
    return ""


def _read_json(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _find_skill_config_paths() -> list[Path]:
    home = Path.home()
    return [
        home / ".gemini" / "config" / "skills" / "dnd-recap" / "config",
        home / ".claude" / "skills" / "dnd-recap" / "config",
    ]


def detect_local_defaults() -> dict:
    """Detects default Drive folder/doc IDs at runtime from local skill config if present."""
    defaults = {"folderId": "", "summariesDocId": "", "backstoriesDocId": ""}
    for cfg_dir in _find_skill_config_paths():
        cfg_file = cfg_dir / "config.json"
        if cfg_file.exists():
            data = _read_json(cfg_file, {})
            drv = data.get("drive") if isinstance(data, dict) else None
            if isinstance(drv, dict):
                fid = extract_drive_id(drv.get("transcripts_folder_id", ""))
                sid = extract_drive_id(drv.get("master_doc_id", ""))
                bid = extract_drive_id(drv.get("backstories_doc_id", ""))
                if fid and not defaults["folderId"]:
                    defaults["folderId"] = fid
                if sid and not defaults["summariesDocId"]:
                    defaults["summariesDocId"] = sid
                if bid and not defaults["backstoriesDocId"]:
                    defaults["backstoriesDocId"] = bid
                break
    return defaults


def load_drive_config() -> dict:
    """Loads saved Drive folder/doc configuration merged with runtime defaults."""
    saved = _read_json(CONFIG_FILE, {})
    idx = _read_json(INDEX_FILE, {})
    defaults = detect_local_defaults()
    return {
        "folderId": (
            extract_drive_id(saved.get("folderId", ""))
            or extract_drive_id(idx.get("folderId", ""))
            or defaults["folderId"]
        ),
        "summariesDocId": (
            extract_drive_id(saved.get("summariesDocId", ""))
            or extract_drive_id(idx.get("summariesDocId", ""))
            or defaults["summariesDocId"]
        ),
        "backstoriesDocId": (
            extract_drive_id(saved.get("backstoriesDocId", ""))
            or extract_drive_id(idx.get("backstoriesDocId", ""))
            or defaults["backstoriesDocId"]
        ),
    }


def save_drive_config(folder_id: str = "", summaries_doc_id: str = "", backstories_doc_id: str = "") -> dict:
    """Persists sanitized Drive folder and doc IDs into .gdrive-config.json."""
    cur = load_drive_config()
    if folder_id is not None and str(folder_id).strip():
        cur["folderId"] = extract_drive_id(folder_id) or cur["folderId"]
    if summaries_doc_id is not None and str(summaries_doc_id).strip():
        cur["summariesDocId"] = extract_drive_id(summaries_doc_id) or cur["summariesDocId"]
    if backstories_doc_id is not None and str(backstories_doc_id).strip():
        cur["backstoriesDocId"] = extract_drive_id(backstories_doc_id) or cur["backstoriesDocId"]
    _write_json(CONFIG_FILE, cur)
    return cur


def _normalize_oauth_dict(data: dict) -> dict | None:
    if not isinstance(data, dict):
        return None
    inner = data.get("installed") or data.get("web") or data
    if not isinstance(inner, dict):
        return None
    cid = str(inner.get("client_id") or "").strip()
    csec = str(inner.get("client_secret") or "").strip()
    if not cid:
        return None
    return {
        "client_id": cid,
        "client_secret": csec,
        "auth_uri": str(inner.get("auth_uri") or GOOGLE_AUTH_URL),
        "token_uri": str(inner.get("token_uri") or GOOGLE_TOKEN_URL),
    }


def load_oauth_client() -> dict | None:
    """Loads OAuth Desktop client config from .gdrive-oauth.json or local runtime skill credentials."""
    local_raw = _read_json(OAUTH_CLIENT_FILE, None)
    parsed = _normalize_oauth_dict(local_raw)
    if parsed:
        return parsed

    for cfg_dir in _find_skill_config_paths():
        cred_file = cfg_dir / "google_oauth" / "credentials.json"
        if cred_file.exists():
            parsed = _normalize_oauth_dict(_read_json(cred_file, None))
            if parsed:
                return parsed
    return None


def save_oauth_client(payload) -> dict:
    """Validates and saves a user-provided Google OAuth credentials JSON into .gdrive-oauth.json."""
    if isinstance(payload, str):
        data = json.loads(payload)
    else:
        data = payload
    norm = _normalize_oauth_dict(data)
    if not norm:
        raise ValueError("Invalid Google OAuth JSON (expected Desktop app credentials with client_id).")
    _write_json(OAUTH_CLIENT_FILE, data if isinstance(data, dict) else norm)
    return norm


def start_oauth_flow(redirect_uri: str) -> str:
    """Starts a PKCE + state OAuth 2.0 flow and returns the Google authorization URL."""
    client = load_oauth_client()
    if not client:
        raise RuntimeError(
            "No Google OAuth client configured. Paste your Desktop OAuth JSON in Drive settings first."
        )

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    now = time.time()
    with _OAUTH_LOCK:
        stale = [k for k, v in _PENDING_OAUTH.items() if now - v.get("created_at", 0) > 900]
        for k in stale:
            _PENDING_OAUTH.pop(k, None)
        _PENDING_OAUTH[state] = {
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
            "created_at": now,
        }

    params = urllib.parse.urlencode({
        "client_id": client["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": DRIVE_READONLY_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    })
    return f"{client['auth_uri']}?{params}"


def _exchange_token(token_uri: str, form_fields: dict) -> dict:
    encoded = urllib.parse.urlencode(form_fields).encode("utf-8")
    req = urllib.request.Request(
        token_uri,
        data=encoded,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OAuth token exchange HTTP {err.code}: {detail[:240]}") from err


def complete_oauth_callback(code: str, state: str) -> dict:
    """Completes the OAuth loopback callback, stores tokens locally, and returns status summary."""
    with _OAUTH_LOCK:
        pending = _PENDING_OAUTH.pop(str(state or ""), None)
    if not pending:
        raise RuntimeError("Invalid or expired OAuth state parameter. Please click Connect Google Drive again.")

    client = load_oauth_client()
    if not client:
        raise RuntimeError("Missing OAuth client configuration.")

    token_data = _exchange_token(
        client["token_uri"],
        {
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "code": str(code or ""),
            "code_verifier": pending["code_verifier"],
            "redirect_uri": pending["redirect_uri"],
            "grant_type": "authorization_code",
        },
    )

    expires_in = int(token_data.get("expires_in", 3600))
    stored = {
        "access_token": token_data["access_token"],
        "refresh_token": token_data.get("refresh_token", ""),
        "expires_at": int(time.time()) + expires_in,
        "token_uri": client["token_uri"],
        "scope": token_data.get("scope", DRIVE_READONLY_SCOPE),
        "updated_at": int(time.time()),
    }
    _write_json(TOKEN_FILE, stored)
    return {"connected": True, "expiresAt": stored["expires_at"]}


def get_valid_access_token() -> str:
    """Returns a valid OAuth access token, refreshing automatically when needed."""
    tok = _read_json(TOKEN_FILE, None)
    if not isinstance(tok, dict) or not tok.get("access_token"):
        raise RuntimeError("Google Drive is not connected yet.")

    if int(tok.get("expires_at", 0)) - 60 > time.time():
        return str(tok["access_token"])

    refresh = str(tok.get("refresh_token") or "").strip()
    if not refresh:
        raise RuntimeError("Google Drive session expired — please click Connect Google Drive again.")

    client = load_oauth_client()
    if not client:
        raise RuntimeError("Missing OAuth client configuration.")

    refreshed = _exchange_token(
        client["token_uri"],
        {
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        },
    )
    tok["access_token"] = refreshed["access_token"]
    if refreshed.get("refresh_token"):
        tok["refresh_token"] = refreshed["refresh_token"]
    tok["expires_at"] = int(time.time()) + int(refreshed.get("expires_in", 3600))
    tok["updated_at"] = int(time.time())
    _write_json(TOKEN_FILE, tok)
    return str(tok["access_token"])


def disconnect_oauth() -> dict:
    """Removes the local Google Drive OAuth token while keeping cached campaign files."""
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
    return {"connected": False}


def _drive_api_get_bytes(url: str, access_token: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read()


def _drive_api_get_json(url: str, access_token: str) -> dict:
    raw = _drive_api_get_bytes(url, access_token)
    return json.loads(raw.decode("utf-8"))


def _is_syncable_transcript_item(item: dict) -> bool:
    name = str(item.get("name") or "").strip()
    low_name = name.lower()
    mime = str(item.get("mimeType") or "").lower()
    if not name or mime == "application/vnd.google-apps.folder":
        return False
    if mime.startswith(("audio/", "video/", "image/")):
        return False
    if any(low_name.endswith(ext) for ext in _SKIP_EXTS):
        return False
    if mime == "application/vnd.google-apps.document":
        return True
    if mime in ("text/plain", "text/markdown", "text/csv", "application/json"):
        return True
    if any(low_name.endswith(ext) for ext in (".txt", ".md", ".markdown", ".log")):
        return True
    return False


def _extract_session_number(name: str) -> int | None:
    m = _SESSION_NUM_RE.search(str(name or ""))
    return int(m.group(1)) if m else None


def _clean_text_blob(raw_bytes: bytes) -> str:
    text = raw_bytes.decode("utf-8", errors="replace").lstrip("\ufeff")
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def sync_from_drive_api(
    folder_id: str = "",
    summaries_doc_id: str = "",
    backstories_doc_id: str = "",
) -> dict:
    """Incrementally syncs transcripts, master summaries, and backstories using OAuth Drive v3 REST API."""
    with _SYNC_LOCK:
        return _sync_from_drive_api_locked(folder_id, summaries_doc_id, backstories_doc_id)


def _sync_from_drive_api_locked(
    folder_id: str = "",
    summaries_doc_id: str = "",
    backstories_doc_id: str = "",
) -> dict:
    cfg = save_drive_config(folder_id, summaries_doc_id, backstories_doc_id)
    fid = cfg["folderId"]
    sid = cfg["summariesDocId"]
    bid = cfg["backstoriesDocId"]
    if not fid:
        raise RuntimeError("Provide a Google Drive Transcripts Folder ID or URL first.")

    token = get_valid_access_token()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

    index = _read_json(INDEX_FILE, {})
    prev_files = index.get("files") if isinstance(index.get("files"), dict) else {}

    all_items = []
    page_token = ""
    while True:
        q = f"'{fid}' in parents and trashed = false"
        params = {
            "q": q,
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
            "pageSize": "1000",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        url = f"https://www.googleapis.com/drive/v3/files?{urllib.parse.urlencode(params)}"
        data = _drive_api_get_json(url, token)
        all_items.extend(data.get("files") or [])
        page_token = str(data.get("nextPageToken") or "")
        if not page_token:
            break

    syncable = [it for it in all_items if _is_syncable_transcript_item(it)]
    to_download = []
    new_files_map = {}

    for it in syncable:
        item_id = str(it["id"])
        mod = str(it.get("modifiedTime") or "")
        cached_path = TRANSCRIPTS_DIR / f"{item_id}.txt"
        old = prev_files.get(item_id)
        if old and old.get("modifiedTime") == mod and cached_path.exists():
            new_files_map[item_id] = old
        else:
            to_download.append(it)

    downloaded_count = 0

    def _fetch_one(it: dict) -> tuple[dict, str]:
        item_id = str(it["id"])
        mime = str(it.get("mimeType") or "")
        if mime == "application/vnd.google-apps.document":
            url = (
                f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(item_id)}/export"
                f"?mimeType=text%2Fplain"
            )
        else:
            url = (
                f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(item_id)}"
                f"?alt=media&supportsAllDrives=true"
            )
        content = _clean_text_blob(_drive_api_get_bytes(url, token))
        return it, content

    if to_download:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for it, content in pool.map(_fetch_one, to_download):
                item_id = str(it["id"])
                (TRANSCRIPTS_DIR / f"{item_id}.txt").write_text(content, encoding="utf-8")
                downloaded_count += 1
                new_files_map[item_id] = {
                    "id": item_id,
                    "name": it.get("name", item_id),
                    "mimeType": it.get("mimeType", "text/plain"),
                    "modifiedTime": it.get("modifiedTime", ""),
                    "charCount": len(content),
                    "sessionNumber": _extract_session_number(it.get("name", "")),
                }

    if sid:
        meta = _drive_api_get_json(
            f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(sid)}?fields=id,mimeType,modifiedTime&supportsAllDrives=true",
            token,
        )
        mime = str(meta.get("mimeType") or "")
        if mime == "application/vnd.google-apps.document":
            md_url = (
                f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(sid)}/export"
                f"?mimeType=text%2Fmarkdown"
            )
        else:
            md_url = f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(sid)}?alt=media"
        SUMMARIES_MD_FILE.write_text(_clean_text_blob(_drive_api_get_bytes(md_url, token)), encoding="utf-8")

    if bid:
        meta = _drive_api_get_json(
            f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(bid)}?fields=id,mimeType,modifiedTime&supportsAllDrives=true",
            token,
        )
        mime = str(meta.get("mimeType") or "")
        if mime == "application/vnd.google-apps.document":
            bs_url = (
                f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(bid)}/export"
                f"?mimeType=text%2Fplain"
            )
        else:
            bs_url = f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(bid)}?alt=media"
        BACKSTORIES_TXT_FILE.write_text(_clean_text_blob(_drive_api_get_bytes(bs_url, token)), encoding="utf-8")

    updated_index = {
        "folderId": fid,
        "summariesDocId": sid,
        "backstoriesDocId": bid,
        "lastSyncedAt": int(time.time() * 1000),
        "lastSyncSource": "oauth",
        "downloadedCount": downloaded_count,
        "files": new_files_map,
    }
    _write_json(INDEX_FILE, updated_index)
    return get_status()


def _find_gdrive_cli() -> str | None:
    exe = shutil.which("gdrive")
    if exe:
        return exe
    fallback = Path.home() / ".gemini" / "config" / "plugins" / "gdrive" / "skills" / "gdrive" / "scripts" / (
        "gdrive.cmd" if sys.platform.startswith("win") else "gdrive"
    )
    return str(fallback) if fallback.exists() else None


def _run_gdrive_cmd(cmd: list[str]) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or f"gdrive exit {res.returncode}").strip()[:240])
    return res.stdout


def sync_from_gdrive_cli(
    folder_id: str = "",
    summaries_doc_id: str = "",
    backstories_doc_id: str = "",
) -> dict:
    """Incrementally syncs transcripts, summaries, and backstories using the installed gdrive plugin CLI."""
    with _SYNC_LOCK:
        return _sync_from_gdrive_cli_locked(folder_id, summaries_doc_id, backstories_doc_id)


def _sync_from_gdrive_cli_locked(
    folder_id: str = "",
    summaries_doc_id: str = "",
    backstories_doc_id: str = "",
) -> dict:
    cli = _find_gdrive_cli()
    if not cli:
        raise RuntimeError("gdrive CLI is not installed on PATH.")

    cfg = save_drive_config(folder_id, summaries_doc_id, backstories_doc_id)
    fid = cfg["folderId"]
    sid = cfg["summariesDocId"]
    bid = cfg["backstoriesDocId"]
    if not fid:
        raise RuntimeError("Provide a Google Drive Transcripts Folder ID or URL first.")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

    raw_list = _run_gdrive_cmd([cli, "readonly", "ls", fid, "--max", "0", "--json"])
    items = json.loads(raw_list or "[]")
    syncable = [it for it in items if _is_syncable_transcript_item(it)]

    index = _read_json(INDEX_FILE, {})
    prev_files = index.get("files") if isinstance(index.get("files"), dict) else {}

    to_download = []
    new_files_map = {}
    for it in syncable:
        item_id = str(it["id"])
        mod = str(it.get("modifiedTime") or "")
        cached_path = TRANSCRIPTS_DIR / f"{item_id}.txt"
        old = prev_files.get(item_id)
        if old and old.get("modifiedTime") == mod and cached_path.exists():
            new_files_map[item_id] = old
        else:
            to_download.append(it)

    downloaded_count = 0

    def _fetch_cli_one(it: dict) -> tuple[dict, str]:
        item_id = str(it["id"])
        mime = str(it.get("mimeType") or "")
        tmp_path = TRANSCRIPTS_DIR / f".tmp-{item_id}.txt"
        try:
            if mime == "application/vnd.google-apps.document":
                _run_gdrive_cmd([cli, "readonly", "export", item_id, str(tmp_path), "--format", "txt"])
            else:
                _run_gdrive_cmd([cli, "readonly", "download", item_id, "--out", str(tmp_path)])
            raw_bytes = tmp_path.read_bytes() if tmp_path.exists() else b""
            return it, _clean_text_blob(raw_bytes)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    if to_download:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for it, content in pool.map(_fetch_cli_one, to_download):
                item_id = str(it["id"])
                (TRANSCRIPTS_DIR / f"{item_id}.txt").write_text(content, encoding="utf-8")
                downloaded_count += 1
                new_files_map[item_id] = {
                    "id": item_id,
                    "name": it.get("name", item_id),
                    "mimeType": it.get("mimeType", "text/plain"),
                    "modifiedTime": it.get("modifiedTime", ""),
                    "charCount": len(content),
                    "sessionNumber": _extract_session_number(it.get("name", "")),
                }

    if sid:
        _run_gdrive_cmd([cli, "readonly", "export", sid, str(SUMMARIES_MD_FILE), "--format", "md"])
    if bid:
        _run_gdrive_cmd([cli, "readonly", "export", bid, str(BACKSTORIES_TXT_FILE), "--format", "txt"])

    updated_index = {
        "folderId": fid,
        "summariesDocId": sid,
        "backstoriesDocId": bid,
        "lastSyncedAt": int(time.time() * 1000),
        "lastSyncSource": "gdrive_cli",
        "downloadedCount": downloaded_count,
        "files": new_files_map,
    }
    _write_json(INDEX_FILE, updated_index)
    return get_status()


def _unescape_md(text: str) -> str:
    return re.sub(r"\\([!*\-_&#()\[\]])", r"\1", str(text or "")).strip()


def parse_master_summaries_md(md_text: str) -> list[dict]:
    """Parses markdown exported from the master 'DND Session Summaries' Google Doc into structured entries."""
    clean = str(md_text or "").replace("\r\n", "\n").strip()
    if not clean:
        return []

    heading_re = re.compile(r"^##(?!#)\s+([^\n]+)$", re.MULTILINE)
    matches = list(heading_re.finditer(clean))
    if not matches:
        return []

    entries = []
    for i, m in enumerate(matches):
        raw_title = m.group(1).strip()
        title = _unescape_md(raw_title.strip("*").strip())
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(clean)
        block = clean[start:end].strip()

        date_match = re.search(r"^(?:\*\*)?Date:\s*(.+?)(?:\*\*)?$", block, re.MULTILINE | re.IGNORECASE)
        date_label = _unescape_md(date_match.group(1)) if date_match else ""

        body_lines = []
        for line in block.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if re.match(r"^###\s+Session\s+Summary\s*$", stripped, re.IGNORECASE):
                continue
            if re.match(r"^(?:\*\*)?Date:\s*", stripped, re.IGNORECASE):
                continue
            stripped = re.sub(r"^\*\*Summary:\*\*\s*", "", stripped, flags=re.IGNORECASE)
            stripped = re.sub(r"^Summary:\s*", "", stripped, flags=re.IGNORECASE)
            body_lines.append(_unescape_md(stripped.replace("**", "")))

        summary_text = " ".join(body_lines).strip()
        sess_num = _extract_session_number(title)
        entries.append({
            "id": f"summary-{sess_num if sess_num is not None else i + 1}",
            "sessionNumber": sess_num,
            "order": i,
            "title": title,
            "dateLabel": date_label,
            "summary": summary_text,
        })

    entries.sort(
        key=lambda e: (e["sessionNumber"] if e["sessionNumber"] is not None else -1, e["order"]),
        reverse=True,
    )
    return entries


def get_status() -> dict:
    """Returns current Google Drive OAuth connection state and local cache stats."""
    cfg = load_drive_config()
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}
    summaries = parse_master_summaries_md(
        SUMMARIES_MD_FILE.read_text(encoding="utf-8") if SUMMARIES_MD_FILE.exists() else ""
    )
    has_oauth_client = load_oauth_client() is not None
    tok = _read_json(TOKEN_FILE, None)
    connected = bool(isinstance(tok, dict) and tok.get("access_token"))
    cli_available = _find_gdrive_cli() is not None

    return {
        "hasOauthClient": has_oauth_client,
        "connected": connected,
        "cliAvailable": cli_available,
        "folderId": cfg["folderId"],
        "summariesDocId": cfg["summariesDocId"],
        "backstoriesDocId": cfg["backstoriesDocId"],
        "cachedTranscriptCount": len(files_map),
        "cachedSummaryCount": len(summaries),
        "hasBackstories": BACKSTORIES_TXT_FILE.exists() and BACKSTORIES_TXT_FILE.stat().st_size > 20,
        "lastSyncedAt": idx.get("lastSyncedAt") or None,
        "lastSyncSource": idx.get("lastSyncSource") or "",
        "autoSyncEnabled": bool(_AUTO_SYNC_STATE["enabled"]),
        "autoSyncIntervalMinutes": int(_AUTO_SYNC_STATE["intervalMinutes"]),
        "lastAutoCheckAt": _AUTO_SYNC_STATE["lastCheckAt"],
        "lastAutoNewCount": _AUTO_SYNC_STATE["lastNewCount"],
    }


def auto_sync_if_due(min_age_seconds: int = 600) -> dict:
    """Runs an incremental Google Drive sync in the background when due."""
    st = get_status()
    fid = st.get("folderId")
    if not fid or (not st.get("connected") and not st.get("cliAvailable")):
        return st
    last_ts = st.get("lastSyncedAt") or 0
    if last_ts and ((time.time() * 1000) - last_ts) < (min_age_seconds * 1000):
        return st
    before_count = int(st.get("cachedTranscriptCount") or 0)
    try:
        updated = (
            sync_from_drive_api(fid, st.get("summariesDocId", ""), st.get("backstoriesDocId", ""))
            if st.get("connected")
            else sync_from_gdrive_cli(fid, st.get("summariesDocId", ""), st.get("backstoriesDocId", ""))
        )
        idx = _read_json(INDEX_FILE, {})
        dl = int(idx.get("downloadedCount") or 0)
        delta = max(0, int(updated.get("cachedTranscriptCount") or 0) - before_count, dl)
        _AUTO_SYNC_STATE["lastCheckAt"] = int(time.time() * 1000)
        _AUTO_SYNC_STATE["lastNewCount"] = delta
        _AUTO_SYNC_STATE["lastError"] = ""
        return get_status()
    except Exception as exc:
        _AUTO_SYNC_STATE["lastCheckAt"] = int(time.time() * 1000)
        _AUTO_SYNC_STATE["lastError"] = str(exc)[:200]
        return st


_OPEN_MYSTERY_RE = re.compile(
    r"\b(secret|mystery|cliffhanger|unresolved|investigat|graffiti|stone|well|boss|unseen\s+peril|missing|hidden|plot|quest|clue|door|path|goblin|axe|where|who)\b",
    re.IGNORECASE,
)
_PAST_PUZZLE_RE = re.compile(
    r"\b(puzzle|riddle|inscription|cipher|rune|glyph|orb|door|locked|mechanism|statue|lever|altar|mirror|portal|maze|trap|secret|clue|prophecy|stone)\b",
    re.IGNORECASE,
)


def extract_campaign_mysteries(max_open: int = 8, max_puzzles: int = 16) -> dict:
    """Extracts open campaign mysteries and past puzzles/riddles from synced summaries and transcripts."""
    summaries = parse_master_summaries_md(
        SUMMARIES_MD_FILE.read_text(encoding="utf-8") if SUMMARIES_MD_FILE.exists() else ""
    )
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}

    open_mysteries = []
    past_puzzles = []
    seen_excerpts = set()

    for s in summaries[:6]:
        sents = [seg.strip() for seg in re.split(r"(?<=[.!?])\s+", s["summary"]) if len(seg.strip()) >= 24]
        if not sents:
            continue
        candidate = None
        # Prefer closing cliffhanger/unresolved sentence
        for cand in reversed(sents):
            if _OPEN_MYSTERY_RE.search(cand):
                candidate = cand
                break
        if not candidate:
            candidate = sents[-1]
        norm = candidate.lower()[:120]
        if norm not in seen_excerpts:
            seen_excerpts.add(norm)
            open_mysteries.append({
                "id": f"open-{s['id']}",
                "title": s["title"],
                "sessionNumber": s["sessionNumber"],
                "dateLabel": s["dateLabel"],
                "category": "mystery",
                "excerpt": candidate[:320] + ("..." if len(candidate) > 320 else ""),
            })
        if len(open_mysteries) >= max_open:
            break

    for s in summaries:
        sents = [seg.strip() for seg in re.split(r"(?<=[.!?])\s+", s["summary"]) if len(seg.strip()) >= 24]
        matches = [seg for seg in sents if _PAST_PUZZLE_RE.search(seg)]
        if not matches:
            continue
        excerpt = " ".join(matches[:2]).strip()
        norm = excerpt.lower()[:120]
        if norm in seen_excerpts:
            continue
        seen_excerpts.add(norm)
        past_puzzles.append({
            "id": f"puz-{s['id']}",
            "title": s["title"],
            "sessionNumber": s["sessionNumber"],
            "dateLabel": s["dateLabel"],
            "category": "puzzle",
            "excerpt": excerpt[:320] + ("..." if len(excerpt) > 320 else ""),
        })
        if len(past_puzzles) >= max_puzzles:
            break

    # Fallback: scan newest cached transcripts if master summaries are empty
    if not open_mysteries and not past_puzzles and files_map:
        for meta in list_cached_transcripts()[:6]:
            t_path = TRANSCRIPTS_DIR / f"{meta['id']}.txt"
            if not t_path.exists():
                continue
            for utt in _split_transcript_utterances(t_path.read_text(encoding="utf-8", errors="replace")):
                if 28 <= len(utt) <= 300 and _PAST_PUZZLE_RE.search(utt):
                    norm = utt.lower()[:120]
                    if norm not in seen_excerpts:
                        seen_excerpts.add(norm)
                        past_puzzles.append({
                            "id": f"puz-{meta['id']}-{len(past_puzzles)}",
                            "title": meta["name"],
                            "sessionNumber": meta.get("sessionNumber"),
                            "dateLabel": "",
                            "category": "puzzle",
                            "excerpt": utt,
                        })
                        if len(past_puzzles) >= max_puzzles:
                            break
            if len(past_puzzles) >= max_puzzles:
                break

    return {
        "openMysteries": open_mysteries,
        "pastPuzzles": past_puzzles,
        "totalSummaries": len(summaries),
        "totalTranscripts": len(files_map),
    }


def list_cached_transcripts() -> list[dict]:
    """Lists all locally cached Drive transcripts sorted newest-first by session number."""
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}
    rows = []
    for meta in files_map.values():
        if not isinstance(meta, dict) or not meta.get("id"):
            continue
        rows.append({
            "id": meta["id"],
            "name": meta.get("name") or meta["id"],
            "sessionNumber": meta.get("sessionNumber"),
            "charCount": int(meta.get("charCount") or 0),
            "modifiedTime": meta.get("modifiedTime") or "",
        })
    rows.sort(
        key=lambda r: (r["sessionNumber"] if r["sessionNumber"] is not None else -1, str(r["name"])),
        reverse=True,
    )
    return rows


def get_cached_transcript(file_id: str = "latest") -> dict | None:
    """Loads a cached Drive transcript by ID (or 'latest' for the newest episode)."""
    rows = list_cached_transcripts()
    if not rows:
        return None
    if not file_id or file_id == "latest":
        target = rows[0]
    else:
        target = next((r for r in rows if r["id"] == file_id), None)
    if not target:
        return None
    t_path = TRANSCRIPTS_DIR / f"{target['id']}.txt"
    if not t_path.exists():
        return None
    text = t_path.read_text(encoding="utf-8", errors="replace")
    return {
        "id": target["id"],
        "name": target["name"],
        "sessionNumber": target["sessionNumber"],
        "charCount": len(text),
        "lineCount": len(text.splitlines()),
        "text": text,
    }


_PUZZLE_HIGHLIGHT_STRONG_RE = re.compile(
    r"\b(riddle|puzzle|cipher|inscription|engrav\w*|etch\w*|pressure\s+plate|mouthless|hollow|secret\s+door)\b",
    re.I,
)
_PUZZLE_HIGHLIGHT_SUPPORT_RE = re.compile(
    r"\b(runes?|keystone|cornerstone|pillar|statue|pedestal|lever|symbol|mural|glint|clues?|investigation|hammer|doorway)\b",
    re.I,
)
_SOCIAL_HIGHLIGHT_RE = re.compile(
    r"\b(persuasion|insight|deception|intimidation|ask\s+him|ask\s+her|ask\s+them|mayor|harbin|tavern|innkeeper|deal|negotiate|bargain|question|interrogate|promise|secret|sending\s+stone|talk\s+to)\b",
    re.I,
)
_COMBAT_HIGHLIGHT_RE = re.compile(
    r"\b(initiative|roll\s+to\s+hit|armor\s+class|damage|fireball|saving\s+throw|hit\s+points?|bloodied|unconscious|attack\s+roll|sneak\s+attack|critical)\b",
    re.I,
)


def _best_window(lines: list[str], mode: str) -> dict:
    total = len(lines)
    if total == 0:
        return {"startPct": 0, "endPct": 100, "score": 0, "snippet": ""}
    win_size = min(total, min(200, max(90, round(total * 0.12))))
    step = max(5, win_size // 10)

    def line_score(txt: str) -> int:
        if mode == "puzzle":
            strong = len(_PUZZLE_HIGHLIGHT_STRONG_RE.findall(txt))
            sup = len(_PUZZLE_HIGHLIGHT_SUPPORT_RE.findall(txt))
            pen = -1 if re.search(r"\b(initiative|roll\s+for\s+initiative)\b", txt, re.I) else 0
            return strong * 5 + sup * 2 + pen
        if mode == "social":
            soc = len(_SOCIAL_HIGHLIGHT_RE.findall(txt))
            cmb = len(_COMBAT_HIGHLIGHT_RE.findall(txt))
            q_bonus = 1 if ("?" in txt and len(txt) >= 25) else 0
            return soc * 3 + q_bonus - cmb * 2
        if mode == "combat":
            return len(_COMBAT_HIGHLIGHT_RE.findall(txt)) * 3
        return 0

    line_scores = [line_score(t) for t in lines]
    best_start = 0
    best_score = -10**9
    best_peak_idx = 0

    starts = list(range(0, max(1, total - win_size + 1), step))
    if total > win_size and (total - win_size) not in starts:
        starts.append(total - win_size)

    for s in starts:
        end = min(total, s + win_size)
        sc = sum(line_scores[s:end])
        if sc > best_score:
            best_score = sc
            best_start = s
            peak_sub = max(
                range(s, end),
                key=lambda i: (line_scores[i], len(lines[i]) >= 16),
            )
            best_peak_idx = peak_sub

    pad_start = max(0, best_start - 10)
    pad_end = min(total, best_start + win_size + 15)
    start_pct = round((pad_start / total) * 100)
    end_pct = max(start_pct + 1, round((pad_end / total) * 100))
    return {
        "startPct": int(start_pct),
        "endPct": int(min(100, end_pct)),
        "score": int(max(0, best_score)),
        "snippet": lines[best_peak_idx][:120].strip(),
    }


def detect_transcript_highlights(text: str) -> dict:
    """Finds the peak Puzzle/Riddle, Social/Roleplay, and Combat windows in a transcript."""
    clean_lines = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.match(r"^\[[^\]]{1,40}\]$", line):
            continue
        if re.match(r"^(?:===|---|TRANSCRIPT\s+ATTRIBUTION)", line, re.I):
            continue
        clean_lines.append(line)

    return {
        "lineCount": len(clean_lines),
        "puzzle": _best_window(clean_lines, "puzzle"),
        "social": _best_window(clean_lines, "social"),
        "combat": _best_window(clean_lines, "combat"),
    }


def get_transcript_highlights(file_id: str = "latest") -> dict | None:
    """Returns detected scene highlight jump ranges for a cached Drive transcript."""
    tr = get_cached_transcript(file_id)
    if not tr:
        return None
    highlights = detect_transcript_highlights(tr.get("text") or "")
    return {
        "id": tr["id"],
        "name": tr["name"],
        "sessionNumber": tr.get("sessionNumber"),
        **highlights,
    }


def get_overview() -> dict:
    """Returns lightweight overview stats + the 6 most recent summaries for UI display."""
    status = get_status()
    summaries = parse_master_summaries_md(
        SUMMARIES_MD_FILE.read_text(encoding="utf-8") if SUMMARIES_MD_FILE.exists() else ""
    )
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}
    transcripts_meta = sorted(
        files_map.values(),
        key=lambda f: (f.get("sessionNumber") if f.get("sessionNumber") is not None else -1, str(f.get("name") or "")),
        reverse=True,
    )
    return {
        **status,
        "recentSummaries": [
            {
                "title": s["title"],
                "dateLabel": s["dateLabel"],
                "sessionNumber": s["sessionNumber"],
                "summary": s["summary"][:360] + ("..." if len(s["summary"]) > 360 else ""),
            }
            for s in summaries[:6]
        ],
        "recentTranscripts": [
            {
                "id": t.get("id"),
                "name": t.get("name"),
                "sessionNumber": t.get("sessionNumber"),
            }
            for t in transcripts_meta[:10]
        ],
    }


def _extract_weighted_terms(query_text: str) -> list[tuple[str, float]]:
    clean = str(query_text or "").strip()
    if not clean:
        return []
    weights: dict[str, float] = {}

    # Multi-word capitalized phrases (NPCs, towns, factions)
    for phrase in re.findall(r"\b[A-Z][a-z']+(?:\s+(?:of|the|[A-Z][a-z']+)){1,3}\b", clean):
        low = phrase.lower().strip()
        if len(low) >= 5:
            weights[low] = max(weights.get(low, 0.0), 5.0)

    # Single capitalized proper nouns
    for prop in re.findall(r"\b[A-Z][a-zA-Z']{2,22}\b", clean):
        low = prop.lower()
        if low not in _STOPWORDS:
            weights[low] = max(weights.get(low, 0.0), 3.0)

    # General search keywords >= 4 chars
    for tok in re.findall(r"\b[a-zA-Z][a-zA-Z']{3,22}\b", clean.lower()):
        if tok not in _STOPWORDS:
            weights[tok] = max(weights.get(tok, 0.0), 1.5)

    return sorted(weights.items(), key=lambda kv: (-kv[1], -len(kv[0])))[:36]


def _score_text(text: str, weighted_terms: list[tuple[str, float]]) -> float:
    if not text or not weighted_terms:
        return 0.0
    low = text.lower()
    score = 0.0
    for term, w in weighted_terms:
        if term in low:
            score += w
    return score


def _split_transcript_utterances(raw_text: str) -> list[str]:
    lines = str(raw_text or "").splitlines()
    blocks = []
    current_speaker = ""
    buf = []

    def _flush():
        nonlocal buf, current_speaker
        joined = " ".join(buf).strip()
        if joined and not re.match(r"^(?:TRANSCRIPT ATTRIBUTION|==|---)", joined):
            prefix = f"{current_speaker}: " if current_speaker else ""
            full = f"{prefix}{joined}".strip()
            if len(full) <= 320:
                blocks.append(full)
            else:
                for sent in re.split(r"(?<=[.!?])\s+", joined):
                    s = sent.strip()
                    if 22 <= len(s) <= 320:
                        blocks.append(f"{prefix}{s}".strip())
        buf = []

    for line in lines:
        st = line.strip()
        if not st:
            _flush()
            continue
        spk = re.match(r"^\[([^\]]{1,40})\]\s*$", st)
        if spk:
            _flush()
            current_speaker = spk.group(1)
            continue
        buf.append(st)
    _flush()
    return blocks


def search_campaign_archive(query_text: str, max_summaries: int = 4, max_snippets: int = 8) -> dict:
    """Searches cached summaries, all full transcripts, and backstories with continuity context."""
    summaries = parse_master_summaries_md(
        SUMMARIES_MD_FILE.read_text(encoding="utf-8") if SUMMARIES_MD_FILE.exists() else ""
    )
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}
    has_backstories = BACKSTORIES_TXT_FILE.exists() and BACKSTORIES_TXT_FILE.stat().st_size > 20

    terms = _extract_weighted_terms(query_text)
    recent_summaries = summaries[:2]
    recent_titles = {s["title"] for s in recent_summaries}

    scored_summaries = []
    for s in summaries:
        blob = f"{s['title']} {s['summary']}"
        sc = _score_text(blob, terms)
        if sc > 0:
            tie = (s["sessionNumber"] or 0) * 0.01
            scored_summaries.append((sc + tie, s))
    scored_summaries.sort(key=lambda x: x[0], reverse=True)
    matched_summaries = [s for _, s in scored_summaries[:max_summaries]]

    # Search full transcripts
    transcripts_meta = sorted(
        files_map.values(),
        key=lambda f: (f.get("sessionNumber") if f.get("sessionNumber") is not None else -1, str(f.get("name") or "")),
        reverse=True,
    )
    all_snippets = []
    if terms:
        for meta in transcripts_meta:
            t_path = TRANSCRIPTS_DIR / f"{meta['id']}.txt"
            if not t_path.exists():
                continue
            raw_txt = t_path.read_text(encoding="utf-8", errors="replace")
            low_whole = raw_txt.lower()
            # Fast file-level prefilter
            if not any(term in low_whole for term, _ in terms):
                continue
            utterances = _split_transcript_utterances(raw_txt)
            file_hits = []
            for utt in utterances:
                if len(utt) < 22:
                    continue
                sc = _score_text(utt, terms)
                if sc > 0:
                    sess_tie = (meta.get("sessionNumber") or 0) * 0.01
                    file_hits.append((
                        sc + sess_tie,
                        {
                            "source": meta.get("name") or meta["id"],
                            "sessionNumber": meta.get("sessionNumber"),
                            "text": utt[:280] + ("..." if len(utt) > 280 else ""),
                            "score": round(sc, 2),
                        },
                    ))
            file_hits.sort(key=lambda x: x[0], reverse=True)
            all_snippets.extend(file_hits[:2])

    all_snippets.sort(key=lambda x: x[0], reverse=True)
    matched_snippets = [item for _, item in all_snippets[:max_snippets]]

    # Search backstories
    matched_backstories = []
    if has_backstories and terms:
        bs_text = BACKSTORIES_TXT_FILE.read_text(encoding="utf-8", errors="replace")
        bs_hits = []
        for para in re.split(r"\n{2,}", bs_text):
            clean_p = re.sub(r"\s+", " ", para).strip()
            if len(clean_p) < 35:
                continue
            sc = _score_text(clean_p, terms)
            if sc > 0:
                bs_hits.append((sc, clean_p[:320] + ("..." if len(clean_p) > 320 else "")))
        bs_hits.sort(key=lambda x: x[0], reverse=True)
        matched_backstories = [txt for _, txt in bs_hits[:2]]

    # Compose compact LLM/LocalBrain context block
    ctx_lines = []
    for rs in recent_summaries:
        ctx_lines.append(f"[Drive Recent Continuity: {rs['title']}] {rs['summary'][:450]}")
    for ms in matched_summaries:
        if ms["title"] in recent_titles:
            continue
        ctx_lines.append(f"[Drive Matched Summary: {ms['title']}] {ms['summary'][:420]}")
    for sn in matched_snippets:
        ctx_lines.append(f"[Drive Transcript: {sn['source']}] \"{sn['text']}\"")
    for bs in matched_backstories:
        ctx_lines.append(f"[Drive Backstory] {bs}")

    context_text = "\n".join(ctx_lines)
    if len(context_text) > 3600:
        context_text = context_text[:3597] + "..."

    return {
        "contextText": context_text,
        "recentSummaries": [
            {"title": s["title"], "dateLabel": s["dateLabel"], "summary": s["summary"][:450]}
            for s in recent_summaries
        ],
        "matchedSummaries": [
            {"title": s["title"], "dateLabel": s["dateLabel"], "summary": s["summary"][:450]}
            for s in matched_summaries
        ],
        "matchedSnippets": matched_snippets,
        "matchedBackstories": matched_backstories,
        "totalTranscripts": len(files_map),
        "totalSummaries": len(summaries),
        "hasBackstories": has_backstories,
    }


def export_archive_bundle() -> dict:
    """Exports all locally cached Drive transcripts, summaries, and backstories into one portable JSON bundle."""
    idx = _read_json(INDEX_FILE, {})
    files_map = idx.get("files") if isinstance(idx.get("files"), dict) else {}
    cfg = load_drive_config()

    transcripts = []
    for item_id, meta in sorted(
        files_map.items(),
        key=lambda kv: (kv[1].get("sessionNumber") or -1, str(kv[1].get("name") or "")),
    ):
        t_path = TRANSCRIPTS_DIR / f"{item_id}.txt"
        text = t_path.read_text(encoding="utf-8", errors="replace") if t_path.exists() else ""
        if not text:
            continue
        transcripts.append({
            "id": item_id,
            "name": meta.get("name", item_id),
            "mimeType": meta.get("mimeType", "text/plain"),
            "modifiedTime": meta.get("modifiedTime", ""),
            "sessionNumber": meta.get("sessionNumber"),
            "text": text,
        })

    return {
        "version": 1,
        "kind": "dnd-copilot-drive-archive",
        "exportedAt": int(time.time() * 1000),
        "folderId": cfg["folderId"],
        "summariesDocId": cfg["summariesDocId"],
        "backstoriesDocId": cfg["backstoriesDocId"],
        "summariesMd": SUMMARIES_MD_FILE.read_text(encoding="utf-8") if SUMMARIES_MD_FILE.exists() else "",
        "backstoriesTxt": BACKSTORIES_TXT_FILE.read_text(encoding="utf-8") if BACKSTORIES_TXT_FILE.exists() else "",
        "transcripts": transcripts,
    }


def import_archive_bundle(bundle: dict) -> dict:
    """Imports a portable Drive archive JSON bundle into .gdrive-cache/ for offline search."""
    if not isinstance(bundle, dict) or (
        bundle.get("kind") != "dnd-copilot-drive-archive" and not isinstance(bundle.get("transcripts"), list)
    ):
        raise ValueError("Invalid Drive Archive bundle JSON.")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

    summaries_md = str(bundle.get("summariesMd") or "").strip()
    if summaries_md:
        SUMMARIES_MD_FILE.write_text(summaries_md, encoding="utf-8")

    backstories_txt = str(bundle.get("backstoriesTxt") or "").strip()
    if backstories_txt:
        BACKSTORIES_TXT_FILE.write_text(backstories_txt, encoding="utf-8")

    files_map = {}
    for tr in bundle.get("transcripts") or []:
        if not isinstance(tr, dict):
            continue
        item_id = str(tr.get("id") or "").strip() or f"tr-{len(files_map) + 1}"
        text = str(tr.get("text") or "").strip()
        if not text:
            continue
        (TRANSCRIPTS_DIR / f"{item_id}.txt").write_text(text, encoding="utf-8")
        name = str(tr.get("name") or item_id)
        files_map[item_id] = {
            "id": item_id,
            "name": name,
            "mimeType": str(tr.get("mimeType") or "text/plain"),
            "modifiedTime": str(tr.get("modifiedTime") or ""),
            "charCount": len(text),
            "sessionNumber": tr.get("sessionNumber") if tr.get("sessionNumber") is not None else _extract_session_number(name),
        }

    _write_json(
        INDEX_FILE,
        {
            "folderId": str(bundle.get("folderId") or ""),
            "summariesDocId": str(bundle.get("summariesDocId") or ""),
            "backstoriesDocId": str(bundle.get("backstoriesDocId") or ""),
            "lastSyncedAt": int(time.time() * 1000),
            "lastSyncSource": "bundle",
            "files": files_map,
        },
    )
    return get_status()


def _main() -> int:
    if "--cli-sync" in sys.argv:
        st = sync_from_gdrive_cli()
        print(json.dumps(st, indent=2))
        return 0
    if "--status" in sys.argv:
        print(json.dumps(get_status(), indent=2))
        return 0
    print("Usage: python gdrive_sync.py [--cli-sync | --status]")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
