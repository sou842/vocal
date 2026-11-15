"""Listening check for generated speech.

Voice models occasionally glitch on a sentence: a skipped word, a repeated phrase, babble. After a sentence is
generated we transcribe it with Whisper and compare it with the text it should say. If it differs, the sentence is
generated again (up to a few takes) and the take that matches best is kept.
"""
import contextlib
import io
import os
import re
import threading

import torch

CLEAN = 0.06             # word error at or below this counts as a clean take (no more takes needed)
last_error = None        # why checking was unavailable, if it was (read by the caller to tell the user)

_lock = threading.Lock()
_model = None


def _words(s):
    return re.findall(r"[a-z0-9']+", (s or "").lower().replace("’", "'"))


def word_error(ref, hyp):
    """Word-level edit distance between the intended and the heard text, as a fraction of the intended words."""
    r, h = _words(ref), _words(hyp)
    if not r:
        return 0.0
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hw in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / len(r)


def available():
    try:
        import stable_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def _listen(wav, sr):
    """Transcribe a [1, N] float tensor with Whisper (kept silent: console output can freeze the server)."""
    global _model
    import torchaudio.functional as AF
    x = wav.detach().cpu().float().reshape(-1)
    if sr != 16000:
        x = AF.resample(x, sr, 16000)
    prev = os.environ.get("TQDM_DISABLE")
    os.environ["TQDM_DISABLE"] = "1"
    try:
        with _lock:
            if _model is None:
                import stable_whisper
                _model = stable_whisper.load_model("base", device="cuda" if torch.cuda.is_available() else "cpu")
            with contextlib.redirect_stderr(io.StringIO()):
                res = _model.transcribe(x.numpy(), language="en", verbose=None)
    finally:
        if prev is None:
            os.environ.pop("TQDM_DISABLE", None)
        else:
            os.environ["TQDM_DISABLE"] = prev
    return res.text


def score(wav, sr, text):
    """Lower is better. Word error, plus a penalty when the take is implausibly long or short for its words."""
    err = word_error(text, _listen(wav, sr))
    n = max(1, len(_words(text)))
    per_word = (wav.shape[-1] / sr) / n
    if n >= 3 and not (0.12 <= per_word <= 0.9):
        err += 0.5
    return err


def best_take(generate, polish, chunk, sr, takes):
    """Generate one sentence, listening to each take. Returns (wav, extra_takes_used).

    Stops at the first clean take; otherwise keeps the best of up to `takes`. If checking cannot run
    (e.g. a package is missing) the first take is used and `last_error` says why.
    """
    global last_error
    best, extra = None, 0
    for k in range(max(1, takes)):
        w = polish(generate(chunk), sr)
        if takes <= 1:
            return w, 0
        try:
            err = score(w, sr, chunk)
        except Exception as e:
            last_error = str(e)
            return (best[1] if best else w), extra
        extra = k                    # how many takes beyond the first were needed
        if best is None or err < best[0]:
            best = (err, w)
        if err <= CLEAN:
            break
    return best[1], extra
