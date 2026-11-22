"""Basic video editing: join clips in order, with trims and transitions (FFmpeg).

A *timeline* is plain JSON:
  {"clips": [{"file", "start", "end", "join", "join_len", "volume"}, ...], "fade_in": bool, "fade_out": bool, "fade_len": s,
   "audio": [{"src", "file", "at", "start", "end", "volume", "fade_in", "fade_out"}, ...]}
`start`/`end` trim a clip (seconds, end = 0 or missing means "until the end"). `join` says how a clip enters from the
one before it: "cut", "fade" (crossfade) or "dip" (through black); `join_len` is the transition length in seconds.
`volume` is the clip's own sound (1 = unchanged, 0 = muted, up to 2). `audio` is the extra audio track: pieces of narration
("project") or music ("music") placed at timeline time `at`, trimmed with start/end, with a volume and fades. Audio is mixed
over the video's own sound and cut off where the video ends.
"""
import os
import re
import subprocess
import tempfile
import threading

W, H, FPS = 1920, 1080, 30
MAX_CLIPS = 300
JOINS = {"cut": None, "fade": "fade", "dip": "fadeblack"}   # join -> FFmpeg xfade transition
MIN_JOIN, MIN_CLIP = 0.1, 0.2
MAX_AUDIO, MAX_VOLUME = 60, 2.0
AUDIO_SOURCES = ("project", "music")

_dur_lock = threading.Lock()
_dur_cache = {}   # (path, mtime, size) -> seconds


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
    except ImportError:
        raise RuntimeError("Editing needs the video packages. Run:  .venv\\Scripts\\python.exe -m pip install "
                           "stable-ts imageio-ffmpeg soundfile pillow")
    return imageio_ffmpeg.get_ffmpeg_exe()


def _probe(path):
    """{'dur': seconds or None, 'mono': bool} for a media file. Cached until the file changes."""
    try:
        st = os.stat(path)
    except OSError:
        return {"dur": None, "mono": False}
    key = (path, st.st_mtime_ns, st.st_size)
    with _dur_lock:
        if key in _dur_cache:
            return _dur_cache[key]
    try:
        out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=30).stderr
    except (OSError, subprocess.SubprocessError):
        return {"dur": None, "mono": False}
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    info = {"dur": int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None,
            "mono": bool(re.search(r"Audio:.*, mono", out))}   # "." stays on the stream line
    with _dur_lock:
        _dur_cache[key] = info
    return info


def probe_duration(path):
    """Length of a media file in seconds (None if unreadable)."""
    return _probe(path)["dur"]


def is_mono(path):
    return _probe(path)["mono"]


def _num(v, default=0.0):
    try:
        n = float(v)
        return n if n == n and abs(n) != float("inf") else default
    except (TypeError, ValueError):
        return default


def _volume(v):
    return min(max(_num(v, 1.0), 0.0), MAX_VOLUME)


def clean_timeline(tl):
    """Shape-only clean-up of a timeline that came from the browser (safe to store; files are not checked here)."""
    tl = tl if isinstance(tl, dict) else {}
    clips = []
    for c in (tl.get("clips") if isinstance(tl.get("clips"), list) else [])[:MAX_CLIPS]:
        if not isinstance(c, dict) or not isinstance(c.get("file"), str):
            continue
        clips.append({"file": os.path.basename(c["file"]), "start": max(0.0, _num(c.get("start"))),
                      "end": max(0.0, _num(c.get("end"))),
                      "join": c.get("join") if c.get("join") in JOINS else "cut",
                      "join_len": min(max(_num(c.get("join_len"), 0.8), MIN_JOIN), 5.0),
                      "volume": _volume(c.get("volume"))})
    audio = []
    for a in (tl.get("audio") if isinstance(tl.get("audio"), list) else [])[:MAX_AUDIO]:
        if not isinstance(a, dict) or not isinstance(a.get("file"), str) or a.get("src") not in AUDIO_SOURCES:
            continue
        audio.append({"src": a["src"], "file": os.path.basename(a["file"]), "at": max(0.0, _num(a.get("at"))),
                      "start": max(0.0, _num(a.get("start"))), "end": max(0.0, _num(a.get("end"))),
                      "volume": _volume(a.get("volume")),
                      "fade_in": min(max(_num(a.get("fade_in")), 0.0), 30.0), "fade_out": min(max(_num(a.get("fade_out")), 0.0), 30.0)})
    return {"clips": clips, "fade_in": bool(tl.get("fade_in")), "fade_out": bool(tl.get("fade_out")),
            "fade_len": min(max(_num(tl.get("fade_len"), 1.0), 0.2), 5.0), "audio": audio}


