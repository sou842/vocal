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
