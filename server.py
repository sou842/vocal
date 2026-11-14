"""Vocal Studio — local web app for text-to-speech (Chatterbox) and PDF text extraction (pymupdf4llm).

Run:  .venv\\Scripts\\python.exe server.py            (opens http://127.0.0.1:8000)
      .venv\\Scripts\\python.exe server.py --no-browser

Storage (everything lives under ./projects):
  projects/<Project>/<Project>_<N>.wav                      generated audio
  projects/<Project>/texts/<name>.txt|.md                   text saved from a document
  projects/<Project>/documents/<id>/{doc.json, source.pdf}  saved PDF extractions (id = sha256 prefix)

Security model: single user on this machine. The server only listens on 127.0.0.1, and every request
must carry a matching Host header (blocks DNS rebinding); state-changing requests must also come from
this app's own origin with the expected Content-Type (blocks other websites posting to the API).
"""
import base64
import binascii
import hashlib
import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import torch
import torchaudio as ta

from tts import split_text

# ------------------------------------------------------------------ configuration
HOST, PORT = "127.0.0.1", 8000
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

MAX_JSON_BYTES = 40 * 1024 * 1024      # generous: a voice sample travels base64-encoded in JSON
MAX_PDF_BYTES = 300 * 1024 * 1024
MAX_VOICE_BYTES = 25 * 1024 * 1024
MAX_SCRIPT_CHARS = 500_000
CHUNK_CHARS = 150                      # text per TTS call; smaller = finer progress
JOB_TTL_SECONDS = 3600                 # finished jobs are forgotten after this

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
PROJECTS = os.path.join(ROOT, "projects")
VOICES = os.path.join(ROOT, "voices")  # temporary uploaded voice samples (deleted after each job)
os.makedirs(PROJECTS, exist_ok=True)
os.makedirs(VOICES, exist_ok=True)

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/lucide.min.js": ("lucide.min.js", "text/javascript; charset=utf-8"),
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


# ------------------------------------------------------------------ projects
def clean_name(name):
    """Project names: letters, digits, '-' and '_' only (spaces become '_'). Max 40 chars."""
    name = re.sub(r"[^A-Za-z0-9_-]", "", str(name or "").strip().replace(" ", "_"))
    return name[:40]


def list_projects():
    return sorted((d for d in os.listdir(PROJECTS) if os.path.isdir(os.path.join(PROJECTS, d))), key=str.lower)


def resolve_project(name, must_exist=True):
    """Map a requested name to the existing folder name (Windows folders are case-insensitive)."""
    name = clean_name(name)
    if not name:
        raise ApiError(400, "Select or create a project first.")
    for existing in list_projects():
        if existing.lower() == name.lower():
            return existing
    if must_exist:
        raise ApiError(404, f'Project "{name}" does not exist.')
    return name


def project_dir(project):
    return os.path.join(PROJECTS, project)


def number_of(project, fname):
    m = re.fullmatch(re.escape(project) + r"_(\d+)\.wav", fname, flags=re.IGNORECASE)
    return int(m.group(1)) if m else None


def list_audio(project):
    d = project_dir(project)
    if not os.path.isdir(d):
        return []
    items = [(number_of(project, f), f) for f in os.listdir(d)]
    return [f for n, f in sorted((i for i in items if i[0] is not None), reverse=True)]  # newest first


def next_audio_name(project):
    nums = [number_of(project, f) for f in list_audio(project)]
    return f"{project}_{max(nums, default=0) + 1}.wav"


# ------------------------------------------------------------------ jobs (shared between threads)
state_lock = threading.RLock()    # guards tts_jobs / ext_jobs and every job dict inside them
tts_jobs, ext_jobs = {}, {}
tts_q, ext_q = queue.Queue(), queue.Queue()
PRIVATE_KEYS = {"text", "voice", "data", "t0"}
ACTIVE = {"queued", "loading model", "generating", "extracting"}


def job_update(job, **fields):
    with state_lock:
        job.update(fields)


def job_snapshot(job):
    with state_lock:
        snap = {k: v for k, v in job.items() if k not in PRIVATE_KEYS}
        if snap.get("status") == "generating" and "t0" in job:
            snap["elapsed"] = round(time.time() - job["t0"])   # live clock between parts
        return snap