def plan(tl, duration_of, audio_duration_of=None):
    """Check a timeline against the real files. `duration_of(file)` returns seconds or None (missing/unreadable);
    `audio_duration_of(src, file)` does the same for audio-track files.
    Returns {"segs": [...], "audio": [...], "total": seconds, "fade_in", "fade_out", "fade_len", "fast": bool}; raises ValueError."""
    tl = clean_timeline(tl)
    if not tl["clips"]:
        raise ValueError("Add at least one clip to the timeline.")
    segs = []
    for i, c in enumerate(tl["clips"]):
        dur = duration_of(c["file"])
        if not dur:
            raise ValueError(f'Clip "{c["file"]}" was not found or cannot be read.')
        start = min(c["start"], max(dur - MIN_CLIP, 0.0))
        end = dur if c["end"] <= 0 else min(c["end"], dur)
        if end - start < MIN_CLIP:
            raise ValueError(f'Clip "{c["file"]}" is trimmed too short (start {c["start"]:.1f}s, end {end:.1f}s).')
        segs.append({"file": c["file"], "start": start, "end": end, "len": end - start, "dur": dur,
                     "trimmed": start > 0.05 or end < dur - 0.05, "join": c["join"] if i else "cut",
                     "join_len": c["join_len"], "volume": c["volume"]})
    for i in range(1, len(segs)):   # a transition cannot be longer than the clips on either side of it
        s = segs[i]
        if s["join"] != "cut":
            s["join_len"] = min(s["join_len"], 0.45 * min(segs[i - 1]["len"], s["len"]))
            if s["join_len"] < MIN_JOIN:
                s["join"] = "cut"
    total = sum(s["len"] for s in segs) - sum(s["join_len"] for s in segs if s["join"] != "cut")
    fade_len = min(tl["fade_len"], total / 2)

    # audio track: `at` is on the editor's timeline (clips back to back); in the exported video the transitions overlap,
    # so an item starts where the same moment of the picture is: its `at` minus the overlaps of the clips up to there
    starts, t = [], 0.0
    for s_ in segs:
        starts.append(t)
        t += s_["len"]
    overlap_upto, acc = [], 0.0
    for s_ in segs:
        acc += s_["join_len"] if s_["join"] != "cut" else 0.0
        overlap_upto.append(acc)
    audio = []
    for a in tl["audio"]:
        dur = audio_duration_of(a["src"], a["file"]) if audio_duration_of else None
        if not dur:
            raise ValueError(f'Audio "{a["file"]}" was not found or cannot be read.')
        a_start = min(a["start"], max(dur - MIN_CLIP, 0.0))
        a_end = dur if a["end"] <= 0 else min(a["end"], dur)
        if a_end - a_start < MIN_CLIP:
            raise ValueError(f'Audio "{a["file"]}" is trimmed too short.')
        k = max([i for i, st in enumerate(starts) if st <= a["at"]] or [0])
        at_export = max(a["at"] - overlap_upto[k], 0.0)
        if at_export >= total - 0.05:
            continue   # starts after the video has ended: nothing to hear
        a_len = min(a_end - a_start, total - at_export)
        audio.append({"src": a["src"], "file": a["file"], "at": at_export, "start": a_start, "len": a_len,
                      "volume": a["volume"], "fade_in": min(a["fade_in"], a_len), "fade_out": min(a["fade_out"], a_len)})
    fast = (not tl["fade_in"] and not tl["fade_out"] and not audio
            and all(s["join"] == "cut" and not s["trimmed"] and abs(s["volume"] - 1) < 0.01 for s in segs))
    return {"segs": segs, "audio": audio, "total": total, "fade_in": tl["fade_in"], "fade_out": tl["fade_out"],
            "fade_len": fade_len, "fast": fast}


