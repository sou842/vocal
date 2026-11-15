"""Text -> audio file using Chatterbox TTS (local, CPU or GPU).

Usage:
  python tts.py "Hello world" -o out.wav
  python tts.py -f input.txt -o out.wav
  python tts.py -f input.txt -o out.wav --voice my_voice.wav   # voice cloning
"""
import argparse
import re
import sys
import time

import torch
import torchaudio as ta


def _pack(pieces, max_chars):
    """Greedily join pieces with spaces into chunks no longer than max_chars."""
    chunks, cur = [], ""
    for p in pieces:
        p = p.strip()
        if not p:
            continue
        if cur and len(cur) + 1 + len(p) > max_chars:
            chunks.append(cur)
            cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        chunks.append(cur)
    return chunks


def _split_long(piece, max_chars):
    """Break one over-long piece: at clause punctuation, then at spaces, then hard-cut."""
    if len(piece) <= max_chars:
        return [piece]
    for pattern in (r"(?<=[;:,—])\s+", r"\s+"):
        parts = re.split(pattern, piece)
        if len(parts) > 1:
            out = []
            for chunk in _pack(parts, max_chars):
                out.extend(_split_long(chunk, max_chars) if len(chunk) > max_chars else [chunk])
            return out
    return [piece[i:i + max_chars] for i in range(0, len(piece), max_chars)]


def split_text(text, max_chars=250):
    """Split text into chunks of at most max_chars, preferring sentence and paragraph boundaries.

    Chatterbox works best on short pieces and caps how much it generates per call, so text without
    sentence punctuation (tables, lists, raw PDF text) must still be cut into safe-sized parts.
    """
    pieces = []
    for s in re.split(r"(?<=[.!?…])\s+|\n\s*\n", (text or "").strip()):
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            pieces.extend(_split_long(s, max_chars))
    return _pack(pieces, max_chars)


PAUSE_CLAUSE, PAUSE_SENTENCE, PAUSE_PARAGRAPH = 0.2, 0.5, 1.0   # seconds of silence


def split_story(text, max_chars=150, min_chars=30):
    """Split text for storytelling delivery: one sentence per chunk, each with the pause that should follow it.

    Returns [(chunk, pause_seconds), ...]. Sentences get a short breath, paragraph ends a longer one, and a
    sentence cut in the middle (because it is too long) only a tiny gap. Very short sentences ("Yes.") are
    merged into the next one so they don't sound clipped.
    """
    out = []
    for para in re.split(r"\n\s*\n", (text or "").strip()):
        para = re.sub(r"\s+", " ", para).strip()
        if not para:
            continue
        sents, cur = [], ""
        for s in re.split(r"(?<=[.!?…])\s+", para):
            s = s.strip()
            if not s:
                continue
            if cur and len(cur) < min_chars and len(cur) + 1 + len(s) <= max_chars:
                cur = f"{cur} {s}"
                continue
            if cur:
                sents.append(cur)
            cur = s
        if cur:
            sents.append(cur)
        for si, s in enumerate(sents):
            parts = _split_long(s, max_chars)
            for pi, part in enumerate(parts):
                if pi < len(parts) - 1:
                    pause = PAUSE_CLAUSE
                elif si == len(sents) - 1:
                    pause = PAUSE_PARAGRAPH
                else:
                    pause = PAUSE_SENTENCE + (0.1 if part.rstrip()[-1:] in "?!" else 0.0)
                out.append((part, pause))
    return out


def time_stretch(wav, sr, speed):
    """Gently slow down (speed < 1) a [1, N] float tensor without changing the pitch.

    Uses FFmpeg's rubberband filter (much cleaner on speech than the basic atempo filter). Small changes only:
    below about 0.85x any stretching starts to sound artificial. If rubberband is unavailable the audio is
    returned unchanged rather than degraded.
    """
    if abs(speed - 1.0) < 0.01:
        return wav
    import subprocess
    try:
        import imageio_ffmpeg
        import numpy as np
    except ImportError:
        return wav
    raw = wav.detach().cpu().numpy().astype(np.float32).reshape(-1).tobytes()
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1",
           "-i", "-", "-af", f"rubberband=tempo={speed:.4f}:pitchq=quality", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-"]
    r = subprocess.run(cmd, input=raw, capture_output=True)
    if r.returncode != 0 or not r.stdout:
        return wav
    return torch.from_numpy(np.frombuffer(r.stdout, dtype=np.float32).copy()).unsqueeze(0)


def polish_chunk(wav, sr, target_rms=0.08):
    """Make one generated sentence sit naturally next to the others.

    - trims the model's stray leading/trailing silence (pauses are added back deliberately, with some variation)
    - matches loudness, so sentences don't jump in volume (a giveaway of synthetic speech)
    - tiny fades at the edges, so joins never click
    """
    import numpy as np
    x = wav.detach().cpu().float().numpy().reshape(-1)
    if x.size < sr // 10:
        return wav
    peak = float(np.max(np.abs(x))) or 1.0
    active = np.where(np.abs(x) > 0.02 * peak)[0]
    if active.size:
        lo = max(0, int(active[0]) - int(0.03 * sr))
        hi = min(x.size, int(active[-1]) + int(0.06 * sr))
        x = x[lo:hi]
    voiced = x[np.abs(x) > 0.02 * peak]
    rms = float(np.sqrt(np.mean(voiced ** 2))) if voiced.size else 0.0
    if rms > 1e-5:
        gain = min(max(target_rms / rms, 0.5), 2.0)          # at most about +-6 dB
        x = x * gain
        m = float(np.max(np.abs(x)))
        if m > 0.97:
            x = x * (0.97 / m)
    n = min(int(0.008 * sr), x.size // 2)
    if n > 1:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return torch.from_numpy(x.astype(np.float32)).unsqueeze(0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("text", nargs="?", help="text to speak")
    p.add_argument("-f", "--file", help="read text from this file (UTF-8)")
    p.add_argument("-o", "--out", default="output.wav")
    p.add_argument("--voice", help="reference .wav (~10s) to clone the voice")
    p.add_argument("--exaggeration", type=float, default=0.5)
    p.add_argument("--cfg", type=float, default=0.5)
    a = p.parse_args()

    if a.file:
        text = open(a.file, encoding="utf-8").read()
    elif a.text:
        text = a.text
    else:
        sys.exit("Provide text or -f file")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    from chatterbox.tts import ChatterboxTTS

    t0 = time.time()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"Model loaded in {time.time() - t0:.1f}s")

    chunks = split_text(text)
    wavs = []
    t1 = time.time()
    for i, c in enumerate(chunks, 1):
        print(f"[{i}/{len(chunks)}] {c[:60]}...")
        wavs.append(
            model.generate(
                c,
                audio_prompt_path=a.voice,
                exaggeration=a.exaggeration,
                cfg_weight=a.cfg,
            )
        )
    wav = torch.cat(wavs, dim=-1)
    ta.save(a.out, wav, model.sr)
    dur = wav.shape[-1] / model.sr
    el = time.time() - t1
    print(f"Saved {a.out}: {dur:.1f}s audio in {el:.1f}s (RTF {el / dur:.1f}x)")


if __name__ == "__main__":
    main()
