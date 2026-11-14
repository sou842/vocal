"""Vocal Studio GPU worker — runs Chatterbox TTS on a GPU machine (Google Colab, or any Linux/Windows box)
and serves it over HTTP so the Vocal Studio app on your laptop can use the GPU.

Usage (Colab does this for you in vocal_worker.ipynb):
    python worker.py --tunnel            # GPU worker + public Cloudflare quick-tunnel URL
    python worker.py --port 8001         # local only (no tunnel), e.g. for testing

Every request must carry  Authorization: Bearer <key>.  The key is printed at startup
(random each run, or set VOCAL_KEY in the environment / --key to keep it fixed).

API (all JSON errors look like {"error": "..."}):
    GET  /health                 -> {"ok", "version", "device", "gpu", "sample_rate"}
    POST /voice   (audio/wav)    -> {"voice_id"}     upload a voice sample once per job
    POST /generate (JSON)        -> audio/wav bytes  {"text", "exaggeration", "cfg", "voice_id"?}
"""
import argparse
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
MAX_JSON = 1 * 1024 * 1024
MAX_VOICE = 25 * 1024 * 1024
MAX_TEXT = 2000                       # per request; the app sends ~150-character parts
VOICE_DIR = os.path.join(tempfile.gettempdir(), "vocal_worker_voices")

KEY = ""
model = None
model_sr = 24000
device = "cpu"
gpu_name = None
gen_lock = threading.Lock()           # one generation at a time on the GPU


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def load_model():
    global model, model_sr, device, gpu_name
    import torch
    from chatterbox.tts import ChatterboxTTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if device == "cuda" else None
    log(f"Loading Chatterbox on {device}" + (f" ({gpu_name})" if gpu_name else "") + " ...")
    t = time.time()
    model = ChatterboxTTS.from_pretrained(device=device)
    model_sr = model.sr
    log(f"Model ready in {time.time() - t:.0f}s")
    if device == "cpu":
        log("WARNING: no GPU found. In Colab: Runtime > Change runtime type > T4 GPU, then run again.")