def _filter_graph(p):
    """FFmpeg filter_complex text that trims, normalises, joins and fades the clips. Returns (text, v_label, a_label)."""
    lines = []
    for i, s in enumerate(p["segs"]):
        lines.append(f"[{i}:v]setpts=PTS-STARTPTS,fps={FPS},scale={W}:{H},setsar=1,format=yuv420p[v{i}]")
        vol = f",volume={s['volume']:.3f}" if abs(s["volume"] - 1) >= 0.01 else ""
        up = "pan=stereo|c0=c0|c1=c0," if s.get("mono") else ""
        lines.append(f"[{i}:a]asetpts=PTS-STARTPTS,aresample=44100,{up}aformat=sample_fmts=fltp:channel_layouts=stereo{vol}[a{i}]")
    cv, ca, cur = "v0", "a0", p["segs"][0]["len"]
    for i in range(1, len(p["segs"])):
        s = p["segs"][i]
        nv, na = f"jv{i}", f"ja{i}"
        if s["join"] == "cut":
            lines.append(f"[{cv}][{ca}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]")
            cur += s["len"]
        else:
            d = s["join_len"]
            lines.append(f"[{cv}][v{i}]xfade=transition={JOINS[s['join']]}:duration={d:.3f}:offset={cur - d:.3f}[{nv}]")
            lines.append(f"[{ca}][a{i}]acrossfade=d={d:.3f}[{na}]")
            cur += s["len"] - d
        cv, ca = nv, na
    n = len(p["segs"])
    if p["audio"]:   # the audio track: each piece trimmed, set to its volume, faded and delayed to its place, then mixed in
        labels = []
        for k, a in enumerate(p["audio"]):
            up = "pan=stereo|c0=c0|c1=c0," if a.get("mono") else ""
            chain = f"[{n + k}:a]asetpts=PTS-STARTPTS,aresample=44100,{up}aformat=sample_fmts=fltp:channel_layouts=stereo"
            if abs(a["volume"] - 1) >= 0.01:
                chain += f",volume={a['volume']:.3f}"
            if a["fade_in"] > 0.01:
                chain += f",afade=t=in:st=0:d={a['fade_in']:.3f}"
            if a["fade_out"] > 0.01:
                chain += f",afade=t=out:st={max(a['len'] - a['fade_out'], 0):.3f}:d={a['fade_out']:.3f}"
            ms = int(round(a["at"] * 1000))
            if ms > 0:
                chain += f",adelay={ms}|{ms}"
            lines.append(chain + f"[m{k}]")
            labels.append(f"[m{k}]")
        # the video's own sound decides the length, so music never runs past the end; the limiter stops clipping
        lines.append(f"[{ca}]" + "".join(labels) + f"amix=inputs={1 + len(labels)}:duration=first:normalize=0,alimiter=limit=0.97[mix]")
        ca = "mix"
    f = p["fade_len"]
    if p["fade_in"]:
        lines.append(f"[{cv}]fade=t=in:st=0:d={f:.3f}[fiv]")
        lines.append(f"[{ca}]afade=t=in:st=0:d={f:.3f}[fia]")
        cv, ca = "fiv", "fia"
    if p["fade_out"]:
        lines.append(f"[{cv}]fade=t=out:st={max(cur - f, 0):.3f}:d={f:.3f}[fov]")
        lines.append(f"[{ca}]afade=t=out:st={max(cur - f, 0):.3f}:d={f:.3f}[foa]")
        cv, ca = "fov", "foa"
    return ";\n".join(lines), cv, ca


