"""Saved reference voices ("narrators"). A short clean clip is cleaned up once and kept, so every generation can use it.

Stored under ./voices/library/<id>.wav + <id>.json (git-ignored: this is the user's own recordings).
"""
import io
import json
import os
import re
import time
import uuid

import numpy as np
import soundfile as sf

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices", "library")
MIN_SECONDS, MAX_SECONDS = 4.0, 20.0
ID_RE = re.compile(r"[a-f0-9]{12}")


def _paths(vid):
    return os.path.join(LIB, vid + ".wav"), os.path.join(LIB, vid + ".json")


def clean_clip(wav_bytes):
    """Mono, trim silence at the ends, level the volume, keep at most MAX_SECONDS. Returns (wav bytes, seconds)."""
    try:
        data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
    except Exception:
        raise ValueError("That file could not be read as a .wav.")
    x = data.mean(axis=1)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak < 1e-4:
        raise ValueError("The clip is silent.")
    active = np.where(np.abs(x) > 0.02 * peak)[0]
    lo = max(0, int(active[0]) - int(0.15 * sr))
    hi = min(x.size, int(active[-1]) + int(0.25 * sr))
    x = x[lo:hi][: int(MAX_SECONDS * sr)]
    seconds = x.size / sr
    if seconds < MIN_SECONDS:
        raise ValueError(f"The clip is too short ({seconds:.1f}s of speech). Use at least {MIN_SECONDS:.0f} seconds; 6-10 is ideal.")
    voiced = x[np.abs(x) > 0.02 * peak]
    rms = float(np.sqrt(np.mean(voiced ** 2)))
    x = x * min(max(0.08 / rms, 0.25), 4.0)
    m = float(np.max(np.abs(x)))
    if m > 0.95:
        x = x * (0.95 / m)
    buf = io.BytesIO()
    sf.write(buf, x.astype(np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue(), seconds


def list_voices():
    out = []
    if os.path.isdir(LIB):
        for f in os.listdir(LIB):
            if f.endswith(".json") and ID_RE.fullmatch(f[:-5]):
                try:
                    with open(os.path.join(LIB, f), encoding="utf-8") as fh:
                        m = json.load(fh)
                    if os.path.isfile(_paths(f[:-5])[0]):
                        out.append({"id": f[:-5], "name": m.get("name", "Voice"), "seconds": m.get("seconds"),
                                    "created": m.get("created", 0)})
                except (OSError, ValueError):
                    pass
    return sorted(out, key=lambda v: v["created"])


def voice_path(vid):
    """Path of a saved voice's wav, or None if it doesn't exist."""
    if not ID_RE.fullmatch(vid or ""):
        return None
    p = _paths(vid)[0]
    return p if os.path.isfile(p) else None


def add_voice(name, wav_bytes):
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:40] or "Voice"
    cleaned, seconds = clean_clip(wav_bytes)
    os.makedirs(LIB, exist_ok=True)
    vid = uuid.uuid4().hex[:12]
    wp, jp = _paths(vid)
    with open(wp, "wb") as fh:
        fh.write(cleaned)
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump({"name": name, "seconds": round(seconds, 1), "created": time.time()}, fh)
    return {"id": vid, "name": name, "seconds": round(seconds, 1)}


def delete_voice(vid):
    if not ID_RE.fullmatch(vid or ""):
        return False
    ok = False
    for p in _paths(vid):
        try:
            os.remove(p)
            ok = True
        except OSError:
            pass
    return ok