def wav_bytes(tensor, sr):
    """Float tensor [1, N] in [-1, 1]  ->  16-bit PCM mono WAV bytes (half the size of float32)."""
    import numpy as np
    data = tensor.detach().cpu().numpy().reshape(-1)
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm)
    return buf.getvalue()


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = "VocalWorker/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(status, json.dumps(obj).encode(), "application/json")

    def check_auth(self):
        got = self.headers.get("Authorization", "")
        if not (got.startswith("Bearer ") and hmac.compare_digest(got[7:].strip().encode(), KEY.encode())):
            raise ApiError(401, "Wrong or missing access key.")

    def read_body(self, limit):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise ApiError(411, "Content-Length required.")
        if length < 0 or length > limit:
            raise ApiError(413, "Request too large.")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ApiError(400, "Request body ended early.")
        return data

    def run(self, fn):
        try:
            self.check_auth()
            fn()
        except ApiError as e:
            self.close_connection = True
            self.send_json({"error": e.message}, e.status)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as e:
            self.close_connection = True
            log(f"ERROR {self.command} {self.path}: {e!r}")
            try:
                self.send_json({"error": f"Worker error: {e}"}, 500)
            except OSError:
                pass

    def do_GET(self):
        self.run(self.route_get)

    def do_POST(self):
        self.run(self.route_post)

    def route_get(self):
        if self.path.split("?")[0] == "/health":
            return self.send_json({"ok": model is not None, "version": VERSION, "device": device,
                                   "gpu": gpu_name, "sample_rate": model_sr})
        raise ApiError(404, "Not found.")

    def route_post(self):
        path = self.path.split("?")[0]
        if path == "/voice":
            data = self.read_body(MAX_VOICE)
            if not (data[:4] == b"RIFF" and data[8:12] == b"WAVE"):
                raise ApiError(400, "The voice sample must be a .wav file.")
            voice_id = hashlib.sha256(data).hexdigest()[:16]
            os.makedirs(VOICE_DIR, exist_ok=True)
            fpath = os.path.join(VOICE_DIR, voice_id + ".wav")
            if not os.path.isfile(fpath):
                with open(fpath, "wb") as fh:
                    fh.write(data)
            log(f"voice sample received ({len(data) // 1024} KB)")
            return self.send_json({"voice_id": voice_id})

        if path == "/generate":
            try:
                body = json.loads(self.read_body(MAX_JSON) or b"{}")
            except ValueError:
                raise ApiError(400, "Invalid JSON.")
            if not isinstance(body, dict):
                raise ApiError(400, "Expected a JSON object.")
            text = str(body.get("text") or "").strip()
            if not text:
                raise ApiError(400, "Empty text.")
            if len(text) > MAX_TEXT:
                raise ApiError(413, f"Text too long for one request (max {MAX_TEXT} characters).")
            try:
                exaggeration = min(2.0, max(0.25, float(body.get("exaggeration", 0.5))))
                cfg = min(1.0, max(0.0, float(body.get("cfg", 0.5))))
            except (TypeError, ValueError):
                raise ApiError(400, "Invalid voice settings.")
            voice_path = None
            if body.get("voice_id"):
                voice_id = re.sub(r"[^a-f0-9]", "", str(body["voice_id"]))[:16]
                voice_path = os.path.join(VOICE_DIR, voice_id + ".wav")
                if not voice_id or not os.path.isfile(voice_path):
                    raise ApiError(409, "Unknown voice sample; upload it again.")
            if model is None:
                raise ApiError(503, "The model is still loading.")
            t = time.time()
            with gen_lock:
                wav = model.generate(text, audio_prompt_path=voice_path, exaggeration=exaggeration, cfg_weight=cfg)
            took = time.time() - t
            audio = wav_bytes(wav, model_sr)
            secs = wav.shape[-1] / model_sr
            log(f"generated {len(text):4d} chars -> {secs:5.1f}s audio in {took:4.1f}s")
            return self.send_bytes(200, audio, "audio/wav", {"X-Sample-Rate": model_sr, "X-Gen-Seconds": f"{took:.2f}"})

        raise ApiError(404, "Not found.")


def find_cloudflared():
    for c in ("./cloudflared", "cloudflared", "cloudflared.exe"):
        p = shutil.which(c) or (c if os.path.isfile(c) else None)
        if p:
            return p
    return None


def start_tunnel(port):
    """Start a Cloudflare quick tunnel and return its public https URL (or None)."""
    exe = find_cloudflared()
    if not exe:
        log("cloudflared not found - cannot create a public URL.")
        return None
    proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    found = {}
    ready = threading.Event()

    def reader():
        for line in proc.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and "url" not in found:
                found["url"] = m.group(0)
                ready.set()
    threading.Thread(target=reader, daemon=True).start()
    ready.wait(60)
    return found.get("url")


def main():
    global KEY
    ap = argparse.ArgumentParser(description="Vocal Studio GPU worker")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--tunnel", action="store_true", help="expose via a Cloudflare quick tunnel")
    ap.add_argument("--key", default=os.environ.get("VOCAL_KEY", ""), help="access key (default: random)")
    args = ap.parse_args()
    KEY = args.key.strip() or secrets.token_urlsafe(24)

    load_model()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = f"http://{args.host}:{args.port}"
    if args.tunnel:
        log("Starting Cloudflare tunnel ...")
        url = start_tunnel(args.port)
        if not url:
            sys.exit("Could not start the Cloudflare tunnel. Run the cell again.")

    bar = "=" * 72
    print(f"\n{bar}\n  Vocal Studio GPU worker is READY  ({device}" + (f", {gpu_name}" if gpu_name else "") + ")\n")
    print(f"  Address :  {url}")
    print(f"  Key     :  {KEY}\n")
    print("  In Vocal Studio: Settings -> Speech engine -> Colab GPU -> paste both -> Test connection")
    print(f"  Keep this cell running. Stop it (or close the tab) to shut the worker down.\n{bar}\n", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        log("Stopping.")


if __name__ == "__main__":
    main()