def prune_jobs():
    """Forget finished jobs after JOB_TTL_SECONDS so memory doesn't grow forever."""
    cutoff = time.time() - JOB_TTL_SECONDS
    with state_lock:
        for table in (tts_jobs, ext_jobs):
            for jid in [k for k, j in table.items() if j["status"] not in ACTIVE and j.get("finished", 0) < cutoff]:
                del table[jid]


# ------------------------------------------------------------------ text to speech
_model = None


def get_model():
    global _model
    if _model is None:
        from chatterbox.tts import ChatterboxTTS
        _model = ChatterboxTTS.from_pretrained(device="cuda" if torch.cuda.is_available() else "cpu")
    return _model


audio_lock = threading.Lock()   # numbering + writing of <Project>_<N>.wav


def tts_worker():
    while True:
        jid = tts_q.get()
        with state_lock:
            job = tts_jobs.get(jid)
        if job is None:
            tts_q.task_done()
            continue
        try:
            job_update(job, status="loading model")
            model = get_model()
            chunks = split_text(job["text"], CHUNK_CHARS)
            if not chunks:
                raise ValueError("The text is empty after cleanup.")
            total_chars = sum(len(c) for c in chunks)
            t0 = time.time()
            job_update(job, status="generating", total=len(chunks), done=0, elapsed=0, eta=None, t0=t0,
                       parts=[c[:70] + ("..." if len(c) > 70 else "") for c in chunks])
            wavs, chars_done = [], 0
            for i, chunk in enumerate(chunks):
                wavs.append(model.generate(chunk, audio_prompt_path=job["voice"],
                                           exaggeration=job["exaggeration"], cfg_weight=job["cfg"]))
                chars_done += len(chunk)
                el = time.time() - t0
                job_update(job, done=i + 1, elapsed=round(el),
                           eta=round(el / chars_done * (total_chars - chars_done)))
            wav = torch.cat(wavs, dim=-1)
            pdir = project_dir(job["project"])
            os.makedirs(pdir, exist_ok=True)
            with audio_lock:
                name = next_audio_name(job["project"])
                ta.save(os.path.join(pdir, name), wav, model.sr)
            job_update(job, status="done", file=name, seconds=round(wav.shape[-1] / model.sr, 1))
        except Exception as e:
            job_update(job, status="error", error=f"Generation failed: {e}")
        finally:
            if job.get("voice"):
                try:
                    os.remove(job["voice"])
                except OSError:
                    pass
            job_update(job, text=None, voice=None, finished=time.time())
            tts_q.task_done()


# ------------------------------------------------------------------ saved PDF documents
doc_lock = threading.RLock()   # serializes every doc.json read/write
_summary_cache = {}            # doc.json path -> (mtime_ns, size, summary)


def doc_folder(project, doc_id):
    doc_id = re.sub(r"[^a-f0-9]", "", str(doc_id or ""))[:16]
    if not doc_id:
        raise ApiError(400, "Missing document id.")
    return os.path.join(project_dir(project), "documents", doc_id)


def load_doc(project, doc_id):
    f = os.path.join(doc_folder(project, doc_id), "doc.json")
    with doc_lock:
        if not os.path.isfile(f):
            return None
        with open(f, encoding="utf-8") as fh:
            return json.load(fh)


def _replace_with_retry(src, dst):
    """os.replace can fail on Windows while another process (antivirus, indexer) has dst open."""
    for attempt in range(10):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.05 * (attempt + 1))


def save_doc(project, doc):
    folder = doc_folder(project, doc["id"])
    with doc_lock:
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, "doc.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False)
        _replace_with_retry(tmp, os.path.join(folder, "doc.json"))   # atomic: never half-written


def doc_summary(d):
    return {"id": d["id"], "name": d["name"], "pages": len(d["pages"]),
            "words": sum(len(p["text"].split()) for p in d["pages"]),
            "edited": sum(1 for p in d["pages"] if p["text"] != p["orig"]),
            "created": d["created"], "elapsed": d.get("elapsed", 0)}


