"""Shared video pipeline: word alignment, style registry and the FFmpeg render loop.

A *style* is one class in video/styles/<name>.py, decorated with @register. It receives the aligned words and
returns a PIL image for any time t; everything else (alignment, encoding, progress) is handled here.
"""
import contextlib
import io
import os
import subprocess
import threading

W, H, FPS = 1920, 1080, 30
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

STYLES = {}


class Style:
    """Base class for a video style. Subclass, set the class attributes, implement frame(), and @register it."""
    id = ""                   # short unique slug, e.g. "split_reader"
    name = ""                 # shown on the style card
    description = ""
    preview = ""              # file name inside video/assets/previews/
    options = []              # extra inputs, e.g. [{"key": "image", "type": "image", "label": "...", "hint": "..."}]

    def __init__(self, words, duration, options):
        """words: [{"w", "start", "end"}], duration: seconds, options: {key: value} (image options are file paths)."""
        self.words, self.duration, self.options_in = words, duration, options

    def frame(self, t):
        """Return the PIL.Image (RGB, W x H) for time t in seconds."""
        raise NotImplementedError


def register(cls):
    if not cls.id or cls.id in STYLES:
        raise ValueError(f"Bad or duplicate style id: {cls.id!r}")
    STYLES[cls.id] = cls
    return cls


def list_styles():
    return [{"id": c.id, "name": c.name, "description": c.description, "options": c.options,
             "preview": f"/api/video/styles/{c.id}/preview.png" if c.preview else None}
            for c in STYLES.values()]


def preview_path(style_id):
    cls = STYLES.get(style_id)
    if not cls or not cls.preview:
        return None
    p = os.path.join(ASSETS, "previews", os.path.basename(cls.preview))
    return p if os.path.isfile(p) else None


MISSING_DEPS = ("Video creation needs extra packages. Run:  .venv\\Scripts\\python.exe -m pip install "
                "stable-ts imageio-ffmpeg soundfile pillow")
_model_lock = threading.Lock()
_models = {}   # (name, device) -> loaded Whisper model, kept so later videos skip the load


def _alignment_model(name, device):
    import stable_whisper
    with _model_lock:
        if (name, device) not in _models:
            _models.clear()   # keep at most one model in memory
            _models[(name, device)] = stable_whisper.load_model(name, device=device)
        return _models[(name, device)]


def align_words(audio_path, text, model_name="base", on_status=None, on_align_progress=None):
    """Forced alignment of the known text to the audio (stable-ts / Whisper). Returns (words, duration)."""
    try:
        import soundfile as sf
        import stable_whisper  # noqa: F401
        import torch
        import torchaudio.functional as AF
    except ImportError:
        raise RuntimeError(MISSING_DEPS)
    data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
    mono = torch.from_numpy(data.mean(axis=1))
    audio16k = AF.resample(mono, sr, 16000).numpy() if sr != 16000 else mono.numpy()
    if on_status:
        on_status("loading alignment model")
    model = _alignment_model(model_name, "cuda" if torch.cuda.is_available() else "cpu")
    if on_status:
        on_status("aligning")
    def _progress(*a):   # stable-ts calls this with (seconds done, total seconds)
        if on_align_progress and len(a) >= 2 and a[1]:
            on_align_progress(float(a[0]), float(a[1]))

    # verbose=None: print nothing. A progress bar on a Windows console can freeze the whole server if the
    # console window is clicked (QuickEdit), so nothing is written while aligning.
    prev = os.environ.get("TQDM_DISABLE")
    os.environ["TQDM_DISABLE"] = "1"   # silences every progress bar the library still draws
    try:
        with contextlib.redirect_stderr(io.StringIO()):   # some bars ignore the switch above
            result = model.align(audio16k, text, language="en", verbose=None, progress_callback=_progress)
    finally:
        if prev is None:
            os.environ.pop("TQDM_DISABLE", None)
        else:
            os.environ["TQDM_DISABLE"] = prev
    words = [{"w": w.word.strip(), "start": round(float(w.start), 3), "end": round(float(w.end), 3)}
             for seg in result.segments for w in seg.words if w.word.strip()]
    if not words:
        raise ValueError("Could not align the text to the audio. Check that the text matches what was spoken.")
    return words, len(data) / sr


def render(style_id, audio_path, words, duration, out_path, options=None, on_progress=None):
    """Render the video: style frames piped into FFmpeg together with the audio."""
    try:
        import imageio_ffmpeg
    except ImportError:
        raise RuntimeError(MISSING_DEPS)
    style = STYLES[style_id](words, duration, options or {})
    tmp = out_path + ".part.mp4"
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", audio_path, "-c:v", "libx264", "-preset", "medium",
           "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
           "-movflags", "+faststart", tmp]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = int(duration * FPS) + 1
    try:
        for f in range(n):
            proc.stdin.write(style.frame(f / FPS).convert("RGB").tobytes())
            if on_progress and f % 5 == 0:
                on_progress(f, n)
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("FFmpeg failed while encoding the video.")
        os.replace(tmp, out_path)
    except BaseException:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    if on_progress:
        on_progress(n, n)


def make_video(style_id, audio_path, text, out_path, options=None, on_status=None, on_progress=None,
               on_align_progress=None):
    """Convenience: align + render. Returns the duration in seconds."""
    if style_id not in STYLES:
        raise ValueError(f"Unknown video style: {style_id}")
    words, duration = align_words(audio_path, text, on_status=on_status, on_align_progress=on_align_progress)
    if on_status:
        on_status("rendering")
    render(style_id, audio_path, words, duration, out_path, options, on_progress)
    return duration


_SAMPLE = ("The old lighthouse stood alone on the cliff, watching the grey sea. Every night, its light swept across the "
           "water and guided the fishermen safely home. Nobody remembered who had built it. Some said it was older than "
           "the village itself, and that it would outlast them all.")


def preview_frame(style_id, options, text=None):
    """One still frame of a style with the given options, for the live preview. Uses the start of `text` (or sample
    text) with made-up word timings, shown a little into the second sentence so every text colour is visible."""
    words, t = [], 0.6
    for w in (text or "").split()[:70] or _SAMPLE.split():
        d = 0.18 + 0.03 * len(w)
        words.append({"w": w, "start": round(t, 3), "end": round(t + d, 3)})
        t += d + (0.35 if w[-1] in ".!?" else 0.03)
    style = STYLES[style_id](words, t + 2, options or {})
    sent_ends = [i for i, w in enumerate(words) if w["w"][-1] in ".!?"]
    k = (sent_ends[0] + 1 + 3) if sent_ends and sent_ends[0] + 4 < len(words) else min(4, len(words) - 1)
    return style.frame((words[k]["start"] + words[k]["end"]) / 2).convert("RGB")
