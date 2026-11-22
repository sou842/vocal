"""Basic video editing: join clips in order, with trims and transitions (FFmpeg).

A *timeline* is plain JSON:
  {"clips": [{"file", "start", "end", "join", "join_len"}, ...], "fade_in": bool, "fade_out": bool, "fade_len": s}
`start`/`end` trim a clip (seconds, end = 0 or missing means "until the end"). `join` says how a clip enters from the
one before it: "cut", "fade" (crossfade) or "dip" (through black); `join_len` is the transition length in seconds.
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

_dur_lock = threading.Lock()
_dur_cache = {}   # (path, mtime, size) -> seconds


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
    except ImportError:
        raise RuntimeError("Editing needs the video packages. Run:  .venv\\Scripts\\python.exe -m pip install "
                           "stable-ts imageio-ffmpeg soundfile pillow")
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(path):
    """Length of a media file in seconds (None if unreadable). Cached until the file changes."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime_ns, st.st_size)
    with _dur_lock:
        if key in _dur_cache:
            return _dur_cache[key]
    try:
        out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=30).stderr
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    with _dur_lock:
        _dur_cache[key] = secs
    return secs


def _num(v, default=0.0):
    try:
        n = float(v)
        return n if n == n and abs(n) != float("inf") else default
    except (TypeError, ValueError):
        return default


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
                      "join_len": min(max(_num(c.get("join_len"), 0.8), MIN_JOIN), 5.0)})
    return {"clips": clips, "fade_in": bool(tl.get("fade_in")), "fade_out": bool(tl.get("fade_out")),
            "fade_len": min(max(_num(tl.get("fade_len"), 1.0), 0.2), 5.0)}


def plan(tl, duration_of):
    """Check a timeline against the real files. `duration_of(file)` returns seconds or None (missing/unreadable).
    Returns {"segs": [...], "total": seconds, "fade_in", "fade_out", "fade_len", "fast": bool}; raises ValueError."""
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
                     "join_len": c["join_len"]})
    for i in range(1, len(segs)):   # a transition cannot be longer than the clips on either side of it
        s = segs[i]
        if s["join"] != "cut":
            s["join_len"] = min(s["join_len"], 0.45 * min(segs[i - 1]["len"], s["len"]))
            if s["join_len"] < MIN_JOIN:
                s["join"] = "cut"
    total = sum(s["len"] for s in segs) - sum(s["join_len"] for s in segs if s["join"] != "cut")
    fade_len = min(tl["fade_len"], total / 2)
    fast = (not tl["fade_in"] and not tl["fade_out"]
            and all(s["join"] == "cut" and not s["trimmed"] for s in segs))
    return {"segs": segs, "total": total, "fade_in": tl["fade_in"], "fade_out": tl["fade_out"],
            "fade_len": fade_len, "fast": fast}


def _filter_graph(p):
    """FFmpeg filter_complex text that trims, normalises, joins and fades the clips. Returns (text, v_label, a_label)."""
    lines = []
    for i, s in enumerate(p["segs"]):
        lines.append(f"[{i}:v]setpts=PTS-STARTPTS,fps={FPS},scale={W}:{H},setsar=1,format=yuv420p[v{i}]")
        lines.append(f"[{i}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]")
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


def export(p, path_of, out_path, on_progress=None):
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