def list_docs(project):
    base = os.path.join(project_dir(project), "documents")
    if not os.path.isdir(base):
        return []
    out = []
    with doc_lock:
        for doc_id in os.listdir(base):
            f = os.path.join(base, doc_id, "doc.json")
            try:
                st = os.stat(f)
            except OSError:
                continue
            cached = _summary_cache.get(f)
            if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
                out.append(cached[2])
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    summary = doc_summary(json.load(fh))
            except (OSError, ValueError, KeyError):
                continue
            _summary_cache[f] = (st.st_mtime_ns, st.st_size, summary)
            out.append(summary)
    return sorted(out, key=lambda x: x["created"], reverse=True)


def extract_worker():
    """PDF -> markdown page by page (so the UI can show progress), then saved into the project."""
    import pymupdf
    import pymupdf4llm
    while True:
        jid = ext_q.get()
        with state_lock:
            job = ext_jobs.get(jid)
            data = job.pop("data", None) if job else None
        if job is None:
            ext_q.task_done()
            continue
        try:
            pdf = pymupdf.open(stream=data, filetype="pdf")
            if pdf.needs_pass:
                raise ValueError("the PDF is password-protected")
            job_update(job, status="extracting", total=pdf.page_count, done=0)
            t0, pages = time.time(), []
            for i in range(pdf.page_count):
                try:
                    chunk = pymupdf4llm.to_markdown(pdf, pages=[i], page_chunks=True,
                                                    use_ocr=False, header=False, footer=False)
                    text = chunk[0]["text"].strip() if chunk else ""
                except Exception:   # layout engine failed on this page: fall back to plain text
                    text = pdf[i].get_text().strip()
                pages.append({"n": i + 1, "text": text, "orig": text,
                              "noText": len(text) < 5 and bool(pdf[i].get_images())})
                el = time.time() - t0
                job_update(job, done=i + 1, elapsed=round(el), eta=round(el / (i + 1) * (pdf.page_count - i - 1)))
            doc = {"id": job["docId"], "name": job["name"], "created": time.time(),
                   "elapsed": round(time.time() - t0), "pages": pages}
            with doc_lock:
                if load_doc(job["project"], doc["id"]) is None:   # never overwrite an existing doc (and its edits)
                    save_doc(job["project"], doc)
                    with open(os.path.join(doc_folder(job["project"], doc["id"]), "source.pdf"), "wb") as fh:
                        fh.write(data)
            job_update(job, status="done")
        except Exception as e:
            job_update(job, status="error", error=f"Could not read this PDF: {e}")
        finally:
            job_update(job, finished=time.time())
            ext_q.task_done()


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "VocalStudio/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):   # quiet: only errors are printed (see handle_errors)
        pass

    # ---------- responses
    def send_body(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_body(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    # ---------- request helpers
    def check_host(self):
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            raise ApiError(403, "Forbidden host.")

    def check_origin(self):
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            raise ApiError(403, "Cross-site requests are not allowed.")
        if origin is None and self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            raise ApiError(403, "Cross-site requests are not allowed.")

    def read_body(self, limit):
        raw = self.headers.get("Content-Length")
        if raw is None:
            raise ApiError(411, "Content-Length required.")
        try:
            length = int(raw)
        except ValueError:
            raise ApiError(400, "Bad Content-Length.")
        if length < 0:
            raise ApiError(400, "Bad Content-Length.")
        if length > limit:
            raise ApiError(413, f"Request too large (max {limit // (1024 * 1024)} MB).")
        buf, remaining = bytearray(), length
        while remaining:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                raise ApiError(400, "Request body ended early.")
            buf += chunk
            remaining -= len(chunk)
        return bytes(buf)

    def read_json(self):
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "Expected application/json.")
        try:
            body = json.loads(self.read_body(MAX_JSON_BYTES) or b"{}")
        except ValueError:
            raise ApiError(400, "Invalid JSON.")
        if not isinstance(body, dict):
            raise ApiError(400, "Expected a JSON object.")
        return body

    def handle_errors(self, fn):
        try:
            self.check_host()
            fn()
        except ApiError as e:
            self.close_connection = True
            self.send_json({"error": e.message}, e.status)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self.close_connection = True   # client went away (e.g. audio seek/stop) - nothing to do
        except Exception as e:
            self.close_connection = True
            sys.stderr.write(f"[server] {self.command} {self.path} failed: {e!r}\n")
            try:
                self.send_json({"error": "Internal server error."}, 500)
            except OSError:
                pass

    def do_GET(self):
        self.handle_errors(self.route_get)

    def do_HEAD(self):
        self.handle_errors(self.route_get)

    def do_POST(self):
        self.handle_errors(self.route_post)

    # ---------- GET
    def route_get(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        arg = lambda k: qs.get(k, [""])[0]

        if path in STATIC:
            fname, ctype = STATIC[path]
            with open(os.path.join(WEB, fname), "rb") as fh:
                return self.send_body(200, fh.read(), ctype)
        if path == "/api/projects":
            return self.send_json(list_projects())
        if path == "/api/active":   # lets a reloaded page re-attach to running jobs
            with state_lock:
                return self.send_json({
                    "tts": [dict(job_snapshot(j), id=k) for k, j in tts_jobs.items() if j["status"] in ACTIVE],
                    "extract": [dict(job_snapshot(j), id=k) for k, j in ext_jobs.items() if j["status"] in ACTIVE]})
        if path.startswith("/api/jobs/"):
            with state_lock:
                job = tts_jobs.get(path.rsplit("/", 1)[1])
            if not job:
                raise ApiError(404, "This job no longer exists (the server may have restarted).")
            return self.send_json(job_snapshot(job))
        if path.startswith("/api/extract/"):
            with state_lock:
                job = ext_jobs.get(path.rsplit("/", 1)[1])
            if not job:
                raise ApiError(404, "This extraction no longer exists (the server may have restarted).")
            return self.send_json(job_snapshot(job))
        if path == "/api/files":
            return self.send_json(list_audio(resolve_project(arg("project"))))
        if path == "/api/docs":
            return self.send_json(list_docs(resolve_project(arg("project"))))
        if path == "/api/doc":
            doc = load_doc(resolve_project(arg("project")), arg("id"))
            if not doc:
                raise ApiError(404, "Document not found.")
            return self.send_json(doc)
        if path.startswith("/projects/"):
            parts = unquote(path).split("/")   # ['', 'projects', <project>, <file>]
            if len(parts) == 4 and parts[3].lower().endswith(".wav"):
                project = resolve_project(parts[2])
                fname = os.path.basename(parts[3])
                if number_of(project, fname) is not None:
                    return self.send_audio(os.path.join(project_dir(project), fname))
        raise ApiError(404, "Not found.")

    def send_audio(self, fpath):
        """Stream a .wav with HTTP Range support (needed for seeking in <audio>)."""
        if not os.path.isfile(fpath):
            raise ApiError(404, "Not found.")
        size = os.path.getsize(fpath)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range", "")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:   # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(fpath, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining:
                chunk = fh.read(min(remaining, 256 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---------- POST
    def route_post(self):
        self.check_origin()
        path = urlparse(self.path).path

        if path == "/api/projects":
            body = self.read_json()
            name = clean_name(body.get("name"))
            if not name:
                raise ApiError(400, "Enter a project name (letters, numbers, - or _).")
            if name.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
                raise ApiError(400, f'"{name}" is reserved by Windows. Choose another name.')
            existing = resolve_project(name, must_exist=False)
            os.makedirs(project_dir(existing), exist_ok=True)
            return self.send_json({"name": existing})

        if path == "/api/generate":
            body = self.read_json()
            text = str(body.get("text") or "").strip()
            if not text:
                raise ApiError(400, "Please enter some text first.")
            if len(text) > MAX_SCRIPT_CHARS:
                raise ApiError(413, f"The script is too long (max {MAX_SCRIPT_CHARS:,} characters).")
            project = resolve_project(body.get("project"))
            try:
                exaggeration = min(2.0, max(0.25, float(body.get("exaggeration", 0.5))))
                cfg = min(1.0, max(0.0, float(body.get("cfg", 0.5))))
            except (TypeError, ValueError):
                raise ApiError(400, "Invalid voice settings.")
            voice_bytes = None
            if body.get("voice"):
                try:
                    voice_bytes = base64.b64decode(str(body["voice"]), validate=True)
                except (binascii.Error, ValueError):
                    raise ApiError(400, "The voice sample could not be read.")
                if len(voice_bytes) > MAX_VOICE_BYTES:
                    raise ApiError(413, "The voice sample is too large (max 25 MB).")
                if not (voice_bytes[:4] == b"RIFF" and voice_bytes[8:12] == b"WAVE"):
                    raise ApiError(400, "The voice sample must be a .wav file.")
            voice_path = None
            if voice_bytes:   # only written once everything else is validated
                voice_path = os.path.join(VOICES, uuid.uuid4().hex + ".wav")
                with open(voice_path, "wb") as fh:
                    fh.write(voice_bytes)
            prune_jobs()
            jid = uuid.uuid4().hex
            with state_lock:
                tts_jobs[jid] = dict(text=text, voice=voice_path, project=project, status="queued",
                                     done=0, total=0, exaggeration=exaggeration, cfg=cfg, created=time.time())
            tts_q.put(jid)
            return self.send_json({"id": jid})

        if path == "/api/extract":
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ctype not in ("application/pdf", "application/octet-stream"):
                raise ApiError(415, "Expected a PDF upload.")
            project = resolve_project(unquote(self.headers.get("X-Project", "")))
            data = self.read_body(MAX_PDF_BYTES)
            if not data.startswith(b"%PDF"):
                raise ApiError(400, "That file is not a PDF.")
            name = unquote(self.headers.get("X-Filename", "document.pdf")).strip()[:200] or "document.pdf"
            doc_id = hashlib.sha256(data).hexdigest()[:16]
            prune_jobs()
            with state_lock:   # duplicate check + insert are atomic
                if load_doc(project, doc_id):
                    return self.send_json({"cached": True, "docId": doc_id})
                for jid, j in ext_jobs.items():
                    if j.get("docId") == doc_id and j.get("project") == project and j["status"] in ACTIVE:
                        return self.send_json({"id": jid, "docId": doc_id})
                jid = uuid.uuid4().hex
                ext_jobs[jid] = dict(status="queued", done=0, total=0, data=data, docId=doc_id,
                                     project=project, name=name, created=time.time())
            ext_q.put(jid)
            return self.send_json({"id": jid, "docId": doc_id})

        if path == "/api/doc/page":
            body = self.read_json()
            project = resolve_project(body.get("project"))
            try:
                n = int(body.get("n"))
            except (TypeError, ValueError):
                raise ApiError(400, "Invalid page number.")
            text = body.get("text")
            if not isinstance(text, str):
                raise ApiError(400, "Invalid page text.")
            with doc_lock:
                doc = load_doc(project, body.get("id"))
                if not doc:
                    raise ApiError(404, "Document not found.")
                page = next((p for p in doc["pages"] if p["n"] == n), None)
                if page is None:
                    raise ApiError(404, "Page not found.")
                page["text"] = text
                save_doc(project, doc)
            return self.send_json({"ok": True})

        if path == "/api/doc/delete":
            body = self.read_json()
            folder = doc_folder(resolve_project(body.get("project")), body.get("id"))
            with doc_lock:
                if os.path.isdir(folder):
                    shutil.rmtree(folder)
            return self.send_json({"ok": True})

        if path == "/api/save_text":
            body = self.read_json()
            project = resolve_project(body.get("project"))
            base = re.sub(r"[^A-Za-z0-9 _.-]", "", str(body.get("filename") or "")).strip(" .")
            base = os.path.splitext(base)[0][:60].strip(" .") or "extracted"
            ext = ".txt" if body.get("format") == "txt" else ".md"
            folder = os.path.join(project_dir(project), "texts")
            os.makedirs(folder, exist_ok=True)
            fname = base + ext
            with open(os.path.join(folder, fname), "w", encoding="utf-8") as fh:
                fh.write(str(body.get("text") or ""))
            return self.send_json({"path": f"projects/{project}/texts/{fname}"})

        raise ApiError(404, "Not found.")


def main():
    for target in (tts_worker, extract_worker):
        threading.Thread(target=target, daemon=True, name=target.__name__).start()
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        sys.exit(f"Port {PORT} is already in use - Vocal Studio is probably already running. "
                 f"Open http://{HOST}:{PORT} or close the other window first.")
    httpd.daemon_threads = True
    url = f"http://{HOST}:{PORT}"
    print(f"Vocal Studio running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()   # only after the port is bound
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Stopping.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