def export(p, path_of, out_path, on_progress=None, audio_path_of=None):
    """Write the joined video to out_path. `p` comes from plan(); `path_of(file)` gives each clip's full path.
    Clips that need no re-encoding are joined by copying (fast, lossless)."""
    exe = ffmpeg_exe()
    tmp = out_path + ".part.mp4"
    scratch = tempfile.mkdtemp(prefix="vocal_edit_")
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    try:
        if p["fast"]:
            lst = os.path.join(scratch, "list.txt")
            with open(lst, "w", encoding="utf-8") as fh:
                for s in p["segs"]:
                    fh.write("file '" + path_of(s["file"]).replace("\\", "/").replace("'", "'\\''") + "'\n")
            cmd += ["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", tmp]
        else:
            for s in p["segs"]:
                cmd += ["-ss", f"{s['start']:.3f}", "-t", f"{s['len']:.3f}", "-i", path_of(s["file"])]
            for s_ in p["segs"]:
                s_["mono"] = is_mono(path_of(s_["file"]))
            for a in p["audio"]:
                a["mono"] = is_mono(audio_path_of(a["src"], a["file"]))
                cmd += ["-ss", f"{a['start']:.3f}", "-t", f"{a['len']:.3f}", "-i", audio_path_of(a["src"], a["file"])]
            graph, cv, ca = _filter_graph(p)
            gpath = os.path.join(scratch, "graph.txt")   # a script file: hundreds of clips will not fit on a command line
            with open(gpath, "w", encoding="utf-8") as fh:
                fh.write(graph)
            cmd += ["-/filter_complex", gpath, "-map", f"[{cv}]", "-map", f"[{ca}]", "-c:v", "libx264", "-preset", "medium",
                    "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]
        errlog = os.path.join(scratch, "err.txt")
        with open(errlog, "w") as err:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                for line in proc.stdout:
                    m = re.match(r"out_time_(?:us|ms)=(\d+)", line)   # both are microseconds in practice
                    if m and on_progress:
                        on_progress(min(int(m.group(1)) / 1e6, p["total"]), p["total"])
                code = proc.wait()
            except BaseException:
                proc.kill()
                raise
        if code != 0:
            with open(errlog, encoding="utf-8", errors="replace") as fh:
                tail = " ".join(fh.read().strip().splitlines()[-3:])
            raise RuntimeError("FFmpeg could not join the clips." + (f" ({tail[:300]})" if tail else ""))
        os.replace(tmp, out_path)
        if on_progress:
            on_progress(p["total"], p["total"])
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
        for f in os.listdir(scratch):
            try:
                os.remove(os.path.join(scratch, f))
            except OSError:
                pass
        try:
            os.rmdir(scratch)
        except OSError:
            pass


STRIP_FRAMES, STRIP_W, STRIP_H = 10, 160, 90


def make_strip(path, out_path):
    """One JPEG with STRIP_FRAMES evenly spaced frames side by side (the timeline's filmstrip for a clip).
    Each frame is read by seeking, so even a very long video takes about a second."""
    secs = probe_duration(path)
    if not secs:
        raise ValueError("The video cannot be read.")
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error"]
    for k in range(STRIP_FRAMES):
        cmd += ["-ss", f"{secs * (k + 0.5) / STRIP_FRAMES:.3f}", "-i", path]
    graph = ";".join(f"[{k}:v]scale={STRIP_W}:{STRIP_H}:force_original_aspect_ratio=increase,crop={STRIP_W}:{STRIP_H}[s{k}]"
                     for k in range(STRIP_FRAMES))
    graph += ";" + "".join(f"[s{k}]" for k in range(STRIP_FRAMES)) + f"hstack=inputs={STRIP_FRAMES}[o]"
    tmp = out_path + ".tmp.jpg"
    cmd += ["-filter_complex", graph, "-map", "[o]", "-frames:v", "1", "-q:v", "6", tmp]
    done = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if done.returncode != 0 or not os.path.isfile(tmp):
        raise RuntimeError("Could not make the thumbnails. " + done.stderr.strip()[-200:])
    os.replace(tmp, out_path)


def make_wave(path, out_path, w=1600, h=64):
    """A PNG of an audio file's waveform (white on black; the page shows it tinted). Reads the whole file once."""
    tmp = out_path + ".tmp.png"
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", path, "-filter_complex",
           f"aformat=channel_layouts=mono,showwavespic=s={w}x{h}:colors=white:scale=sqrt", "-frames:v", "1", tmp]
    done = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    if done.returncode != 0 or not os.path.isfile(tmp):
        raise RuntimeError("Could not draw the waveform. " + done.stderr.strip()[-200:])
    os.replace(tmp, out_path)
