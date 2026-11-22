/* Editing logic for the Editor page, without any DOM, so it can be tested with Node (see tests in the project notes).
   A timeline is {clips: [{file, start, end, join, join_len, uid}], fade_in, fade_out, fade_len} (same as the server's).
   `lib` maps a clip's file name to its full length in seconds. Every function returns a NEW timeline; nothing is mutated.
   The audio track is tl.audio: [{src: 'project'|'music', file, at, start, end, volume, fade_in, fade_out, uid}] where `at` is the
   timeline time the piece begins; `alib` maps 'src:file' to its length. Volume 1 = unchanged, 0 = muted, up to 2. */
(function (root) {
  const MIN_CLIP = 0.2, MIN_JOIN = 0.1;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const round2 = v => Math.round(v * 100) / 100;
  const copy = tl => JSON.parse(JSON.stringify(tl));

  const dur = (lib, c) => lib[c.file] || 0;
  const startOf = (lib, c) => Math.min(c.start || 0, Math.max(dur(lib, c) - MIN_CLIP, 0));   // where the clip starts in its file
  const endOf = (lib, c) => (c.end > 0 ? Math.min(c.end, dur(lib, c)) : dur(lib, c));         // where it ends in its file
  const clipLen = (lib, c) => Math.max(0, endOf(lib, c) - startOf(lib, c));
  const isTrimmed = (lib, c) => (c.start || 0) > 0.05 || (c.end > 0 && c.end < dur(lib, c) - 0.05);

  /* where each clip sits on the timeline (clips follow each other; transitions are drawn as markers) */
  function layout(tl, lib) {
    const starts = [], lens = [];
    let t = 0;
    tl.clips.forEach(c => { const l = clipLen(lib, c); starts.push(t); lens.push(l); t += l; });
    return { starts, lens, total: t };
  }

  /* the real overlap of a transition, after the same limits the server applies */
  function joinLen(tl, lib, i) {
    const c = tl.clips[i];
    if (!i || c.join === 'cut') return 0;
    const d = Math.min(c.join_len, 0.45 * Math.min(clipLen(lib, tl.clips[i - 1]), clipLen(lib, c)));
    return d < MIN_JOIN ? 0 : d;
  }
  function exportLength(tl, lib) {
    return tl.clips.reduce((t, c, i) => t + clipLen(lib, c) - joinLen(tl, lib, i), 0);
  }
  /* true when the clips can be joined by copying (no trims, no fades, only cuts) */
  function isFastJoin(tl, lib) {
    return tl.clips.length > 0 && !tl.fade_in && !tl.fade_out && !(tl.audio && tl.audio.length) &&
      tl.clips.every((c, i) => !isTrimmed(lib, c) && (!i || c.join === 'cut') && Math.abs((c.volume == null ? 1 : c.volume) - 1) < 0.01);
  }

  /* timeline time -> {i: clip index, offset: seconds into the clip, src: time inside the clip's file} */
  function locate(tl, lib, t) {
    const L = layout(tl, lib);
    if (!tl.clips.length) return null;
    t = clamp(t, 0, L.total);
    let i = tl.clips.length - 1;
    for (let k = 0; k < tl.clips.length; k++) {
      if (t < L.starts[k] + L.lens[k]) { i = k; break; }
    }
    const offset = clamp(t - L.starts[i], 0, L.lens[i]);
    return { i, offset, src: startOf(lib, tl.clips[i]) + offset };
  }
  /* time inside a clip's file -> timeline time */
  function toTimelineTime(tl, lib, i, src) {
    const L = layout(tl, lib);
    return L.starts[i] + clamp(src - startOf(lib, tl.clips[i]), 0, L.lens[i]);
  }

  /* trim one side of a clip. patch: {start} and/or {end}, in seconds of the clip's file. Later clips move up (ripple). */
  function setTrim(tl, lib, i, patch) {
    const out = copy(tl), c = out.clips[i], d = dur(lib, c);
    let s = startOf(lib, c), e = endOf(lib, c);
    if (patch.start != null && patch.end != null) { s = patch.start; e = patch.end; }
    else if (patch.start != null) s = clamp(patch.start, 0, Math.max(e - MIN_CLIP, 0));
    else if (patch.end != null) e = clamp(patch.end, s + MIN_CLIP, d);
    s = clamp(s, 0, Math.max(d - MIN_CLIP, 0));
    e = clamp(e, s + MIN_CLIP, d);
    c.start = s < 0.05 ? 0 : round2(s);
    c.end = e >= d - 0.05 ? 0 : round2(e);
    return out;
  }
  const resetTrim = (tl, lib, i) => { const out = copy(tl); out.clips[i].start = 0; out.clips[i].end = 0; return out; };

  /* cut the clip under timeline time t into two. Returns {tl, index} (index = the second half) or null when a half would be too short. */
  function splitAt(tl, lib, t, nextUid) {
    const loc = locate(tl, lib, t);
    if (!loc) return null;
    const c = tl.clips[loc.i], len = clipLen(lib, c);
    if (loc.offset < MIN_CLIP || len - loc.offset < MIN_CLIP) return null;
    const out = copy(tl), a = out.clips[loc.i];
    const b = Object.assign({}, a, { start: round2(loc.src), join: 'cut', uid: nextUid() });
    a.end = round2(loc.src);
    out.clips.splice(loc.i + 1, 0, b);
    return { tl: out, index: loc.i + 1 };
  }

  function moveClip(tl, from, to) {
    const out = copy(tl);
    if (from === to || from < 0 || from >= out.clips.length) return out;
    const [c] = out.clips.splice(from, 1);
    out.clips.splice(clamp(to, 0, out.clips.length), 0, c);
    return out;
  }
  function removeClip(tl, i) {
    const out = copy(tl);
    out.clips.splice(i, 1);
    return out;
  }
  function duplicateClip(tl, i, nextUid) {
    const out = copy(tl);
    out.clips.splice(i + 1, 0, Object.assign({}, out.clips[i], { join: 'cut', uid: nextUid() }));
    return out;
  }
  /* which index a dragged clip lands at, given the pointer's timeline position x (in seconds) */
  function dropIndex(tl, lib, dragged, x) {
    const L = layout(tl, lib);
    let idx = 0;
    for (let k = 0; k < tl.clips.length; k++) {
      if (k === dragged) continue;
      if (x > L.starts[k] + L.lens[k] / 2) idx++;
    }
    return idx;
  }


  /* ---- the audio track */
  const MAX_VOLUME = 2;
  const aKey = a => a.src + ':' + a.file;
  const aDur = (alib, a) => alib[aKey(a)] || 0;
  const aStart = (alib, a) => Math.min(a.start || 0, Math.max(aDur(alib, a) - MIN_CLIP, 0));
  const aEnd = (alib, a) => (a.end > 0 ? Math.min(a.end, aDur(alib, a)) : aDur(alib, a));
  const aLen = (alib, a) => Math.max(0, aEnd(alib, a) - aStart(alib, a));
  const audioList = tl => tl.audio || [];

  /* which row each piece sits in, so pieces that overlap in time are drawn one under the other */
  function audioRows(tl, alib) {
    const items = audioList(tl).map((a, i) => ({ i, at: a.at, end: a.at + aLen(alib, a) })).sort((x, y) => x.at - y.at || x.i - y.i);
    const rowEnds = [], rows = [];
    items.forEach(it => {
      let r = rowEnds.findIndex(e => e <= it.at + 1e-6);
      if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
      rowEnds[r] = it.end;
      rows[it.i] = r;
    });
    return { rows, count: Math.max(rowEnds.length, 1) };
  }
  function addAudio(tl, item, at, nextUid) {
    const out = copy(tl);
    out.audio = audioList(out);
    out.audio.push({ src: item.src, file: item.file, at: Math.max(0, round2(at)), start: 0, end: 0, volume: 1, fade_in: 0, fade_out: 0, uid: nextUid() });
    return out;
  }
  function moveAudio(tl, i, at) {
    const out = copy(tl);
    out.audio[i].at = Math.max(0, round2(at));
    return out;
  }
  /* trim a piece's start: the piece's left edge moves and what stays is still heard at the same time (so `at` moves with it) */
  function trimAudioStart(tl, alib, i, newStart) {
    const out = copy(tl), a = out.audio[i];
    const cur = aStart(alib, a), end = aEnd(alib, a);
    let target = clamp(newStart, 0, Math.max(end - MIN_CLIP, 0));
    let delta = target - cur;
    if (a.at + delta < 0) { delta = -a.at; target = cur + delta; }
    a.start = target < 0.05 ? 0 : round2(target);
    a.at = Math.max(0, round2(a.at + delta));
    return out;
  }
  function trimAudioEnd(tl, alib, i, newEnd) {
    const out = copy(tl), a = out.audio[i], d = aDur(alib, a);
    const e = clamp(newEnd, aStart(alib, a) + MIN_CLIP, d);
    a.end = e >= d - 0.05 ? 0 : round2(e);
    return out;
  }
  /* volume, fades or position of a piece; every value is kept in range */
  function setAudioProp(tl, alib, i, patch) {
    const out = copy(tl), a = out.audio[i];
    if (patch.volume != null) a.volume = clamp(patch.volume, 0, MAX_VOLUME);
    if (patch.at != null) a.at = Math.max(0, round2(patch.at));
    const len = aLen(alib, a);
    if (patch.fade_in != null) a.fade_in = clamp(patch.fade_in, 0, Math.min(30, len));
    if (patch.fade_out != null) a.fade_out = clamp(patch.fade_out, 0, Math.min(30, len));
    return out;
  }
  function removeAudio(tl, i) {
    const out = copy(tl);
    out.audio.splice(i, 1);
    return out;
  }
  function duplicateAudio(tl, alib, i, nextUid) {
    const out = copy(tl), a = out.audio[i];
    out.audio.splice(i + 1, 0, Object.assign({}, a, { at: round2(a.at + aLen(alib, a)), uid: nextUid() }));
    return out;
  }
  /* set a video clip's own volume (0 = muted) */
  function setClipVolume(tl, i, v) {
    const out = copy(tl);
    out.clips[i].volume = round2(clamp(v, 0, MAX_VOLUME));
    return out;
  }
  /* a piece dragged near 0 or a video clip edge (or another piece's edge) snaps to it. Returns the snapped time. */
  function snapAt(tl, lib, alib, movingIndex, at, threshold) {
    const L = layout(tl, lib), len = movingIndex >= 0 ? aLen(alib, tl.audio[movingIndex]) : 0;
    const marks = [0, L.total];
    L.starts.forEach((st, k) => { marks.push(st, st + L.lens[k]); });
    audioList(tl).forEach((a, k) => { if (k !== movingIndex) marks.push(a.at, a.at + aLen(alib, a)); });
    let best = at, bestD = threshold;
    marks.forEach(m => {
      [[m, m], [m - len, m]].forEach(([cand]) => {   // the piece's start, or its end, lands on the mark
        const d = Math.abs(cand - at);
        if (d < bestD && cand >= 0) { best = cand; bestD = d; }
      });
    });
    return best;
  }

  /* undo / redo of whole timelines */
  class History {
    constructor(limit = 100) { this.limit = limit; this.undoStack = []; this.redoStack = []; }
    push(tl) { this.undoStack.push(JSON.stringify(tl)); if (this.undoStack.length > this.limit) this.undoStack.shift(); this.redoStack.length = 0; }
    undo(current) { if (!this.undoStack.length) return null; this.redoStack.push(JSON.stringify(current)); return JSON.parse(this.undoStack.pop()); }
    redo(current) { if (!this.redoStack.length) return null; this.undoStack.push(JSON.stringify(current)); return JSON.parse(this.redoStack.pop()); }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
    clear() { this.undoStack = []; this.redoStack = []; }
  }

  const api = { MIN_CLIP, clamp, copy, clipLen, startOf, endOf, isTrimmed, layout, joinLen, exportLength, isFastJoin, locate,
                toTimelineTime, setTrim, resetTrim, splitAt, moveClip, removeClip, duplicateClip, dropIndex, History,
                MAX_VOLUME, aKey, aDur, aStart, aEnd, aLen, audioRows, addAudio, moveAudio, trimAudioStart, trimAudioEnd,
                setAudioProp, removeAudio, duplicateAudio, setClipVolume, snapAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EditorCore = api;
})(typeof window !== 'undefined' ? window : this);
