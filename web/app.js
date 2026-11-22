/* Vocal Studio — front-end. Vanilla JS, no framework; Tailwind CSS is pre-built into app.css. */
'use strict';

/* ================================================================ helpers */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const words = t => (t.match(/\S+/g) || []).length;
const fmt = s => s == null ? '--' : Math.floor(s / 60) + ':' + String(Math.round(s) % 60).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k){ try { return localStorage.getItem(k); } catch (e){ return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch (e){} },
};

/* fetch wrapper: always resolves to parsed JSON or throws an Error with a readable message.
   err.status is set for HTTP errors; err.network is set when the server could not be reached. */
async function request(url, opts = {}){
  let r;
  try { r = await fetch(url, opts); }
  catch (e){ const err = new Error('Cannot reach the server. Is Vocal Studio still running?'); err.network = true; throw err; }
  let data = null;
  try { data = await r.json(); } catch (e){ /* non-JSON body */ }
  if (!r.ok){
    const err = new Error((data && data.error) || `Server error (${r.status}).`);
    err.status = r.status; throw err;
  }
  return data;
}
const api = {
  get: url => request(url),
  post: (url, body) => request(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
};
const qp = (base, params) => base + '?' + new URLSearchParams(params).toString();

/* ================================================================ icons (lucide)
   Write <i data-lucide="name"></i> anywhere (static or rendered later); it is swapped for the SVG.
   Only <i> placeholders are converted — never the generated <svg> — so the observer cannot feed itself.
   (lucide.createIcons() re-replaces its own SVGs because they keep data-lucide; combined with an observer
   that is an endless loop, which in Firefox swallowed clicks on icon buttons and kept the CPU busy.) */
const lu = name => `<i data-lucide="${name}"></i>`;
const ICON = {dl: lu('download'), play: lu('play'), trash: lu('trash-2'), doc: lu('file-text')};
const pascal = n => n.replace(/(^|-)([a-z0-9])/g, (m, dash, c) => c.toUpperCase());
function renderIcons(){
  if (!window.lucide) return;
  document.querySelectorAll('i[data-lucide]').forEach(el => {
    const name = el.getAttribute('data-lucide');
    const node = lucide.icons[pascal(name)];
    if (!node){ console.warn('Unknown lucide icon:', name); el.removeAttribute('data-lucide'); return; }
    const svg = lucide.createElement(node);
    svg.setAttribute('class', ('lucide lucide-' + name + ' ' + (el.getAttribute('class') || '')).trim());
    svg.setAttribute('aria-hidden', 'true');
    el.replaceWith(svg);
  });
}
let iconQueued = false;
new MutationObserver(() => {
  if (iconQueued || !document.querySelector('i[data-lucide]')) return;   // nothing to convert -> no work
  iconQueued = true;
  queueMicrotask(() => { iconQueued = false; renderIcons(); });
}).observe(document.body, {childList: true, subtree: true});
renderIcons();

/* ================================================================ toast / badge / sidebar status */
let toastTimer;
function toast(msg, ms = 2800){
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('opacity-0', 'translate-y-4');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('opacity-0', 'translate-y-4'), ms);
}
const showError = e => { console.error(e); toast(e && e.message ? e.message : String(e), 4500); };
const BADGE = {
  '':  'badge',
  run: 'badge text-foreground border-foreground/30 [&>span:first-child]:animate-pulse',
  ok:  'badge text-success border-success/40',
  err: 'badge text-destructive border-destructive/40',
};
function setBadge(kind, text){ $('badge').className = BADGE[kind || '']; $('badgeText').textContent = text; }

/* The sidebar status shows whichever background job is running (speech or extraction). */
const jobStatus = {tts: null, ext: null};
function setJob(kind, text){
  jobStatus[kind] = text;
  const active = jobStatus.tts || jobStatus.ext;
  $('jobText').textContent = active || 'Idle';
  const dot = active ? 'bg-primary animate-pulse' : 'bg-muted-foreground';
  $('jobDot').className = 'size-2 shrink-0 rounded-full ' + dot;
  $('jobDot2').className = 'sb-only size-2.5 rounded-full ' + dot;   // shown when the sidebar is collapsed
}

/* ================================================================ theme */
$('themeBtn').onclick = () => {
  const dark = document.documentElement.classList.toggle('dark');
  store.set('theme', dark ? 'dark' : 'light');
};

/* ================================================================ sidebar */
const root = document.documentElement;
const SB_MIN = 200, SB_MAX = 420, SB_DEFAULT = 256;
const desktopMQ = matchMedia('(min-width: 48rem)');

/* Mobile: slide-out drawer */
function openSidebar(open){
  $('sidebar').classList.toggle('-translate-x-full', !open);
  $('scrim').hidden = !open;
}
$('menuBtn').onclick = () => openSidebar(true);
$('scrim').onclick = () => openSidebar(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('scrim').hidden) openSidebar(false); });
desktopMQ.addEventListener('change', () => openSidebar(false));

/* Desktop: collapse to icons (button or Ctrl+B) */
function setCollapsed(c){
  root.classList.toggle('sb-collapsed', c);
  if (c) $('newProjForm').hidden = true;
  store.set('sbCollapsed', c ? '1' : '0');
  $('collapseBtn').title = (c ? 'Expand' : 'Collapse') + ' sidebar (Ctrl+B)';
  $('collapseBtn').setAttribute('aria-expanded', String(!c));
}
$('collapseBtn').onclick = () => setCollapsed(!root.classList.contains('sb-collapsed'));
$('projIcon').onclick = () => setCollapsed(false);
setCollapsed(root.classList.contains('sb-collapsed'));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b'){
    e.preventDefault();
    if (desktopMQ.matches) setCollapsed(!root.classList.contains('sb-collapsed'));
    else openSidebar($('scrim').hidden);
  }
});

/* Desktop: drag the sidebar edge to resize (double-click resets) */
const resizer = $('resizer');
resizer.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  root.classList.add('sb-dragging');
});
resizer.addEventListener('pointermove', e => {
  if (!resizer.hasPointerCapture(e.pointerId)) return;
  const left = $('sidebar').getBoundingClientRect().left;
  const w = Math.min(SB_MAX, Math.max(SB_MIN, Math.round(e.clientX - left)));
  root.style.setProperty('--sb-w', w + 'px');
});
const endDrag = () => {
  if (!root.classList.contains('sb-dragging')) return;
  root.classList.remove('sb-dragging');
  store.set('sbWidth', String(parseInt(getComputedStyle($('sidebar')).width, 10) || SB_DEFAULT));
};
resizer.addEventListener('pointerup', endDrag);
resizer.addEventListener('pointercancel', endDrag);
resizer.addEventListener('lostpointercapture', endDrag);
resizer.addEventListener('dblclick', () => {
  root.style.setProperty('--sb-w', SB_DEFAULT + 'px');
  store.set('sbWidth', String(SB_DEFAULT));
});

/* ================================================================ projects */
let projects = [];
const curProject = () => $('project').value;

async function loadProjects(select){
  try { projects = await api.get('/api/projects'); }
  catch (e){ showError(e); projects = []; }
  const want = select || store.get('project');
  const sel = $('project');
  sel.innerHTML = projects.length
    ? projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')
    : '<option value="">No projects</option>';
  if (projects.length) sel.value = projects.includes(want) ? want : projects[0];
  projectChanged();
  route();
}
function projectChanged(){
  store.set('project', curProject());
  $('crumbProject').textContent = curProject() || 'No project';
  $('result').innerHTML = '';
  refreshCounts();
}
$('project').onchange = () => {
  projectChanged();
  if (location.hash.startsWith('#/doc/')) location.hash = '#/documents';   // hashchange will route
  else route();
};

async function createProject(name){
  name = name.trim();
  if (!name) return;
  try {
    const j = await api.post('/api/projects', {name});
    toast(projects.includes(j.name) ? `Switched to existing project "${j.name}".` : `Project "${j.name}" created.`);
    $('newProjForm').hidden = true; $('newName').value = ''; $('emptyName').value = '';
    loadProjects(j.name);
  } catch (e){ showError(e); }
}
$('newProjBtn').onclick = () => { $('newProjForm').hidden = !$('newProjForm').hidden; if (!$('newProjForm').hidden) $('newName').focus(); };
$('newProjForm').onsubmit = e => { e.preventDefault(); createProject($('newName').value); };
$('emptyForm').onsubmit = e => { e.preventDefault(); createProject($('emptyName').value); };

async function refreshCounts(){
  const p = curProject();
  if (!p){ $('docCount').textContent = ''; $('audioCount').textContent = ''; return; }
  try {
    const [docs, files] = await Promise.all([api.get(qp('/api/docs', {project: p})), api.get(qp('/api/files', {project: p}))]);
    if (p !== curProject()) return;   // project changed while loading
    $('docCount').textContent = docs.length || '';
    $('audioCount').textContent = files.length || '';
  } catch (e){ /* counts are cosmetic; errors surface elsewhere */ }
}

/* ================================================================ router */
const VIEWS = ['empty', 'generate', 'documents', 'doc', 'audio', 'videos', 'editor', 'settings'];
const TITLES = {generate: 'Generate speech', documents: 'Documents', doc: 'Document', audio: 'Audio library', videos: 'Videos', editor: 'Editor', settings: 'Settings'};
function setCrumb(text){ $('crumbPage').textContent = text; $('crumbPage').title = text; }
function show(view){
  VIEWS.forEach(v => { $('view-' + v).hidden = v !== view; });
  document.querySelector('main').style.maxWidth = view === 'editor' ? 'none' : '';   // the editor uses the whole width
  document.documentElement.classList.toggle('no-scrollbar', view === 'editor');        // and shows no scrollbars (it still scrolls)
  const nav = view === 'doc' ? 'documents' : view;
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.route === nav);
    if (a.dataset.route === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  setCrumb(TITLES[view] || '');
  openSidebar(false);
}
function currentRoute(){ return location.hash.replace(/^#\/?/, ''); }
function route(){
  if (!curProject()){ show('empty'); setCrumb('Get started'); return; }
  const h = currentRoute();
  if (h.startsWith('doc/')){ show('doc'); openDoc(h.slice(4)); return; }
  const v = ['generate', 'documents', 'audio', 'videos', 'editor', 'settings'].includes(h) ? h : 'generate';
  show(v);
  if (v === 'documents') loadDocs();
  if (v === 'audio') loadAudio();
  if (v === 'videos') loadVideos();
  if (v === 'editor') loadEditor();
  if (v === 'settings') loadSettings(true);
}
document.querySelectorAll('.nav-link').forEach(a => {
  a.href = '#/' + a.dataset.route;   // real links: keyboard focusable, middle-click works
  a.onclick = () => openSidebar(false);
});
window.addEventListener('hashchange', route);

/* ================================================================ generate speech */
function updateCount(){
  const t = $('text').value, w = words(t);
  $('count').textContent = w.toLocaleString() + (w === 1 ? ' word' : ' words') + '  ·  ' + t.length.toLocaleString() + ' characters';
  $('est').textContent = w ? 'About ' + fmtLong(Math.round(w / 2.6)) + ' of audio' : '';
  if (typeof refreshGenerate === 'function') refreshGenerate();
}
$('text').oninput = updateCount;
$('clearScript').onclick = () => { $('text').value = ''; updateCount(); $('text').focus(); };
$('ex').oninput = () => { $('exv').textContent = (+$('ex').value).toFixed(2); };
$('cfg').oninput = () => { $('cfv').textContent = (+$('cfg').value).toFixed(2); };
$('spd').oninput = () => { $('spv').textContent = (+$('spd').value).toFixed(2) + 'x'; };

function setStatus(t, err){
  $('status').textContent = t;
  $('status').className = err ? 'text-destructive' : 'text-muted-foreground';
}
const GO_HTML = $('go').innerHTML;
function setBusy(b){
  $('go').disabled = b;
  $('go').innerHTML = b ? '<span class="spinner"></span> Generating...' : GO_HTML;
}
const fileToB64 = f => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the voice sample file.'));
  r.readAsDataURL(f);
});
function resetOutput(){
  $('result').innerHTML = '';
  $('prog').style.width = '0'; $('pct').textContent = '';
  $('stats').hidden = true; $('parts').hidden = true; $('parts').innerHTML = '';
}

$('go').onclick = async () => {
  const text = $('text').value.trim();
  if (!text){ setStatus('Please enter some text first.', true); setBadge('err', 'No text'); $('text').focus(); return; }
  setBusy(true); resetOutput();
  setStatus('Sending request...'); setBadge('run', 'Working'); setJob('tts', 'Starting...');
  try {
    const body = {text, project: curProject(), exaggeration: $('ex').value, cfg: $('cfg').value, speed: $('spd').value,
                  quality: $('qual').value};
    if ($('voiceSel').value) body.voice_id = $('voiceSel').value;
    const j = await api.post('/api/generate', body);
    pollTts(j.id);
  } catch (e){
    setStatus('Error: ' + e.message, true); setBadge('err', 'Error'); setJob('tts', null); setBusy(false);
  }
};

function renderDetails(j){
  $('stats').hidden = false; $('parts').hidden = false;
  $('sDone').textContent = j.done + ' / ' + j.total;
  $('sLeft').textContent = j.total - j.done;
  $('sEl').textContent = fmt(j.elapsed || 0);
  $('sEta').textContent = j.done ? '~' + fmt(j.eta) : 'calculating...';
  const el = $('parts');
  if (el.childElementCount !== j.total){
    el.innerHTML = (j.parts || []).map((t, i) =>
      `<div class="flex items-center gap-3 border-t px-3 py-2 text-xs first:border-t-0">
         <span class="w-6 tabular-nums text-muted-foreground">${i + 1}</span>
         <span class="flex-1 truncate text-muted-foreground">${esc(t)}</span>
         <span data-s class="rounded-full border px-2 py-px text-[11px] font-medium text-muted-foreground"></span>
       </div>`).join('');
  }
  [...el.children].forEach((c, i) => {
    const st = i < j.done ? 'done' : i === j.done ? 'now' : 'wait';
    c.classList.toggle('bg-accent', st === 'now');
    const s = c.querySelector('[data-s]');
    s.textContent = {done: 'Done', now: 'In progress', wait: 'Pending'}[st];
    s.className = 'rounded-full border px-2 py-px text-[11px] font-medium ' +
      {done: 'text-success border-success/40', now: 'text-foreground border-foreground/40 animate-pulse', wait: 'text-muted-foreground'}[st];
  });
  const cur = el.children[Math.min(j.done, j.total - 1)];
  if (cur) el.scrollTop = Math.max(0, cur.offsetTop - 80);
}

const audioUrl = (project, file) => '/projects/' + encodeURIComponent(project) + '/' + encodeURIComponent(file);
function showResult(project, file, seconds){
  const url = audioUrl(project, file);
  $('result').innerHTML = `
    <div class="mt-5 rounded-xl border bg-muted/40 p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 font-medium">${lu('circle-check')}<span class="truncate">${esc(file)}</span></div>
          <div class="hint">${esc(project)}${seconds ? '  ·  ' + esc(fmtLong(Math.round(seconds))) : ''}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline btn-sm" data-mkvideo>${lu('clapperboard')}Make a video</button>
          <a class="btn btn-primary btn-sm" href="${url}" download>${ICON.dl} Download .wav</a>
        </div>
      </div>
      <audio class="mt-3 w-full" controls src="${url}"></audio>
    </div>`;
  $('result').querySelector('[data-mkvideo]').onclick = () => openVideoDialog(file);
}

/* Polls a speech job until it finishes. Survives brief network hiccups; stops cleanly if the job is gone. */
let ttsPollId = null;
async function pollTts(id){
  ttsPollId = id;
  let failures = 0;
  while (ttsPollId === id){
    let j;
    try { j = await api.get('/api/jobs/' + encodeURIComponent(id)); failures = 0; }
    catch (e){
      if (e.network && ++failures < 8){ setStatus('Connection lost, retrying...', true); await sleep(2000); continue; }
      setStatus('Error: ' + e.message, true); setBadge('err', e.network ? 'Offline' : 'Error');
      setJob('tts', null); setBusy(false); ttsPollId = null; return;
    }
    if (j.status === 'done'){
      $('prog').style.width = '100%'; $('pct').textContent = '100%';
      if (j.total){ j.done = j.total; j.eta = 0; renderDetails(j); }
      setStatus(`Finished${j.took != null ? ' in ' + fmt(j.took) : ''} on ${engineLabel(j)}. ${j.seconds} seconds of audio saved as ${j.file} in project ${j.project}.` +
        (j.retakes ? ` ${j.retakes} sentence take${j.retakes === 1 ? ' was' : 's were'} re-recorded to fix glitches.` : '') + (j.note ? ' ' + j.note : ''));
      setBadge('ok', 'Done'); setJob('tts', null);
      showResult(j.project, j.file, j.seconds);
      setBusy(false); refreshCounts(); toast('Saved ' + j.file);
      if (currentRoute() === 'audio') loadAudio();
      ttsPollId = null; return;
    }
    if (j.status === 'error'){
      setStatus(j.error || 'Generation failed.', true); setBadge('err', 'Error');
      if (j.remoteFailed){ showRemoteFallback(); checkColab(); }
      setJob('tts', null); setBusy(false); ttsPollId = null; return;
    }
    if (j.total){
      const pct = Math.round(j.done / j.total * 100);
      $('prog').style.width = pct + '%'; $('pct').textContent = pct + '%';
      setStatus(`Recording sentence ${Math.min(j.done + 1, j.total)} of ${j.total} on ${engineLabel(j)}.` +
        (j.engine === 'colab' ? '' : ' This can take a while on CPU.'));
      setJob('tts', `Recording ${j.done}/${j.total} sentences`);
      renderDetails(j);
    } else {
      const msg = {queued: ['Queued...', 'Queued'],
                   connecting: ['Connecting to the Colab GPU...', 'Connecting to Colab'],
                   'loading model': ['Loading the voice model. The first run takes longer.', 'Loading model']}[j.status]
                  || ['Working...', 'Working'];
      setStatus(msg[0]); setJob('tts', msg[1]);
    }
    await sleep(1500);
  }
}

/* ================================================================ audio library */
let audioLoadSeq = 0;
/* a name edited in place: the holder shows an input with Save / Cancel; onSave(text) does the work and may throw */
function inlineRename(holder, {value, placeholder = '', suffix = '', maxlength = 60, onSave}){
  const old = holder.innerHTML;
  holder.innerHTML = `<form class="flex items-center gap-2">
    <input class="input h-8 min-w-0 flex-1" maxlength="${maxlength}" placeholder="${esc(placeholder)}" value="${esc(value)}" aria-label="New name" autocomplete="off">
    ${suffix ? `<span class="hint">${esc(suffix)}</span>` : ''}
    <button class="btn btn-primary btn-sm" type="submit">Save</button>
    <button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button></form>`;
  const form = holder.firstElementChild, input = form.querySelector('input');
  input.focus(); input.select();
  const cancel = () => { holder.innerHTML = old; };
  form.querySelector('[data-cancel]').onclick = cancel;
  input.addEventListener('keydown', e => { if (e.key === 'Escape'){ e.preventDefault(); cancel(); } });
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try { await onSave(input.value.trim()); } catch (err){ toast(err.message, 5000); btn.disabled = false; }
  };
}
const renameBtn = (attr, label) => `<button type="button" class="btn btn-ghost btn-icon btn-sm shrink-0" ${attr} title="Rename" aria-label="Rename ${esc(label)}">${lu('pencil')}</button>`;
/* an audio file shows its display name (if it has one) with the real file name underneath */
function audioNameHtml(f, label){
  return `<div class="flex min-w-0 items-center gap-1.5"><div class="min-w-0">
      <div class="truncate ${label ? 'text-sm font-medium' : 'font-mono text-xs'}" title="${esc(label || f)}">${esc(label || f)}</div>
      ${label ? `<div class="truncate font-mono text-[11px] text-muted-foreground">${esc(f)}</div>` : ''}
    </div>${renameBtn('data-rename', f)}</div>`;
}
const safeDownloadName = (name, ext) => (name.replace(/[^\w .()-]/g, '_').trim() || 'audio') + ext;

async function loadAudio(){
  const p = curProject(), seq = ++audioLoadSeq;
  const box = $('audioList');
  let files, names = {};
  try {
    [files, names] = await Promise.all([api.get(qp('/api/files', {project: p})),
                                        api.get(qp('/api/audio-names', {project: p})).catch(() => ({}))]);
  }
  catch (e){ if (seq === audioLoadSeq) box.innerHTML = `<div class="px-5 py-12 text-center text-destructive">${esc(e.message)}</div>`; return; }
  if (seq !== audioLoadSeq) return;
  if (!files.length){
    box.innerHTML = `<div class="px-5 py-12 text-center text-muted-foreground">No audio yet. <a class="underline" href="#/generate">Generate your first file</a>.</div>`;
    return;
  }
  box.innerHTML = files.map(f => `
    <div class="p-4 md:px-5" data-file="${esc(f)}">
      <div class="flex items-center gap-3">
        <button class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border bg-muted transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4" data-play data-ico title="Play" aria-label="Play ${esc(f)}">${ICON.play}</button>
        <div class="min-w-0 flex-1" data-namebox>${audioNameHtml(f, names[f])}</div>
        <button class="btn btn-outline btn-sm" data-play data-lbl>Play</button>
        <button class="btn btn-outline btn-sm" data-video>${lu('clapperboard')}<span class="hidden sm:inline">Create video</span></button>
        <a class="btn btn-outline btn-sm" href="${audioUrl(p, f)}" download="${esc(safeDownloadName(names[f] || f.replace(/\.wav$/i, ''), '.wav'))}">${ICON.dl}<span class="hidden sm:inline">Download</span></a>
      </div>
    </div>`).join('');
  box.onclick = ev => {   // rename: gives the audio a display name (the numbered file name stays, the app relies on it)
    const b = ev.target.closest('[data-rename]');
    if (!b) return;
    const row = b.closest('[data-file]'), f = row.dataset.file, holder = row.querySelector('[data-namebox]');
    inlineRename(holder, {value: names[f] || '', placeholder: f + ' (leave empty to use the file name)', maxlength: 60, onSave: async name => {
      await api.post('/api/audio/rename', {project: p, file: f, name});
      if (name) names[f] = name; else delete names[f];
      holder.innerHTML = audioNameHtml(f, names[f]);
      row.querySelector('a[download]').setAttribute('download', safeDownloadName(names[f] || f.replace(/\.wav$/i, ''), '.wav'));
      toast(name ? 'Name saved' : 'Back to the file name');
    }});
  };
  box.querySelectorAll('[data-video]').forEach(b => b.onclick = () => openVideoDialog(b.closest('[data-file]').dataset.file));
  const setRowState = (row, playing) => {
    row.querySelector('[data-ico]').innerHTML = playing ? lu('pause') : lu('play');
    row.querySelector('[data-ico]').title = playing ? 'Pause' : 'Play';
    row.querySelector('[data-lbl]').textContent = playing ? 'Pause' : 'Play';
  };
  box.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const row = b.closest('[data-file]');
    let a = row.querySelector('audio');
    if (a){ if (a.paused) a.play().catch(() => {}); else a.pause(); return; }   // same row: toggle
    box.querySelectorAll('[data-file]').forEach(r => {                           // another row: stop it
      const x = r.querySelector('audio');
      if (x){ x.pause(); x.remove(); setRowState(r, false); }
    });
    a = document.createElement('audio');
    a.controls = true; a.autoplay = true; a.className = 'mt-3 w-full';
    a.src = audioUrl(p, row.dataset.file);
    a.addEventListener('play', () => setRowState(row, true));
    a.addEventListener('pause', () => setRowState(row, false));
    a.addEventListener('ended', () => setRowState(row, false));
    row.appendChild(a);
  });
}

/* ================================================================ documents: list + upload */
let docsCache = [], docsLoadSeq = 0;
async function loadDocs(){
  const p = curProject(), seq = ++docsLoadSeq;
  try {
    const docs = await api.get(qp('/api/docs', {project: p}));
    if (seq !== docsLoadSeq) return;
    docsCache = docs;
  } catch (e){ if (seq === docsLoadSeq){ docsCache = []; showError(e); } }
  renderDocRows();
}
function renderDocRows(){
  const q = $('docFilter').value.trim().toLowerCase();
  const rows = docsCache.filter(d => !q || d.name.toLowerCase().includes(q));
  $('docEmpty').hidden = rows.length > 0;
  $('docEmpty').textContent = docsCache.length ? 'No documents match your filter.' : 'No documents yet. Upload a PDF above.';
  $('docRows').innerHTML = rows.map(d => `
    <tr class="cursor-pointer border-b last:border-b-0 hover:bg-muted/50" data-id="${esc(d.id)}" tabindex="0">
      <td class="max-w-0 px-5 py-3">
        <div class="flex items-center gap-3">
          <span class="grid size-8 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground [&_svg]:size-4">${ICON.doc}</span>
          <div class="min-w-0">
            <div class="truncate font-medium" title="${esc(d.name)}">${esc(d.name)}</div>
            ${d.edited ? `<div class="hint">${esc(d.edited)} page(s) edited</div>` : ''}
          </div>
        </div>
      </td>
      <td class="px-3 py-3 text-right tabular-nums">${esc(d.pages)}</td>
      <td class="hidden px-3 py-3 text-right tabular-nums sm:table-cell">${esc(d.words.toLocaleString())}</td>
      <td class="hidden px-3 py-3 text-muted-foreground md:table-cell">${esc(new Date(d.created * 1000).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'}))}</td>
      <td class="px-5 py-3 text-right">
        <button class="btn btn-ghost btn-sm btn-icon size-8 text-muted-foreground hover:text-destructive" data-del title="Delete" aria-label="Delete document">${ICON.trash}</button>
      </td>
    </tr>`).join('');
}
$('docRows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.closest('[data-del]')){
    const d = docsCache.find(x => x.id === id);
    if (d && confirm(`Delete "${d.name}"? The saved extraction and any edits will be removed.`)) deleteDoc(id);
    return;
  }
  location.hash = '#/doc/' + id;
});
$('docRows').addEventListener('keydown', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.key === 'Enter' && e.target === tr) location.hash = '#/doc/' + tr.dataset.id;
});
$('docFilter').oninput = renderDocRows;
async function deleteDoc(id){
  try {
    await api.post('/api/doc/delete', {project: curProject(), id});
    if (doc && doc.id === id) doc = null;
    toast('Document deleted.');
  } catch (e){ showError(e); }
  loadDocs(); refreshCounts();
}

const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('border-ring', 'bg-accent'); };
drop.ondragleave = () => drop.classList.remove('border-ring', 'bg-accent');
drop.ondrop = e => { e.preventDefault(); drop.ondragleave(); if (e.dataTransfer.files[0]) startExtract(e.dataTransfer.files[0]); };
$('pdfFile').onchange = () => { const f = $('pdfFile').files[0]; $('pdfFile').value = ''; if (f) startExtract(f); };

let extracting = false;
async function startExtract(file){
  if (extracting){ toast('Please wait for the current PDF to finish.'); return; }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf'){ toast('Please choose a PDF file.'); return; }
  if (file.size > 300 * 1024 * 1024){ toast('That PDF is too large (max 300 MB).'); return; }
  const project = curProject();
  extracting = true;
  showExtractProgress('Uploading ' + file.name + '...');
  try {
    const j = await request('/api/extract', {method: 'POST', body: file, headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(file.name),
      'X-Project': encodeURIComponent(project)}});
    if (j.cached){
      extractFinished();
      toast('Already extracted. Opening the saved copy.');
      if (curProject() === project) location.hash = '#/doc/' + j.docId;
      return;
    }
    pollExtract(j.id, j.docId, project, file.name);
  } catch (e){ extractFailed(e.message); }
}
function showExtractProgress(text){
  drop.hidden = true; $('exProg').hidden = false;
  $('exBar').style.width = '0'; $('exPct').textContent = ''; $('exMeta').textContent = '';
  $('exStatus').className = 'text-muted-foreground';
  $('exStatus').textContent = text;
}
function extractFinished(){ extracting = false; drop.hidden = false; $('exProg').hidden = true; setJob('ext', null); }
function extractFailed(msg){
  extracting = false; drop.hidden = false;
  $('exProg').hidden = false;
  $('exStatus').textContent = 'Error: ' + msg; $('exStatus').className = 'text-destructive';
  setJob('ext', null);
}
async function pollExtract(id, docId, project, name){
  let failures = 0;
  for (;;){
    let j;
    try { j = await api.get('/api/extract/' + encodeURIComponent(id)); failures = 0; }
    catch (e){
      if (e.network && ++failures < 8){ $('exStatus').textContent = 'Connection lost, retrying...'; await sleep(2000); continue; }
      extractFailed(e.message); return;
    }
    if (j.status === 'error'){ extractFailed(j.error || 'Extraction failed.'); return; }
    if (j.status === 'done'){
      extractFinished(); refreshCounts();
      // Only jump to the document if the user is still on the Documents page of the same project.
      if (curProject() === project && currentRoute() === 'documents'){
        toast(`Extracted ${j.total} pages in ${fmt(j.elapsed || 0)}.`);
        location.hash = '#/doc/' + docId;
      } else {
        toast(`"${name}" is ready in project ${project} (Documents).`, 5000);
        if (curProject() === project && currentRoute() === 'documents') loadDocs();
      }
      return;
    }
    if (j.total){
      const pct = Math.round(j.done / j.total * 100);
      $('exBar').style.width = pct + '%'; $('exPct').textContent = pct + '%';
      $('exStatus').textContent = `Extracting page ${Math.min(j.done + 1, j.total)} of ${j.total}...`;
      $('exMeta').textContent = `Elapsed ${fmt(j.elapsed || 0)}` + (j.done ? `  ·  about ${fmt(j.eta)} left` : '');
      setJob('ext', `Extracting ${j.done}/${j.total} pages`);
    } else {
      $('exStatus').textContent = 'Reading the PDF...';
      setJob('ext', 'Reading PDF');
    }
    await sleep(800);
  }
}

/* ================================================================ documents: viewer */
let doc = null;                // {id, project, name, pages:[{n, text, orig, noText}]}
const selected = new Set();
let openSeq = 0;

function cleanForSpeech(md){
  let t = md.replace(/\r/g, '');
  t = t.replace(/```[\s\S]*?```/g, '');                         // code blocks
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                   // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                // links -> label
  t = t.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');   // html tags
  t = t.replace(/https?:\/\/\S+?(?=[.,;:!?)]?(\s|$))/g, '');     // bare urls (keep punctuation)
  t = t.split('\n').map(line => {                                // tables -> "a, b, c."
    const s = line.trim();
    if (/^[|+]?[\s:=+|-]+[|+]?$/.test(s) && /[-=]{3,}/.test(s)) return '';
    if (s.startsWith('|') && s.endsWith('|')){
      const cells = s.slice(1, -1).split('|').map(c => c.trim()).filter(Boolean);
      return cells.length ? cells.join(', ') + '.' : '';
    }
    return line;
  }).join('\n');
  const endStop = s => s.replace(/[ \t]+$/, '').replace(/([^.!?:;,…"”'’)])$/, '$1.');
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');                                           // rules
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, (m, h) => '\n' + endStop(h.replace(/[ \t]*:$/, '')) + '\n'); // headings
  t = t.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+(.*)$/gm, (m, x) => '\n' + endStop(x) + '\n');  // list items
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');                                                        // quotes
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');                      // bold
  t = t.replace(/\*(\S(?:.*?\S)?)\*/g, '$1');                    // italic *
  t = t.replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, '$1$2');      // italic _
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/(\w)-\n(\w)/g, '$1$2');                         // re-join hyphenated words
  t = t.replace(/([^\n])\n(?!\n)/g, '$1 ');                      // join wrapped lines
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
const out = t => $('cleanOn').checked ? cleanForSpeech(t) : t;
const targetPages = () => { const ps = doc.pages.filter(p => selected.has(p.n)); return ps.length ? ps : doc.pages; };
const joinPages = (ps, f) => ps.map(p => f(p.text)).filter(s => s.trim()).join('\n\n');
const baseName = () => doc.name.replace(/\.pdf$/i, '');

async function copyText(t){
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e){
    const ta = document.createElement('textarea'); ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
function sendToScript(t){
  if (!t.trim()){ toast('Nothing to send: the selected text is empty.'); return; }
  const box = $('text');
  box.value = box.value.trim() ? box.value.trimEnd() + '\n\n' + t : t;
  updateCount();
  location.hash = '#/generate';
  setTimeout(() => { box.focus(); box.scrollTop = box.scrollHeight; }, 50);
  toast('Added ' + words(t).toLocaleString() + ' words to the script.');
}
function download(name, text){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function autosize(ta){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
/* Re-fit every visible page box in one batched pass (all writes, then all reads, then all writes). */
function autosizeAll(){
  const tas = [...document.querySelectorAll('#exPages textarea')].filter(t => t.offsetParent);
  tas.forEach(t => { t.style.height = 'auto'; });
  const hs = tas.map(t => t.scrollHeight);
  tas.forEach((t, i) => { t.style.height = hs[i] + 'px'; });
}
/* Text wraps differently when the available width changes (sidebar collapse/resize, window resize). */
{
  let lastW = 0, timer;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastW) return;
    lastW = w; clearTimeout(timer); timer = setTimeout(autosizeAll, 120);
  }).observe($('exPages'));
}

/* ---------- autosave: one request in flight per page, latest text always wins, failures retried */
const saver = {
  pages: new Map(),   // key -> {project, id, n, text, timer, inflight, dirty, failed}
  key: (project, id, n) => project + '|' + id + '|' + n,
  queue(project, id, p){
    const k = this.key(project, id, p.n);
    const s = this.pages.get(k) || {project, id, n: p.n};
    s.text = p.text; s.dirty = true;
    this.pages.set(k, s);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.flush(k), 600);
    this.render();
  },
  async flush(k){
    const s = this.pages.get(k);
    if (!s || s.inflight || !s.dirty) return;
    s.inflight = true; s.dirty = false;
    const text = s.text;
    try {
      await api.post('/api/doc/page', {project: s.project, id: s.id, n: s.n, text});
      s.failed = false;
    } catch (e){
      s.failed = e.message; s.dirty = true;                      // keep it dirty and retry
      clearTimeout(s.timer); s.timer = setTimeout(() => this.flush(k), 4000);
    }
    s.inflight = false;
    if (s.dirty && !s.failed){ this.flush(k); return; }        // typed again while saving
    if (!s.dirty) this.pages.delete(k);
    this.render();
  },
  flushAll(){ for (const k of this.pages.keys()){ const s = this.pages.get(k); clearTimeout(s.timer); this.flush(k); } },
  unsaved(){ return [...this.pages.values()].some(s => s.dirty || s.inflight); },
  render(){
    const el = $('saveState');
    const failed = [...this.pages.values()].find(s => s.failed);
    if (failed){ el.className = 'badge mt-8 text-destructive border-destructive/40'; el.textContent = 'Not saved, retrying: ' + failed.failed; }
    else if (this.unsaved()){ el.className = 'badge mt-8'; el.innerHTML = '<span class="spinner size-3 border"></span> Saving...'; }
    else { el.className = 'badge mt-8 text-success border-success/40'; el.textContent = 'All changes saved'; }
  },
};
window.addEventListener('beforeunload', e => { if (saver.unsaved()){ saver.flushAll(); e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => saver.flushAll());

async function openDoc(id){
  const project = curProject();
  if (doc && doc.id === id && doc.project === project && $('exPages').childElementCount){ setCrumb(doc.name); return; }
  const seq = ++openSeq;
  saver.flushAll();
  $('docName').textContent = 'Loading...'; $('docMeta').textContent = ''; $('exPages').innerHTML = ''; $('exNav').innerHTML = '';
  let d;
  try { d = await api.get(qp('/api/doc', {project, id})); }
  catch (e){ if (seq === openSeq){ showError(e); location.hash = '#/documents'; } return; }
  if (seq !== openSeq || curProject() !== project) return;   // user navigated away meanwhile
  doc = Object.assign(d, {project}); selected.clear(); $('exSearch').value = '';
  setCrumb(doc.name);
  renderDoc();
}

function renderDoc(){
  $('docName').textContent = doc.name;
  const total = doc.pages.reduce((s, p) => s + words(p.text), 0);
  const empty = doc.pages.filter(p => p.noText).length;
  $('docMeta').textContent = `${doc.pages.length} pages · ${total.toLocaleString()} words · extracted in ${fmt(doc.elapsed || 0)}`
    + (empty ? ` · ${empty} image-only page(s)` : '');
  saver.render();

  const nav = $('exNav'), list = $('exPages');
  const fn = document.createDocumentFragment(), fp = document.createDocumentFragment();
  doc.pages.forEach(p => {
    const ni = document.createElement('div');
    ni.id = 'nav-' + p.n;
    ni.className = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent';
    ni.innerHTML = `<input type="checkbox" data-n="${p.n}" class="size-3.5" aria-label="Select page ${p.n}"><span>Page ${p.n}</span><span data-hit></span><span data-w class="ml-auto text-[11px] tabular-nums text-muted-foreground">${words(p.text)}</span>`;
    ni.onclick = e => { if (e.target.tagName !== 'INPUT') $('pg-' + p.n).scrollIntoView({behavior: 'smooth'}); };
    fn.appendChild(ni);

    const card = document.createElement('section');
    card.id = 'pg-' + p.n;
    card.className = 'card mb-3 scroll-mt-72 overflow-hidden';
    const edited = p.text !== p.orig;
    card.innerHTML = `
      <div class="flex flex-wrap items-center gap-2.5 border-b bg-muted/40 px-4 py-2.5">
        <label class="flex cursor-pointer items-center gap-2 text-sm font-semibold"><input type="checkbox" data-n="${p.n}" class="size-3.5"> Page ${p.n}</label>
        <span data-w class="hint">${words(p.text)} words</span>
        ${p.noText ? '<span class="rounded-full border border-destructive/40 px-2 text-[11px] text-destructive">Image only, no text</span>' : ''}
        <span data-edited class="rounded-full border px-2 text-[11px] text-muted-foreground" ${edited ? '' : 'hidden'}>Edited</span>
        <div data-actions class="ml-auto flex gap-1.5">
          <button class="btn btn-ghost btn-sm" data-act="reset" title="Undo your edits on this page" ${edited ? '' : 'hidden'}>${lu('rotate-ccw')}Reset</button>
          <button class="btn btn-outline btn-sm" data-act="copy" title="Copies highlighted text, or the whole page">${lu('copy')}Copy</button>
          <button class="btn btn-outline btn-sm" data-act="send" title="Sends highlighted text, or the whole page">${lu('arrow-right')}Send to Script</button>
        </div>
      </div>
      <textarea spellcheck="false" aria-label="Text of page ${p.n}" class="block min-h-16 w-full resize-none overflow-hidden bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"></textarea>`;
    const ta = card.querySelector('textarea');
    ta.value = p.text;
    const project = doc.project, docId = doc.id;
    ta.oninput = () => {
      p.text = ta.value; autosize(ta);
      const changed = p.text !== p.orig;
      card.querySelector('[data-edited]').hidden = !changed;
      card.querySelector('[data-act=reset]').hidden = !changed;
      card.querySelector('[data-w]').textContent = words(p.text) + ' words';
      $('nav-' + p.n).querySelector('[data-w]').textContent = words(p.text);
      updateSelInfo();
      saver.queue(project, docId, p);
    };
    card.querySelector('[data-actions]').onclick = async e => {
      const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
      const hasSel = ta.selectionStart !== ta.selectionEnd;
      const raw = hasSel ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : p.text;
      if (act === 'copy'){ const ok = await copyText(out(raw)); toast(ok ? (hasSel ? 'Copied highlighted text.' : `Copied page ${p.n}.`) : 'Copy failed. Select the text and press Ctrl+C.'); }
      if (act === 'send') sendToScript(out(raw));
      if (act === 'reset'){ ta.value = p.orig; ta.oninput(); toast(`Page ${p.n} restored to the original.`); }
    };
    fp.appendChild(card);
  });
  nav.replaceChildren(fn); list.replaceChildren(fp);
  requestAnimationFrame(autosizeAll);
  updateSelInfo();
}

/* Page selection — checkboxes in the nav and on cards stay in sync */
$('view-doc').addEventListener('change', e => {
  const n = +e.target.dataset.n;
  if (!n || e.target.type !== 'checkbox') return;
  setSel(n, e.target.checked); updateSelInfo();
});
function setSel(n, on){
  on ? selected.add(n) : selected.delete(n);
  document.querySelectorAll(`#view-doc input[data-n="${n}"]`).forEach(c => { c.checked = on; });
  $('pg-' + n).classList.toggle('ring-2', on);
  $('pg-' + n).classList.toggle('ring-ring', on);
  $('nav-' + n).classList.toggle('bg-accent', on);
  $('nav-' + n).classList.toggle('font-medium', on);
}
$('selAll').onclick = () => { if (!doc) return; doc.pages.filter(p => !$('pg-' + p.n).hidden).forEach(p => setSel(p.n, true)); updateSelInfo(); };
$('selNone').onclick = () => { if (!doc) return; doc.pages.forEach(p => setSel(p.n, false)); updateSelInfo(); };
function updateSelInfo(){
  if (!doc) return;
  const ps = targetPages(), w = ps.reduce((s, p) => s + words(p.text), 0);
  $('selInfo').textContent = selected.size
    ? `${selected.size} page(s) selected · ${w.toLocaleString()} words. The buttons above apply to the selected pages.`
    : `No pages selected. The buttons above apply to all ${doc.pages.length} pages (${w.toLocaleString()} words). Tick pages to choose specific ones.`;
}

/* Toolbar */
$('copySel').onclick = async () => {
  if (!doc) return;
  const ps = targetPages();
  const ok = await copyText(joinPages(ps, out));
  toast(ok ? `Copied ${ps.length} page(s).` : 'Copy failed. Try selecting fewer pages.');
};
$('sendSel').onclick = () => {
  if (!doc) return;
  const ps = targetPages(), t = joinPages(ps, out);
  if (!selected.size && words(t) > 3000 &&
      !confirm(`Send all ${ps.length} pages (${words(t).toLocaleString()} words) to the script? On this computer that is many hours of audio.`)) return;
  sendToScript(t);
};
$('dlMd').onclick = () => { if (doc) download(baseName() + '.md', joinPages(targetPages(), t => t)); };
$('dlTxt').onclick = () => { if (doc) download(baseName() + '.txt', joinPages(targetPages(), cleanForSpeech)); };
$('saveProj').onclick = async () => {
  if (!doc) return;
  const clean = $('cleanOn').checked;
  try {
    const j = await api.post('/api/save_text', {project: doc.project, filename: baseName(), format: clean ? 'txt' : 'md', text: joinPages(targetPages(), out)});
    toast('Saved to ' + j.path);
  } catch (e){ showError(e); }
};
$('backDocs').onclick = () => { location.hash = '#/documents'; };

/* Search: only pages containing the text stay visible */
$('exSearch').oninput = () => {
  if (!doc) return;
  const raw = $('exSearch').value.trim(), q = raw.toLowerCase();
  let hits = 0, pagesHit = 0;
  doc.pages.forEach(p => {
    const n = q ? p.text.toLowerCase().split(q).length - 1 : 0;
    const showIt = !q || n > 0;
    $('pg-' + p.n).hidden = !showIt;
    const ni = $('nav-' + p.n); ni.hidden = !showIt;
    ni.querySelector('[data-hit]').innerHTML = q && n ? `<span class="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">${n}</span>` : '';
    if (q && n){ hits += n; pagesHit++; }
  });
  if (q) $('selInfo').textContent = `"${raw}": ${hits} match(es) on ${pagesHit} page(s). "Select all" now selects only these pages.`;
  else updateSelInfo();
  autosizeAll();   // pages that were hidden may have stale heights
};

/* ================================================================ settings: speech engine (Local CPU / Colab GPU) */
let settings = {engine: 'local', colab_url: '', has_key: false};
const engineLabel = j => j.engine === 'colab' ? 'Colab GPU' + (j.gpu ? ` (${j.gpu})` : '') : 'Local CPU';

async function loadSettings(fillForm){
  try { settings = await api.get('/api/settings'); }
  catch (e){ if (fillForm) showError(e); return; }
  renderEngine();
  if (fillForm) fillSettingsForm();
}
function renderEngine(){
  const colab = settings.engine === 'colab';
  $('engineName').textContent = colab ? 'Colab GPU' : 'Local CPU';
  $('engineTag').textContent = colab ? 'GPU' : 'CPU';
  checkColab();
}

/* Live connection state, shown in the header pill and on the Generate page.
   Checked every 15 s while the tab is visible, when you return to the tab, and after settings/job changes. */
const PILL = {
  local:    {cls: 'badge hover:bg-accent', text: 'Local CPU', pulse: false},
  checking: {cls: 'badge hover:bg-accent', text: 'Colab GPU · Checking...', pulse: true},
  online:   {cls: 'badge hover:bg-accent text-success border-success/40', text: 'GPU', pulse: false},
  offline:  {cls: 'badge hover:bg-accent text-destructive border-destructive/40', text: 'Colab GPU · Offline', pulse: false},
};
let colabState = 'local', colabCheckSeq = 0, colabLoaded = false;
function showEngineState(state, title, stateText){
  colabState = state;
  const p = PILL[state];
  $('engPill').className = p.cls;
  $('engText').textContent = p.text;
  $('engDot').className = 'size-1.5 rounded-full bg-current' + (p.pulse ? ' animate-pulse' : '');
  $('engPill').title = title || 'Speech engine';
  $('engineState').textContent = stateText || '';
}
async function checkColab(){
  const seq = ++colabCheckSeq;
  if (settings.engine !== 'colab'){ colabLoaded = false; showEngineState('local', 'Speech runs on this computer'); return; }
  if (!colabLoaded) showEngineState('checking', 'Checking the Colab connection...', '· checking...');   // only the first time: no flicker on later polls
  let r;
  try { r = await api.get('/api/colab/status'); }
  catch (e){ if (seq === colabCheckSeq) showEngineState('offline', e.message, '· offline'); return; }
  if (seq !== colabCheckSeq) return;   // a newer check superseded this one
  colabLoaded = true;
  if (r.engine !== 'colab'){ showEngineState('local', 'Speech runs on this computer'); return; }
  if (r.connected){
    const gpu = r.device === 'cuda' ? (r.gpu || 'GPU') : 'CPU only - no GPU in the Colab runtime!';
    showEngineState('online', `Connected to Colab: ${gpu} · ${r.latency_ms} ms`, '· connected');
  } else {
    showEngineState('offline', r.error || 'Cannot reach the Colab worker.', '· offline');
  }
}
setInterval(() => { if (!document.hidden && settings.engine === 'colab') checkColab(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.engine === 'colab') checkColab(); });
function selectedEngine(){ return (document.querySelector('input[name="engine"]:checked') || {}).value || 'local'; }
function updateColabFields(){
  $('colabFields').classList.toggle('opacity-60', selectedEngine() !== 'colab');
}
function fillSettingsForm(){
  document.querySelectorAll('input[name="engine"]').forEach(r => { r.checked = r.value === settings.engine; });
  $('colabUrl').value = settings.colab_url || '';
  $('colabKey').value = '';
  $('colabKey').placeholder = settings.has_key ? 'Saved (leave empty to keep it)' : 'Paste the Key from the notebook';
  $('testResult').textContent = ''; $('saveResult').textContent = '';
  updateColabFields();
}
const setResult = (id, text, kind) => {
  $(id).textContent = text;
  $(id).className = 'text-sm ' + ({ok: 'text-success', err: 'text-destructive'}[kind] || 'text-muted-foreground');
};
document.querySelectorAll('input[name="engine"]').forEach(r => r.addEventListener('change', updateColabFields));
$('toggleKey').onclick = () => { const k = $('colabKey'); k.type = k.type === 'password' ? 'text' : 'password'; };

$('testColab').onclick = async () => {
  const btn = $('testColab');
  btn.disabled = true; setResult('testResult', 'Testing...');
  try {
    const r = await api.post('/api/colab/test', {colab_url: $('colabUrl').value.trim(), colab_key: $('colabKey').value.trim()});
    if (r.ok) setResult('testResult', `Connected: ${r.device === 'cuda' ? (r.gpu || 'GPU') : 'CPU only (no GPU in Colab!)'} · ${r.latency_ms} ms`, r.device === 'cuda' ? 'ok' : 'err');
    else setResult('testResult', r.error, 'err');
  } catch (e){ setResult('testResult', e.message, 'err'); }
  btn.disabled = false;
};

$('settingsForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('saveSettings');
  btn.disabled = true; setResult('saveResult', 'Saving...');
  try {
    settings = await api.post('/api/settings', {engine: selectedEngine(), colab_url: $('colabUrl').value.trim(), colab_key: $('colabKey').value.trim()});
    colabLoaded = false;   // new address/key: show "Checking..." instead of the old state
    renderEngine(); fillSettingsForm();
    setResult('saveResult', 'Saved. New generations use ' + (settings.engine === 'colab' ? 'Colab GPU.' : 'Local CPU.'), 'ok');
  } catch (err){ setResult('saveResult', err.message, 'err'); }
  btn.disabled = false;
};

/* Offered on the Generate page when the Colab worker fails mid-job. */
function showRemoteFallback(){
  $('result').innerHTML = `
    <div class="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-4">
      <span class="flex-1 text-sm">Colab GPU is not available right now. Restart the notebook and update the Address in Settings, or use this computer instead.</span>
      <a class="btn btn-outline btn-sm" href="#/settings">${lu('settings')}Open Settings</a>
      <button class="btn btn-primary btn-sm" id="useLocal">${lu('cpu')}Switch to Local CPU</button>
    </div>`;
  $('useLocal').onclick = async () => {
    try {
      settings = await api.post('/api/settings', {engine: 'local'});
      renderEngine(); $('result').innerHTML = '';
      setStatus('Switched to Local CPU. Click Generate audio to try again.');
      setBadge('', 'Ready');
    } catch (e){ showError(e); }
  };
}

/* ================================================================ saved voices (narrators) */
let voiceList = [];
async function loadVoices(selectId){
  try { voiceList = await api.get('/api/voices'); } catch (e){ voiceList = []; }
  const want = selectId != null ? selectId : (store.get('voiceId') || '');
  const sel = $('voiceSel');
  sel.innerHTML = `<option value="">Default voice</option>` +
    voiceList.map(v => `<option value="${esc(v.id)}">${esc(v.name)}${v.seconds ? ' (' + v.seconds + 's)' : ''}</option>`).join('');
  sel.value = voiceList.some(v => v.id === want) ? want : (voiceList.length && selectId == null && !store.get('voiceId') ? voiceList[0].id : '');
  voiceChanged();
  $('voiceEmpty').hidden = voiceList.length > 0;
}
function voiceChanged(){
  const id = $('voiceSel').value;
  store.set('voiceId', id);
  $('voiceDelete').hidden = !id;
  const a = $('voicePrev');
  a.pause(); a.hidden = !id;
  if (id) a.src = '/api/voices/' + encodeURIComponent(id) + '.wav'; else a.removeAttribute('src');
  if (typeof refreshGenerate === 'function') refreshGenerate();
}
$('voiceSel').onchange = voiceChanged;
$('voiceAddToggle').onclick = () => { const f = $('voiceAdd'); f.hidden = !f.hidden; $('voiceMsg').hidden = true; };
$('voiceSave').onclick = async () => {
  const f = $('voiceFile').files[0], msg = $('voiceMsg');
  msg.hidden = true;
  if (!f){ msg.textContent = 'Choose a .wav file first.'; msg.hidden = false; return; }
  $('voiceSave').disabled = true;
  try {
    const v = await api.post('/api/voices', {name: $('voiceName').value.trim() || f.name.replace(/\.wav$/i, ''), data: await fileToB64(f)});
    $('voiceFile').value = ''; $('voiceName').value = ''; $('voiceAdd').hidden = true;
    await loadVoices(v.id);
    toast('Voice saved: ' + v.name);
  } catch (e){ msg.textContent = e.message; msg.hidden = false; }
  $('voiceSave').disabled = false;
};
$('voiceDelete').onclick = async () => {
  const id = $('voiceSel').value, v = voiceList.find(x => x.id === id);
  if (!id || !confirm(`Delete the voice "${v ? v.name : ''}"?`)) return;
  try { await api.post('/api/voices/delete', {id}); await loadVoices(''); toast('Voice deleted'); }
  catch (e){ toast(e.message); }
};
loadVoices();

/* ================================================================ generate page: presets, quality, summary */
const PRESETS = {
  story: {ex: 0.55, cfg: 0.40, spd: 1.00, name: 'Storyteller'},
  calm:  {ex: 0.40, cfg: 0.30, spd: 1.00, name: 'Calm'},
  vivid: {ex: 0.80, cfg: 0.45, spd: 1.00, name: 'Dramatic'},
};
const QUAL = {
  '3': {name: 'Best quality', hint: 'Listens to every sentence and re-records any glitch. Slowest, cleanest.'},
  '2': {name: 'Balanced quality', hint: 'Up to 2 takes per sentence. A good middle ground.'},
  '1': {name: 'Fast quality', hint: 'One take per sentence, no checking. Quickest.'},
};
const SEG_ON = ['bg-background', 'shadow-xs'], SEG_OFF = ['text-muted-foreground', 'hover:text-foreground'];
const CARD_ON = ['border-primary', 'ring-2', 'ring-primary'];

function currentPreset(){
  const v = {ex: +$('ex').value, cfg: +$('cfg').value, spd: +$('spd').value};
  return Object.keys(PRESETS).find(k => ['ex', 'cfg', 'spd'].every(f => Math.abs(PRESETS[k][f] - v[f]) < 0.001)) || 'custom';
}
function setSlider(id, v){ $(id).value = v; $(id).dispatchEvent(new Event('input')); }

function refreshGenerate(){
  const k = currentPreset();
  document.querySelectorAll('[data-preset]').forEach(b => {
    const on = b.dataset.preset === k;
    CARD_ON.forEach(c => b.classList.toggle(c, on)); b.setAttribute('aria-pressed', on);
  });
  $('tuneTag').textContent = k === 'custom' ? '(custom settings)' : '';
  const q = $('qual').value;
  document.querySelectorAll('[data-qual]').forEach(b => {
    const on = b.dataset.qual === q;
    SEG_ON.forEach(c => b.classList.toggle(c, on)); SEG_OFF.forEach(c => b.classList.toggle(c, !on)); b.setAttribute('aria-checked', on);
  });
  $('qualHint').textContent = (QUAL[q] || QUAL['3']).hint;
  const v = voiceList.find(x => x.id === $('voiceSel').value);
  const secs = Math.round(words($('text').value) / 2.6);
  $('genSummary').textContent = [v ? v.name : 'Default voice', k === 'custom' ? 'Custom delivery' : PRESETS[k].name,
    (QUAL[q] || QUAL['3']).name, secs ? '~' + fmtLong(secs) : ''].filter(Boolean).join('  ·  ');
}
function fmtLong(s){ return s >= 60 ? Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s' : s + ' s'; }

function saveTune(){ store.set('tune', JSON.stringify({ex: $('ex').value, cfg: $('cfg').value, spd: $('spd').value, qual: $('qual').value})); }
['ex', 'cfg', 'spd'].forEach(id => $(id).addEventListener('input', () => { refreshGenerate(); saveTune(); }));
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
  const p = PRESETS[b.dataset.preset];
  setSlider('ex', p.ex); setSlider('cfg', p.cfg); setSlider('spd', p.spd);
});
document.querySelectorAll('[data-qual]').forEach(b => b.onclick = () => { $('qual').value = b.dataset.qual; refreshGenerate(); saveTune(); });
try {   // restore the last settings
  const t = JSON.parse(store.get('tune') || 'null');
  if (t){ setSlider('ex', t.ex); setSlider('cfg', t.cfg); setSlider('spd', t.spd); if (QUAL[t.qual]) $('qual').value = t.qual; }
} catch (e){ /* keep defaults */ }
refreshGenerate();

/* ================================================================ video creation
   Styles (and their options, e.g. theme colors) come from the server (video/styles/*.py),
   so adding a style there makes it appear here automatically. */
const videoUrl = (project, file) => '/projects/' + encodeURIComponent(project) + '/videos/' + encodeURIComponent(file);
let vidStyles = null, vidImage = null, vidStyleId = store.get('videoStyle') || '', vidPollId = null, vidScriptSeq = 0;
let vidThemes = {};   // style id -> chosen theme id
try { vidThemes = JSON.parse(store.get('videoThemes') || '{}') || {}; } catch (e){ vidThemes = {}; }
let vidVals = {};     // style id -> {option key: value} for the color and font options
try { vidVals = JSON.parse(store.get('videoVals') || '{}') || {}; } catch (e){ vidVals = {}; }
const PANEL_SWATCHES = ['#0d0b1a', '#111111', '#1e293b', '#3b0764', '#f5f1e8', '#ffffff'];

/* the options the user has chosen for a style, in the form the server expects */
function collectVidOptions(st){
  const options = {};
  ((st && st.options) || []).forEach(o => {
    const v = (vidVals[st.id] || {})[o.key];
    if (o.type === 'theme'){
      const t = vidThemes[st.id];
      options[o.key] = t && o.choices.some(c => c.id === t) ? t : o.default;
    } else if (o.type === 'font' || o.type === 'choice'){
      options[o.key] = o.choices.some(c => c.id === v) ? v : (o.choices.some(c => c.id === o.default) ? o.default : o.choices[0].id);
    } else if (o.type === 'color'){
      options[o.key] = /^#[0-9a-f]{6}$/i.test(v || '') ? v : '';
    } else if (o.type === 'toggle'){
      options[o.key] = typeof v === 'boolean' ? v : !!o.default;
    } else if (o.type === 'range'){
      options[o.key] = Number.isFinite(v) ? Math.min(Math.max(v, o.min), o.max) : o.default;
    }
  });
  return options;
}
function setVidVal(st, key, val){
  (vidVals[st.id] = vidVals[st.id] || {})[key] = val;
  store.set('videoVals', JSON.stringify(vidVals));
}
/* a theme choice of a style (it carries the theme's default panel color as `bg`) */
const vidStyleThemes = (st, id) => {
  const o = ((st && st.options) || []).find(x => x.type === 'theme');
  return o && o.choices.find(c => c.id === id);
};

/* live preview: the server draws one frame with the chosen options (and the start of the entered text) */
let vidPreviewTimer = null, vidPreviewSeq = 0, vidPreviewAbort = null, vidPreviewUrl = null, vidShrunk = null;
function shrinkImage(file){   // small copy for the preview only (the real video uses the original)
  if (vidShrunk && vidShrunk.file === file) return Promise.resolve(vidShrunk.b64);
  return createImageBitmap(file).then(bm => {
    const k = Math.min(1, 1600 / Math.max(bm.width, bm.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bm.width * k)); c.height = Math.max(1, Math.round(bm.height * k));
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.85));
  }).then(blob => readB64(blob)).then(b64 => (vidShrunk = {file, b64}, b64));
}
function scheduleVidPreview(delay = 350){
  clearTimeout(vidPreviewTimer);
  vidPreviewTimer = setTimeout(refreshVidPreview, delay);
}
async function refreshVidPreview(){
  const st = vidStyles && vidStyles.find(x => x.id === vidStyleId);
  if (!st || !$('videoDialog').open) return;
  const seq = ++vidPreviewSeq;
  if (vidPreviewAbort) vidPreviewAbort.abort();
  const ctl = vidPreviewAbort = new AbortController();
  $('vidPreviewBusy').hidden = false; $('vidPreviewNote').textContent = '';
  try {
    const body = {style: st.id, options: collectVidOptions(st), text: $('vidText').value.trim().slice(0, 1200)};
    if (vidImage) body.image = await shrinkImage(vidImage);
    const r = await fetch('/api/video/preview', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                                 body: JSON.stringify(body), signal: ctl.signal});
    if (!r.ok){
      let msg = 'Could not make the preview.';
      try { msg = (await r.json()).error || msg; } catch (e){ /* keep */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await r.blob());
    if (seq !== vidPreviewSeq){ URL.revokeObjectURL(url); return; }
    if (vidPreviewUrl) URL.revokeObjectURL(vidPreviewUrl);
    vidPreviewUrl = url;
    $('vidPreview').src = url; $('vidPreview').hidden = false; $('vidPreviewEmpty').hidden = true;
  } catch (e){
    if (e.name === 'AbortError' || seq !== vidPreviewSeq) return;
    $('vidPreviewNote').textContent = e.message;
    if (!vidPreviewUrl) $('vidPreviewEmpty').textContent = 'No preview available.';
  } finally {
    if (seq === vidPreviewSeq) $('vidPreviewBusy').hidden = true;
  }
}

const readB64 = file => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(new Error('Could not read the file.'));
  r.readAsDataURL(file);
});

const VSEG_ON = 'bg-background font-medium shadow-sm', VSEG_OFF = 'text-muted-foreground hover:text-foreground';

function optionHtml(st, o, vals){
  const cur = vals[o.key], vv = (vidVals[st.id] || {})[o.key];
  if (o.type === 'theme') return `
    <div>
      <div class="mb-2 flex justify-between"><span class="label">${esc(o.label)}</span><span id="vidThemeName" class="hint">${esc((o.choices.find(c => c.id === cur) || {}).label || '')}</span></div>
      <div class="flex flex-wrap gap-2.5" role="radiogroup" aria-label="${esc(o.label)}">
        ${o.choices.map(c => `<button type="button" role="radio" aria-checked="${c.id === cur}" aria-label="${esc(c.label)}" title="${esc(c.label)}" data-theme="${esc(c.id)}" data-tlabel="${esc(c.label)}"
           class="size-8 cursor-pointer rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${c.id === cur ? 'border-foreground ring-2 ring-offset-2 ring-offset-card ring-foreground/40' : 'border-transparent'}"
           style="background:${esc(c.color)}"></button>`).join('')}
      </div>
    </div>`;
  if (o.type === 'color'){
    const tc = (vidStyleThemes(st, vals.theme) || {}).bg || '#000000';
    return `
    <div>
      <div class="mb-2 flex justify-between"><span class="label">${esc(o.label)}</span><span id="vidColorName" class="hint">${cur ? esc(cur) : 'Theme default'}</span></div>
      <div class="flex flex-wrap items-center gap-2">
        <input type="color" data-color="${esc(o.key)}" value="${esc(cur || tc)}" aria-label="${esc(o.label)}" class="h-8 w-12 cursor-pointer rounded-md border bg-transparent p-0.5">
        ${PANEL_SWATCHES.map(c => `<button type="button" data-swatch="${c}" data-color-key="${esc(o.key)}" aria-label="${c}" title="${c}" class="size-6 cursor-pointer rounded-full border-2 border-border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" style="background:${c}"></button>`).join('')}
        <button type="button" data-color-reset="${esc(o.key)}" class="btn btn-outline btn-sm">Theme default</button>
      </div>
      ${o.hint ? `<p class="hint mt-1.5">${esc(o.hint)}</p>` : ''}
    </div>`;
  }
  if (o.type === 'font'){
    const css = (o.choices.find(c => c.id === cur) || {}).css || 'inherit';
    return `
    <div>
      <label class="label mb-2 block" for="vidOpt_${esc(o.key)}">${esc(o.label)}</label>
      <select id="vidOpt_${esc(o.key)}" data-font="${esc(o.key)}" class="input" style="font-family:${esc(css)}">
        ${o.choices.map(c => `<option value="${esc(c.id)}" style="font-family:${esc(c.css)}" ${c.id === cur ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select>
    </div>`;
  }
  if (o.type === 'choice') return `
    <div>
      <div class="label mb-2">${esc(o.label)}</div>
      <div class="flex w-full rounded-lg border bg-muted p-0.5" role="radiogroup" aria-label="${esc(o.label)}">
        ${o.choices.map(c => `<button type="button" role="radio" aria-checked="${c.id === cur}" data-choice-key="${esc(o.key)}" data-choice="${esc(c.id)}"
           class="flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${c.id === cur ? VSEG_ON : VSEG_OFF}">${esc(c.label)}</button>`).join('')}
      </div>
    </div>`;
  if (o.type === 'toggle') return `
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="label">${esc(o.label)}</span>
      <input type="checkbox" role="switch" data-toggle="${esc(o.key)}" ${cur ? 'checked' : ''}
        class="relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-border transition-colors checked:bg-primary before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-background before:transition-transform checked:before:translate-x-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
    </label>`;
  if (o.type === 'range') return `
    <div>
      <div class="mb-2 flex justify-between"><label class="label" for="vidOpt_${esc(o.key)}">${esc(o.label)}</label><span class="hint tabular-nums" data-range-val="${esc(o.key)}">${cur}${esc(o.unit ? ' ' + o.unit : '')}</span></div>
      <input id="vidOpt_${esc(o.key)}" type="range" data-range="${esc(o.key)}" min="${o.min}" max="${o.max}" step="${o.step || 1}" value="${cur}" class="w-full">
    </div>`;
  if (o.type === 'image') return `
    <div>
      <div class="mb-2 flex justify-between"><label class="label" for="vidOpt_${esc(o.key)}">${esc(o.label)}</label><span class="hint">Optional</span></div>
      <input id="vidOpt_${esc(o.key)}" data-opt="${esc(o.key)}" type="file" accept="image/png,image/jpeg,image/webp" class="w-full rounded-md border border-dashed bg-muted p-1.5 text-xs file:mr-2 file:rounded-sm file:border file:bg-background file:px-2.5 file:py-1 file:text-xs file:font-medium">
      <p class="hint mt-1.5">${esc(o.hint || '')}</p>
    </div>`;
  return '';
}

function renderVideoStyles(){
  $('vidStyles').innerHTML = vidStyles.map(st => `
    <button type="button" data-style="${esc(st.id)}" class="flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${st.id === vidStyleId ? 'border-primary ring-2 ring-primary' : ''}" aria-pressed="${st.id === vidStyleId}">
      ${st.preview ? `<img class="aspect-video w-28 shrink-0 rounded-md object-cover" src="${esc(st.preview)}" alt="">` : ''}
      <span class="min-w-0"><span class="block font-medium">${esc(st.name)}</span><span class="hint block">${esc(st.description)}</span></span>
    </button>`).join('');
  $('vidStyles').querySelectorAll('[data-style]').forEach(b => b.onclick = () => { vidStyleId = b.dataset.style; store.set('videoStyle', vidStyleId); vidImage = null; renderVideoStyles(); });
  const st = vidStyles.find(x => x.id === vidStyleId);
  const vals = collectVidOptions(st), box = $('vidOptions');
  const groups = [];
  ((st && st.options) || []).forEach(o => {
    const g = o.group || 'Options';
    (groups.find(x => x.name === g) || (groups.push({name: g, opts: []}), groups[groups.length - 1])).opts.push(o);
  });
  box.innerHTML = groups.map(g => `
    <details open class="group rounded-lg border">
      <summary class="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
        ${esc(g.name)}<span class="text-muted-foreground transition-transform group-open:rotate-180">${lu('chevron-down')}</span>
      </summary>
      <div class="space-y-4 border-t px-4 py-4">
        ${g.opts.map(o => `<div data-wrap="${esc(o.key)}" ${!o.show_if || vals[o.show_if.key] === o.show_if.value ? '' : 'hidden'}>${optionHtml(st, o, vals)}</div>`).join('')}
      </div>
    </details>`).join('');

  const changed = () => {   // an option changed: show/hide the options that depend on it, then refresh the preview
    const v = collectVidOptions(st);
    st.options.filter(o => o.show_if).forEach(o => {
      box.querySelector(`[data-wrap="${o.key}"]`).hidden = v[o.show_if.key] !== o.show_if.value;
    });
    scheduleVidPreview();
  };
  const setColor = (key, val) => {
    setVidVal(st, key, val);
    box.querySelector(`[data-color="${key}"]`).value = val || ((vidStyleThemes(st, collectVidOptions(st).theme) || {}).bg || '#000000');
    $('vidColorName').textContent = val || 'Theme default';
    changed();
  };
  box.querySelectorAll('[data-color]').forEach(i => i.oninput = () => setColor(i.dataset.color, i.value));
  box.querySelectorAll('[data-swatch]').forEach(b => b.onclick = () => setColor(b.dataset.colorKey, b.dataset.swatch));
  box.querySelectorAll('[data-color-reset]').forEach(b => b.onclick = () => setColor(b.dataset.colorReset, ''));
  box.querySelectorAll('[data-font]').forEach(sel => sel.onchange = () => {
    setVidVal(st, sel.dataset.font, sel.value);
    sel.style.fontFamily = (sel.selectedOptions[0] || {}).style.fontFamily || 'inherit';
    changed();
  });
  box.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => {
    setVidVal(st, b.dataset.choiceKey, b.dataset.choice);
    box.querySelectorAll(`[data-choice-key="${b.dataset.choiceKey}"]`).forEach(x => {
      const on = x === b;
      x.setAttribute('aria-checked', on);
      VSEG_ON.split(' ').forEach(c => x.classList.toggle(c, on));
      VSEG_OFF.split(' ').forEach(c => x.classList.toggle(c, !on));
    });
    changed();
  });
  box.querySelectorAll('[data-toggle]').forEach(i => i.onchange = () => { setVidVal(st, i.dataset.toggle, i.checked); changed(); });
  box.querySelectorAll('[data-range]').forEach(i => {
    const o = st.options.find(x => x.key === i.dataset.range);
    i.oninput = () => {
      setVidVal(st, o.key, Number(i.value));
      box.querySelector(`[data-range-val="${o.key}"]`).textContent = i.value + (o.unit ? ' ' + o.unit : '');
      changed();
    };
  });
  box.querySelectorAll('[data-opt]').forEach(i => i.onchange = () => { vidImage = i.files[0] || null; scheduleVidPreview(100); });
  box.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => {
    vidThemes[st.id] = b.dataset.theme; store.set('videoThemes', JSON.stringify(vidThemes));
    box.querySelectorAll('[data-theme]').forEach(x => {
      const on = x === b;
      x.setAttribute('aria-checked', on);
      x.classList.toggle('border-foreground', on); x.classList.toggle('border-transparent', !on);
      ['ring-2', 'ring-offset-2', 'ring-offset-card', 'ring-foreground/40'].forEach(c => x.classList.toggle(c, on));
    });
    $('vidThemeName').textContent = b.dataset.tlabel;
    const ci = box.querySelector('[data-color]');   // the picker shows the theme's panel color until changed
    if (ci && !(vidVals[st.id] || {}).panel_color) ci.value = (vidStyleThemes(st, b.dataset.theme) || {}).bg || ci.value;
    scheduleVidPreview(150);
  });
  scheduleVidPreview(150);
}

async function loadVidScript(file){
  const seq = ++vidScriptSeq;
  $('vidText').value = ''; $('vidTextHint').textContent = '';
  if (!file) return;
  try {
    const r = await api.get(qp('/api/script', {project: curProject(), file}));
    if (seq !== vidScriptSeq) return;
    $('vidText').value = r.text || '';
    $('vidTextHint').textContent = r.text ? 'Filled in from the text this audio was generated from.'
      : 'This audio was made before scripts were saved. Paste its exact text.';
    scheduleVidPreview(100);
  } catch (e){ /* leave empty */ }
}

/* Opens the "New video" dialog. `file` (optional) preselects an audio file. */
async function openVideoDialog(file){
  $('vidErr').hidden = true; vidImage = null; $('vidGo').disabled = false;
  let files, names = {};
  try {
    if (!vidStyles) vidStyles = await api.get('/api/video/styles');
    files = await api.get(qp('/api/files', {project: curProject()}));
    names = await api.get(qp('/api/audio-names', {project: curProject()})).catch(() => ({}));
  } catch (e){ toast(e.message); return; }
  if (!files.length){ toast('Generate some audio first, then make a video from it.'); return; }
  if (!vidStyles.length){ toast('No video styles are installed.'); return; }
  if (!vidStyles.some(x => x.id === vidStyleId)) vidStyleId = vidStyles[0].id;
  $('vidAudio').innerHTML = files.map(f => `<option value="${esc(f)}">${esc(names[f] ? names[f] + ' · ' + f : f)}</option>`).join('');
  $('vidAudio').value = files.includes(file) ? file : files[0];
  renderVideoStyles();
  $('videoDialog').showModal();
  loadVidScript($('vidAudio').value);
}
$('vidAudio').onchange = () => loadVidScript($('vidAudio').value);
$('vidText').onchange = () => scheduleVidPreview(100);
$('vidCancel').onclick = $('vidClose').onclick = () => $('videoDialog').close();
$('newVideoBtn').onclick = () => openVideoDialog();
$('videoForm').onsubmit = async ev => {
  ev.preventDefault();
  const err = $('vidErr'); err.hidden = true;
  const text = $('vidText').value.trim();
  if (!text){ err.textContent = 'Enter the text that was spoken in this audio.'; err.hidden = false; return; }
  $('vidGo').disabled = true;
  try {
    const st = vidStyles.find(x => x.id === vidStyleId);
    const options = collectVidOptions(st);
    const body = {project: curProject(), file: $('vidAudio').value, style: vidStyleId, text, options};
    if (vidImage) body.image = await readB64(vidImage);
    const j = await api.post('/api/video', body);
    $('videoDialog').close();
    if (currentRoute() !== 'videos') location.hash = '#/videos';
    pollVideo(j.id, curProject());
  } catch (e){ err.textContent = e.message; err.hidden = false; $('vidGo').disabled = false; }
};

async function pollVideo(id, project){
  vidPollId = id;
  const bar = $('vidActive');
  bar.hidden = false; $('vidProg').style.width = '0%'; $('vidPct').textContent = ''; $('vidStatus').textContent = 'Queued...';
  let failures = 0;
  while (vidPollId === id){
    let j;
    try { j = await api.get('/api/video/jobs/' + encodeURIComponent(id)); failures = 0; }
    catch (e){
      if (e.network && ++failures < 8){ await sleep(2000); continue; }
      bar.hidden = true; vidPollId = null; toast('Video: ' + e.message); return;
    }
    if (j.status === 'done'){
      bar.hidden = true; vidPollId = null;
      toast('Video ready: ' + j.file);
      if (currentRoute() === 'videos' && curProject() === project) loadVideos();
      return;
    }
    if (j.status === 'error'){ bar.hidden = true; vidPollId = null; toast(j.error || 'Video creation failed.', 6000); return; }
    const label = {queued: 'Queued...', 'loading alignment model': 'Loading the alignment model...',
                   aligning: 'Matching the text to the audio...', rendering: 'Rendering video...'}[j.status] || 'Working...';
    let pct = 0;
    if (j.status === 'rendering' && j.total) pct = Math.round(j.done / j.total * 100);
    else if (j.status === 'aligning' && j.alignTotal) pct = Math.round(j.alignDone / j.alignTotal * 100);
    const showPct = (j.status === 'rendering' && j.total) || (j.status === 'aligning' && j.alignTotal);
    $('vidStatus').textContent = label + (j.elapsed != null && j.status !== 'queued' ? ` (${fmt(j.elapsed)})` : '');
    $('vidProg').style.width = pct + '%'; $('vidPct').textContent = showPct ? pct + '%' : '';
    await sleep(1500);
  }
}

let videoLoadSeq = 0;
async function loadVideos(){
  const p = curProject(), seq = ++videoLoadSeq;
  const box = $('videoList');
  let files;
  try { files = await api.get(qp('/api/videos', {project: p})); }
  catch (e){ if (seq === videoLoadSeq) box.innerHTML = `<div class="px-5 py-12 text-center text-destructive">${esc(e.message)}</div>`; return; }
  if (seq !== videoLoadSeq) return;
  if (!files.length){
    box.innerHTML = `<div class="px-5 py-12 text-center text-muted-foreground">No videos yet. Click <b>New video</b> to make one from your audio.</div>`;
    return;
  }
  box.innerHTML = files.map(f => `
    <div class="p-4 md:px-5" data-vfile="${esc(f)}">
      <div class="flex items-center gap-3">
        <div class="flex min-w-0 flex-1 items-center gap-1.5" data-vnamebox><span class="truncate font-mono text-xs" title="${esc(f)}">${esc(f)}</span>${renameBtn('data-vrename', f)}</div>
        <button class="btn btn-outline btn-sm" data-vplay>${ICON.play}Watch</button>
        <a class="btn btn-outline btn-sm" href="${videoUrl(p, f)}" download>${ICON.dl}<span class="hidden sm:inline">Download</span></a>
      </div>
    </div>`).join('');
  box.onclick = ev => {
    const b = ev.target.closest('[data-vrename]');
    if (!b) return;
    const f = b.closest('[data-vfile]').dataset.vfile;
    inlineRename(b.closest('[data-vnamebox]'), {value: f.replace(/\.mp4$/i, ''), suffix: '.mp4', maxlength: 80, onSave: async name => {
      const r = await api.post('/api/video/rename', {project: p, file: f, name});
      toast('Renamed to ' + r.file);
      loadVideos();
    }});
  };
  box.querySelectorAll('[data-vplay]').forEach(b => b.onclick = () => {
    const row = b.closest('[data-vfile]');
    const old = row.querySelector('video');
    if (old){ old.pause(); old.remove(); return; }
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.className = 'mt-3 w-full rounded-lg bg-black';
    v.src = videoUrl(p, row.dataset.vfile);
    row.appendChild(v);
  });
}

/* ================================================================ editor (timeline)
   The editing rules live in editor_core.js (pure functions, tested with Node). This section is the screen:
   timeline drawing, dragging, the player, the side panels and keyboard shortcuts.
   The timeline (ed.tl) is saved to the server a moment after every change. */
const EC = EditorCore;
const ed = {
  lib: {}, tl: {clips: [], fade_in: false, fade_out: false, fade_len: 1, audio: []}, sel: -1, t: 0, playing: false,
  alib: {}, audioFiles: [], asel: -1, live: null,   // audio track: file lengths, the files available, selected piece, slider edit in progress
  z: 40, tab: 'clips', jobId: null, uid: 0, saveTimer: null, hist: new EC.History(), name: '',
  cur: 0, pi: 0, prep: null, raf: 0, drag: null, loadTok: [0, 0], fitted: false,
};
try { const z = parseFloat(store.get('edZoom')); if (z >= 2 && z <= 200){ ed.z = z; ed.fitted = true; } } catch (e){ /* default zoom */ }
const edV = [$('edV0'), $('edV1')];                       // two players: the next clip is made ready in the idle one
const edUrl = f => videoUrl(curProject(), f);
const edStrip = f => qp('/api/editor/strip', {project: curProject(), file: f}) + '&v=' + (ed.lib[f] || 0);
const edL = () => EC.layout(ed.tl, ed.lib);
const edClip = i => ed.tl.clips[i];
const edAudioUrl = a => '/projects/' + encodeURIComponent(curProject()) + (a.src === 'music' ? '/music/' : '/') + encodeURIComponent(a.file);
const edWave = a => qp('/api/editor/wave', {project: curProject(), src: a.src, file: a.file}) + '&v=' + (EC.aDur(ed.alib, a) || 0);
const edAudioName = a => ((ed.audioFiles.find(x => x.src === a.src && x.file === a.file) || {}).label) || a.file;   // display name, else the file
const edVol = c => (c && c.volume != null ? c.volume : 1);
const edPct = v => Math.round(v * 100);
const edPctText = v => (v < 0.005 ? 'Muted' : edPct(v) + '%');
const AUD_H = 44;
const edT = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0'); };
const natural = (a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
const JOIN_LABELS = {cut: 'Cut', fade: 'Crossfade', dip: 'Dip to black'};
const JOIN_ICONS = {cut: 'chevrons-left-right', fade: 'blend', dip: 'moon'};
const CELL_W = 128, CELL_H = 72;                           // one filmstrip frame on the timeline
const SWITCH = 'relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-border transition-colors checked:bg-primary before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-background before:transition-transform checked:before:translate-x-4';

/* ---------------------------------------------------------------- loading and saving */
async function loadEditor(){
  const p = curProject();
  let r;
  try { r = await api.get(qp('/api/editor', {project: p})); } catch (e){ toast(e.message); return; }
  if (p !== curProject() || currentRoute() !== 'editor') return;
  edPause();
  edStopAudio();
  edSetLib(r);
  const saved = r.timeline.clips, savedAudio = r.timeline.audio || [];
  const audio = savedAudio.filter(a => ed.alib[a.src + ':' + a.file]).map(a => ({...a, uid: ++ed.uid}));
  ed.tl = {...r.timeline, clips: saved.filter(c => ed.lib[c.file]).map(c => ({...c, uid: ++ed.uid})), audio};
  if (ed.tl.clips.length < saved.length) toast(`${saved.length - ed.tl.clips.length} clip(s) were removed because their video files no longer exist.`, 5000);
  if (audio.length < savedAudio.length) toast(`${savedAudio.length - audio.length} audio piece(s) were removed because their files no longer exist.`, 5000);
  ed.asel = -1; ed.live = null;
  ed.hist.clear(); ed.sel = ed.tl.clips.length ? 0 : -1; ed.t = 0; ed.prep = null; ed.cur = 0; ed.pi = 0;
  edV.forEach(v => { v.removeAttribute('src'); delete v.dataset.file; v.load(); });
  ed.tab = ed.tl.clips.length ? 'clip' : 'clips';
  if (!ed.fitted) edFit(false);
  $('edZoom').value = ed.z;
  edRenderAll();
  edSeek(0);
}
function edSetLib(r){   // the clips and audio files the project has, with their lengths
  ed.lib = {}; ed.alib = {};
  r.clips.forEach(c => { ed.lib[c.file] = c.seconds; });
  ed.audioFiles = r.audio || [];
  ed.audioFiles.forEach(a => { ed.alib[a.src + ':' + a.file] = a.seconds; });
}
async function edRefreshLib(){   // after an export: show the new video in "Your clips" without touching the timeline
  const p = curProject();
  try {
    const r = await api.get(qp('/api/editor', {project: p}));
    if (p !== curProject() || currentRoute() !== 'editor') return;
    edSetLib(r);
    edRenderPanel();
  } catch (e){ /* cosmetic */ }
}
function edSave(){
  clearTimeout(ed.saveTimer);
  const p = curProject();
  ed.saveTimer = setTimeout(() => api.post('/api/editor/save', {project: p, timeline: ed.tl}).catch(() => {}), 500);
}
/* every edit goes through here: remembered for undo, saved, redrawn */
function edCommit(next, opts = {}){
  if (JSON.stringify(next) === JSON.stringify(ed.tl)) return;
  ed.hist.push(ed.tl);
  ed.tl = next;
  if (opts.select != null) ed.sel = opts.select;
  edAfterChange();
}
function edAfterChange(){
  edPause();
  ed.sel = ed.tl.clips.length ? Math.min(ed.sel, ed.tl.clips.length - 1) : -1;
  ed.asel = (ed.tl.audio || []).length ? Math.min(ed.asel, ed.tl.audio.length - 1) : -1;
  ed.t = EC.clamp(ed.t, 0, edL().total);
  ed.prep = null;
  edSave();
  edRenderAll();
  edSeek(ed.t);
}
function edUndo(){ const r = ed.hist.undo(ed.tl); if (r){ ed.tl = r; edAfterChange(); } }
function edRedo(){ const r = ed.hist.redo(ed.tl); if (r){ ed.tl = r; edAfterChange(); } }

/* ---------------------------------------------------------------- drawing */
function edRenderAll(){ edRenderTimeline(); edRenderPanel(); edRenderChrome(); }

function edRenderChrome(){
  const n = ed.tl.clips.length, L = edL();
  document.querySelectorAll('[data-tab]').forEach(b => {
    const on = b.dataset.tab === ed.tab;
    b.classList.toggle('bg-accent', on); b.classList.toggle('text-foreground', on); b.setAttribute('aria-selected', on);
  });
  $('edUndo').disabled = !ed.hist.canUndo; $('edRedo').disabled = !ed.hist.canRedo;
  $('edExport').disabled = !n || !!ed.jobId;
  ['edSplit', 'edDup', 'edDel'].forEach(id => { $(id).disabled = !n || (id !== 'edSplit' && ed.sel < 0 && ed.asel < 0); });
  ['edPrev', 'edPlay', 'edNext'].forEach(id => { $(id).disabled = !n; });
  $('edEmpty').hidden = n > 0;
  const exp = EC.exportLength(ed.tl, ed.lib);
  $('edTotal').textContent = n ? `${n} clip${n === 1 ? '' : 's'} · ${edT(L.total)}` + (L.total - exp > 0.05 ? ` · exports as ${edT(exp)}` : '') : '';
  $('edInfo').textContent = n ? (EC.isFastJoin(ed.tl, ed.lib) ? 'Export is instant (no re-encoding)' : 'Export re-encodes the video') : '';
  edRenderClock();
  edPlayIcon();
}
function edRenderClock(){
  const L = edL();
  $('edClock').textContent = L.total ? edT(ed.t) : '';
  $('edTime').textContent = L.total ? `${edT(ed.t)} / ${edT(L.total)}` : '';
}
function edPlayIcon(){
  const b = $('edPlay');
  b.innerHTML = lu(ed.playing ? 'pause' : 'play');
  b.setAttribute('aria-label', ed.playing ? 'Pause' : 'Play');
}

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function edRenderTimeline(){
  const L = edL(), z = ed.z, sc = $('edScroll');
  const width = Math.max(sc.clientWidth, Math.ceil(edSpan() * z) + 240);
  $('edInner').style.width = width + 'px';

  // ruler: a labelled tick at least ~90px apart, lighter ticks between
  const step = RULER_STEPS.find(s => s * z >= 90) || 3600;
  const minor = step * z / 5 >= 8 ? step / 5 : 0, unit = minor || step, per = Math.round(step / unit);
  let ruler = '';
  for (let k = 0, n = Math.floor(width / z / unit); k <= n; k++){
    const t = k * unit, major = k % per === 0, x = t * z;
    ruler += `<div class="absolute bottom-0 border-l ${major ? 'h-3 border-border' : 'h-1.5 border-border/60'}" style="left:${x}px"></div>`;
    if (major) ruler += `<span class="absolute top-0.5 pl-1 text-[10px] tabular-nums text-muted-foreground" style="left:${x}px">${step < 1 ? t.toFixed(1) : Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0')}</span>`;
  }
  $('edRuler').innerHTML = ruler;

  // clips: a block per clip with a filmstrip, trim handles on both edges and a marker for the join before it
  const clips = ed.tl.clips;
  let html = '';
  clips.forEach((c, i) => {
    const w = Math.max(L.lens[i] * z - 2, 6), on = i === ed.sel;
    const cw = Math.max(CELL_W, w / 300), cells = Math.ceil(w / cw);
    const d = ed.lib[c.file] || 1, s = EC.startOf(ed.lib, c), len = L.lens[i];
    let strip = '';
    for (let j = 0; j < cells; j++){
      const idx = EC.clamp(Math.floor(Math.min(s + (j + 0.5) * cw / z, s + len) / d * 10), 0, 9);   // frame shown in this cell
      strip += `<div class="shrink-0" style="width:${cw}px;height:${CELL_H}px;background:var(--strip) ${-idx * cw}px 0 / ${10 * cw}px ${CELL_H}px"></div>`;
    }
    html += `<div class="group absolute top-1 cursor-pointer overflow-hidden rounded-lg border-2 bg-neutral-800 ${on ? 'border-primary' : 'border-transparent'}"
        style="left:${L.starts[i] * z}px;width:${w}px;height:${CELL_H + 4}px;--strip:url('${edStrip(c.file)}')" data-block="${i}">
      <div class="pointer-events-none absolute inset-0 flex">${strip}</div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-3 pb-1 pt-5 text-[10px] leading-none text-white" data-label="${i}"></div>
      <div class="absolute inset-y-0 left-0 w-3 cursor-ew-resize bg-primary ${on ? '' : 'opacity-0 group-hover:opacity-80'}" data-handle="start" title="Drag to trim the start"></div>
      <div class="absolute inset-y-0 right-0 w-3 cursor-ew-resize bg-primary ${on ? '' : 'opacity-0 group-hover:opacity-80'}" data-handle="end" title="Drag to trim the end"></div>
    </div>`;
    if (i) html += `<button type="button" class="absolute z-10 grid size-5 -translate-x-1/2 place-items-center rounded-full border bg-background shadow-sm hover:bg-accent [&_svg]:size-3" style="left:${L.starts[i] * z}px;top:2px"
        data-marker="${i}" title="Join: ${JOIN_LABELS[c.join]}${c.join === 'cut' ? '' : ' ' + c.join_len + 's'}" aria-label="Join: ${JOIN_LABELS[c.join]}">${lu(JOIN_ICONS[c.join])}</button>`;
  });
  html += '<div id="edDrop" class="absolute inset-y-0 z-30 w-0.5 bg-primary" hidden></div>';
  if (!clips.length) html = '<div class="px-4 py-6 text-sm text-muted-foreground">The timeline is empty. Add clips from <b>Your clips</b>.</div>';
  $('edTrack').innerHTML = html;
  edLabels();
  edRenderAudio();
  edPlayhead();
}
/* the whole length shown on the timeline: the video, or the audio if it runs longer */
function edSpan(){
  let end = edL().total;
  (ed.tl.audio || []).forEach(a => { end = Math.max(end, a.at + EC.aLen(ed.alib, a)); });
  return end;
}
/* the audio lane: a block per piece with its waveform, stacked in rows when pieces overlap in time */
function edRenderAudio(){
  const box = $('edAudioTrack'), z = ed.z, items = ed.tl.audio || [], L = edL();
  if (!items.length){
    box.style.height = '2.5rem';
    box.innerHTML = '<div class="px-3 py-2.5 text-xs text-muted-foreground">Audio track: add narration or music with the <b>Audio</b> tool on the left.</div>';
    return;
  }
  const {rows, count} = EC.audioRows(ed.tl, ed.alib);
  box.style.height = (count * (AUD_H + 4) + 8) + 'px';
  box.innerHTML = items.map((a, i) => {
    const len = EC.aLen(ed.alib, a), s = EC.aStart(ed.alib, a), d = EC.aDur(ed.alib, a) || 1;
    const w = Math.max(len * z, 8), on = i === ed.asel, past = Math.max(0, (a.at + len - L.total) * z);
    return `<div class="group absolute cursor-pointer overflow-hidden rounded-md border-2 bg-emerald-800 ${on ? 'border-primary' : 'border-emerald-600/60'}"
        style="left:${a.at * z}px;top:${4 + rows[i] * (AUD_H + 4)}px;width:${w}px;height:${AUD_H}px" data-ablock="${i}">
      <div class="pointer-events-none absolute inset-0 opacity-80 mix-blend-screen" style="background:url('${edWave(a)}') ${-s * z}px 0 / ${d * z}px 100% no-repeat"></div>
      ${past > 1 ? `<div class="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style="width:${Math.min(past, w)}px" title="Past the end of the video: not heard"></div>` : ''}
      <div class="pointer-events-none absolute inset-x-2.5 top-0.5 truncate text-[10px] font-medium leading-4 text-white drop-shadow" data-alabel="${i}"></div>
      <div class="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-primary ${on ? '' : 'opacity-0 group-hover:opacity-80'}" data-ahandle="start" title="Drag to trim the start"></div>
      <div class="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-primary ${on ? '' : 'opacity-0 group-hover:opacity-80'}" data-ahandle="end" title="Drag to trim the end"></div>
    </div>`;
  }).join('');
  edAudioLabels();
}
function edAudioLabels(){
  document.querySelectorAll('[data-alabel]').forEach(el => {
    const a = (ed.tl.audio || [])[+el.dataset.alabel];
    if (a){ const nm = edAudioName(a); el.textContent = `${nm === a.file ? nm.replace(/\.[^.]+$/, '') : nm} · ${edPctText(a.volume)}`; }
  });
}
/* texts and sizes that change while a clip is being trimmed (cheap: no redraw of the filmstrips) */
function edLabels(){
  const L = edL();
  document.querySelectorAll('[data-label]').forEach(el => {
    const i = +el.dataset.label, c = edClip(i);
    if (c) el.textContent = `${c.file.replace(/\.mp4$/i, '')} · ${edT(L.lens[i])}`;
  });
}
function edLayoutLive(){
  const L = edL(), z = ed.z;
  document.querySelectorAll('[data-block]').forEach(el => {
    const i = +el.dataset.block;
    el.style.left = L.starts[i] * z + 'px'; el.style.width = Math.max(L.lens[i] * z - 2, 6) + 'px';
  });
  document.querySelectorAll('[data-marker]').forEach(el => { el.style.left = L.starts[+el.dataset.marker] * z + 'px'; });
  $('edInner').style.width = Math.max($('edScroll').clientWidth, Math.ceil(edSpan() * z) + 240) + 'px';
  edLabels(); edRenderClock(); edRenderAudio();
  $('edTotal').textContent = `${ed.tl.clips.length} clips · ${edT(L.total)}`;
}
function edPlayhead(){ $('edHead').style.left = ed.t * ed.z + 'px'; }
function edKeepVisible(){
  const sc = $('edScroll'), x = ed.t * ed.z;
  if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
}

/* ---------------------------------------------------------------- zoom */
function edSetZoom(z, anchorX){
  const sc = $('edScroll'), r = $('edInner').getBoundingClientRect();
  const anchorT = anchorX != null ? (anchorX - r.left) / ed.z : ed.t;
  ed.z = EC.clamp(z, 2, 200); ed.fitted = true;
  store.set('edZoom', String(ed.z));
  $('edZoom').value = ed.z;
  edRenderTimeline();
  const screenX = anchorX != null ? anchorX - sc.getBoundingClientRect().left : sc.clientWidth * 0.3;
  sc.scrollLeft = Math.max(0, anchorT * ed.z - screenX);
}
function edFit(apply = true){
  const total = edL().total || 10;
  const z = EC.clamp(($('edScroll').clientWidth - 260) / total, 2, 200);
  if (apply) edSetZoom(z); else { ed.z = z; }
}
$('edZoom').oninput = () => edSetZoom(+$('edZoom').value);
$('edZoomIn').onclick = () => edSetZoom(ed.z * 1.3);
$('edZoomOut').onclick = () => edSetZoom(ed.z / 1.3);
$('edFit').onclick = () => { edFit(true); $('edScroll').scrollLeft = 0; };
$('edScroll').addEventListener('wheel', ev => {
  if (!ev.ctrlKey) return;
  ev.preventDefault();
  edSetZoom(ed.z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX);
}, {passive: false});

/* ---------------------------------------------------------------- the player */
function edShow(k){ edV.forEach((v, j) => { v.classList.toggle('opacity-0', j !== k); v.classList.toggle('pointer-events-none', j !== k); }); }
function edLoadInto(k, i, src, done){
  const el = edV[k], c = edClip(i);
  if (!c) return;
  const tok = ++ed.loadTok[k];
  const go = () => { if (tok !== ed.loadTok[k]) return; try { el.currentTime = src; } catch (e){ /* not ready */ } if (done) done(); };
  if (el.dataset.file === c.file && el.readyState >= 1) go();
  else { el.dataset.file = c.file; el.src = edUrl(c.file); el.addEventListener('loadedmetadata', go, {once: true}); }
}
function edSeek(t){
  const L = edL();
  ed.t = EC.clamp(t, 0, L.total);
  const loc = EC.locate(ed.tl, ed.lib, ed.t);
  if (!loc){ edPlayhead(); edRenderClock(); return; }
  ed.pi = loc.i;
  if (ed.prep && ed.prep.i !== loc.i + 1) ed.prep = null;
  edShow(ed.cur);
  edLoadInto(ed.cur, loc.i, loc.src, () => { if (ed.playing) edV[ed.cur].play().catch(() => {}); });
  edPlayhead(); edRenderClock();
}
/* Sound in the preview goes through Web Audio, so volumes above 100% and fades work and everything is mixed live. */
let edAC = null;
const edVG = [null, null];      // volume of each of the two players
const edAud = new Map();        // audio piece uid -> {el, g}
function edEnsureAudioCtx(){
  if (!edAC){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    edAC = new AC();
    edV.forEach((v, k) => {
      const g = edAC.createGain();
      edAC.createMediaElementSource(v).connect(g);
      g.connect(edAC.destination);
      edVG[k] = g;
    });
  }
  if (edAC.state === 'suspended') edAC.resume();
  return true;
}
function edApplyClipGain(){
  if (edVG[ed.cur]) edVG[ed.cur].gain.value = edVol(edClip(ed.pi));
}
function edSyncAudio(){   // start, stop and set the volume of every audio piece for the playhead position
  if (!edAC) return;
  const items = ed.tl.audio || [], seen = new Set(), t = ed.t;
  items.forEach(a => {
    seen.add(a.uid);
    let o = edAud.get(a.uid);
    if (!o){
      const el = new Audio();
      el.preload = 'auto'; el.src = edAudioUrl(a);
      const g = edAC.createGain();
      edAC.createMediaElementSource(el).connect(g);
      g.connect(edAC.destination);
      o = {el, g};
      edAud.set(a.uid, o);
    }
    const len = EC.aLen(ed.alib, a), end = a.at + len;
    if (t >= a.at && t < end){
      const want = EC.aStart(ed.alib, a) + (t - a.at);
      if (o.el.paused || Math.abs(o.el.currentTime - want) > 0.35){
        try { o.el.currentTime = want; } catch (e){ /* not ready yet */ }
        o.el.play().catch(() => {});
      }
      let g = a.volume;
      if (a.fade_in > 0.01 && t - a.at < a.fade_in) g *= Math.max(0, (t - a.at) / a.fade_in);
      if (a.fade_out > 0.01 && end - t < a.fade_out) g *= Math.max(0, (end - t) / a.fade_out);
      o.g.gain.value = g;
    } else if (!o.el.paused) o.el.pause();
  });
  edAud.forEach((o, uid) => { if (!seen.has(uid)){ o.el.pause(); edAud.delete(uid); } });   // removed from the timeline
}
function edStopAudio(){ edAud.forEach(o => o.el.pause()); edAud.clear(); }
function edPlayStart(){
  const L = edL();
  if (!L.total) return;
  edEnsureAudioCtx();
  if (ed.t >= L.total - 0.05) edSeek(0);
  ed.playing = true;
  edV[ed.cur].play().catch(() => {});
  edPlayIcon();
  cancelAnimationFrame(ed.raf);
  ed.raf = requestAnimationFrame(edTick);
}
function edPause(){
  ed.playing = false;
  edV.forEach(v => v.pause());
  edAud.forEach(o => o.el.pause());
  cancelAnimationFrame(ed.raf);
  edPlayIcon();
}
const edToggle = () => (ed.playing ? edPause() : edPlayStart());
function edTick(){
  if (!ed.playing) return;
  const v = edV[ed.cur], c = edClip(ed.pi);
  if (!c){ edPause(); return; }
  const L = edL(), e = EC.endOf(ed.lib, c);
  if (v.readyState >= 2 && !v.seeking){
    if (v.currentTime >= e - 0.04 || v.ended) edAdvance();
    else {
      ed.t = L.starts[ed.pi] + Math.max(0, v.currentTime - EC.startOf(ed.lib, c));
      if (e - v.currentTime < 2 && ed.pi < ed.tl.clips.length - 1) edPrepare(ed.pi + 1);
    }
  }
  edApplyClipGain(); edSyncAudio();
  edPlayhead(); edKeepVisible(); edRenderClock();
  ed.raf = requestAnimationFrame(edTick);
}
/* the next clip is made ready in the idle player, so playback moves on without a pause */
function edPrepare(i){
  if (ed.prep && ed.prep.i === i) return;
  ed.prep = {i, ready: false};
  edLoadInto(ed.cur ^ 1, i, EC.startOf(ed.lib, edClip(i)), () => { if (ed.prep && ed.prep.i === i) ed.prep.ready = true; });
}
function edAdvance(){
  const ni = ed.pi + 1;
  if (ni >= ed.tl.clips.length){ edPause(); ed.t = edL().total; edPlayhead(); edRenderClock(); return; }
  const old = edV[ed.cur];
  if (ed.prep && ed.prep.i === ni && ed.prep.ready){
    ed.cur ^= 1; ed.pi = ni; ed.prep = null;
    edShow(ed.cur);
    edV[ed.cur].play().catch(() => {});
    old.pause();
  } else {
    ed.pi = ni; ed.prep = null;
    edLoadInto(ed.cur, ni, EC.startOf(ed.lib, edClip(ni)), () => { if (ed.playing) edV[ed.cur].play().catch(() => {}); });
  }
}
$('edPlay').onclick = edToggle;
$('edPrev').onclick = () => {
  const L = edL(), loc = EC.locate(ed.tl, ed.lib, ed.t);
  if (loc) edSeek(L.starts[loc.i] + 0.5 < ed.t || !loc.i ? L.starts[loc.i] : L.starts[loc.i - 1]);
};
$('edNext').onclick = () => {
  const L = edL(), loc = EC.locate(ed.tl, ed.lib, ed.t);
  if (loc) edSeek(loc.i < ed.tl.clips.length - 1 ? L.starts[loc.i + 1] : L.total);
};

/* ---------------------------------------------------------------- pointer: scrub, select, reorder, trim */
const edXToT = ev => Math.max(0, (ev.clientX - $('edInner').getBoundingClientRect().left) / ed.z);
function edMarkBlocks(){   // show which video clip is selected without redrawing the filmstrips
  document.querySelectorAll('[data-block]').forEach(el => {
    const on = +el.dataset.block === ed.sel;
    el.classList.toggle('border-primary', on); el.classList.toggle('border-transparent', !on);
    el.querySelectorAll('[data-handle]').forEach(h => { h.classList.toggle('opacity-0', !on); h.classList.toggle('group-hover:opacity-80', !on); });
  });
}
function edSelect(i){
  ed.sel = i; ed.asel = -1;
  edMarkBlocks(); edRenderAudio(); edRenderPanel(); edRenderChrome();
}
function edSelectAudio(i){
  ed.asel = i; ed.sel = -1; ed.tab = 'clip';
  edMarkBlocks(); edRenderAudio(); edRenderPanel(); edRenderChrome();
}
$('edInner').addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const inner = $('edInner'), marker = ev.target.closest('[data-marker]');
  if (marker){ ed.tab = 'clip'; edSelect(+marker.dataset.marker); return; }
  const ab = ev.target.closest('[data-ablock]');
  if (ab){   // a piece of the audio track: move it, or trim one of its edges
    const i = +ab.dataset.ablock, ah = ev.target.closest('[data-ahandle]');
    if (i !== ed.asel || ed.sel >= 0) edSelectAudio(i);
    ed.drag = ah ? {kind: 'atrim', i, side: ah.dataset.ahandle, x0: ev.clientX, base: EC.copy(ed.tl)}
                 : {kind: 'amove', i, x0: ev.clientX, moved: false, base: EC.copy(ed.tl)};
    inner.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    return;
  }
  const block = ev.target.closest('[data-block]'), handle = ev.target.closest('[data-handle]');
  if (block && handle){
    const i = +block.dataset.block;
    if (i !== ed.sel) edSelect(i);
    ed.drag = {kind: 'trim', i, side: handle.dataset.handle, x0: ev.clientX, base: EC.copy(ed.tl)};
  } else if (block){
    const i = +block.dataset.block;
    ed.tab = ed.tab === 'clips' ? 'clip' : ed.tab;
    if (i !== ed.sel) edSelect(i); else edRenderPanel();
    edSeek(edXToT(ev));
    ed.drag = {kind: 'block', i, x0: ev.clientX, moved: false, to: i, el: block};
  } else {
    ed.drag = {kind: 'scrub'};
    edSeek(edXToT(ev));
  }
  inner.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
$('edInner').addEventListener('pointermove', ev => {
  const d = ed.drag;
  if (!d) return;
  if (d.kind === 'scrub'){ edSeek(edXToT(ev)); return; }
  if (d.kind === 'trim'){
    const c0 = d.base.clips[d.i], dt = (ev.clientX - d.x0) / ed.z;
    const patch = d.side === 'start' ? {start: EC.startOf(ed.lib, c0) + dt} : {end: EC.endOf(ed.lib, c0) + dt};
    ed.tl = EC.setTrim(d.base, ed.lib, d.i, patch);
    edLayoutLive();
    const c = edClip(d.i);   // show the frame at the edge being moved
    ed.pi = d.i; edShow(ed.cur);
    edLoadInto(ed.cur, d.i, d.side === 'start' ? EC.startOf(ed.lib, c) : Math.max(EC.endOf(ed.lib, c) - 0.05, 0));
    return;
  }
  if (d.kind === 'atrim'){
    const a0 = d.base.audio[d.i], dt = (ev.clientX - d.x0) / ed.z;
    ed.tl = d.side === 'start' ? EC.trimAudioStart(d.base, ed.alib, d.i, EC.aStart(ed.alib, a0) + dt)
                               : EC.trimAudioEnd(d.base, ed.alib, d.i, EC.aEnd(ed.alib, a0) + dt);
    edLayoutLive();
    return;
  }
  if (d.kind === 'amove'){
    const dx = ev.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 4) return;
    d.moved = true;
    const at = EC.snapAt(d.base, ed.lib, ed.alib, d.i, d.base.audio[d.i].at + dx / ed.z, 8 / ed.z);   // sticks to 0 and to clip edges
    ed.tl = EC.moveAudio(d.base, d.i, at);
    edLayoutLive();
    return;
  }
  if (d.kind === 'block'){
    const dx = ev.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 6) return;
    d.moved = true;
    d.el.style.transform = `translateX(${dx}px)`; d.el.style.opacity = '0.7'; d.el.style.zIndex = '30';
    d.to = EC.dropIndex(ed.tl, ed.lib, d.i, edXToT(ev));
    const L = edL(), others = ed.tl.clips.map((_, k) => k).filter(k => k !== d.i);
    const x = d.to < others.length ? L.starts[others[d.to]] : L.total;
    const drop = $('edDrop');
    drop.hidden = false; drop.style.left = x * ed.z - 1 + 'px';
  }
});
function edPointerEnd(ev){
  const d = ed.drag;
  if (!d) return;
  ed.drag = null;
  try { $('edInner').releasePointerCapture(ev.pointerId); } catch (e){ /* already released */ }
  if (d.kind === 'trim'){
    if (JSON.stringify(ed.tl) !== JSON.stringify(d.base)){ ed.hist.push(d.base); edAfterChange(); }
    else edRenderTimeline();
  } else if (d.kind === 'atrim' || d.kind === 'amove'){
    if (JSON.stringify(ed.tl) !== JSON.stringify(d.base)){ ed.hist.push(d.base); edAfterChange(); }
    else edRenderAudio();
  } else if (d.kind === 'block'){
    if (d.moved && d.to !== d.i){ edCommit(EC.moveClip(ed.tl, d.i, d.to), {select: d.to}); }
    else if (d.moved) edRenderTimeline();
  }
}
$('edInner').addEventListener('pointerup', edPointerEnd);
$('edInner').addEventListener('pointercancel', edPointerEnd);

/* ---------------------------------------------------------------- toolbar actions */
function edSplitHere(){
  const r = EC.splitAt(ed.tl, ed.lib, ed.t, () => ++ed.uid);
  if (!r){ toast('Put the playhead inside a clip, not right at its edge, to split it.'); return; }
  edCommit(r.tl, {select: r.index});
}
function edDelete(){
  if (ed.asel >= 0){ edCommit(EC.removeAudio(ed.tl, ed.asel)); return; }
  if (ed.sel < 0) return;
  edCommit(EC.removeClip(ed.tl, ed.sel), {select: ed.sel});
}
function edDuplicate(){
  if (ed.asel >= 0){ const n = EC.duplicateAudio(ed.tl, ed.alib, ed.asel, () => ++ed.uid); ed.asel++; edCommit(n); return; }
  if (ed.sel < 0) return;
  edCommit(EC.duplicateClip(ed.tl, ed.sel, () => ++ed.uid), {select: ed.sel + 1});
}
/* put a piece of narration or music on the audio track, at the playhead */
function edAddAudio(src, file){
  const at = EC.snapAt(ed.tl, ed.lib, ed.alib, -1, ed.t, 8 / ed.z);
  const next = EC.addAudio(ed.tl, {src, file}, at, () => ++ed.uid);
  ed.asel = next.audio.length - 1; ed.sel = -1; ed.tab = 'clip';
  edCommit(next);
}
function edAdd(files){
  const next = EC.copy(ed.tl);
  files.forEach(f => next.clips.push({file: f, start: 0, end: 0, join: 'cut', join_len: 0.8, uid: ++ed.uid}));
  edCommit(next, {select: ed.sel < 0 ? 0 : ed.sel});
}
$('edSplit').onclick = edSplitHere;
$('edDel').onclick = edDelete;
$('edDup').onclick = edDuplicate;
$('edUndo').onclick = edUndo;
$('edRedo').onclick = edRedo;
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ed.tab = b.dataset.tab; edRenderPanel(); edRenderChrome(); });

/* keyboard shortcuts (only on this page, and not while typing) */
document.addEventListener('keydown', ev => {
  if (currentRoute() !== 'editor' || $('videoDialog').open || ev.altKey) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag) || ev.target.isContentEditable) return;
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (k === ' '){ ev.preventDefault(); edToggle(); }
  else if (mod && k === 'z'){ ev.preventDefault(); if (ev.shiftKey) edRedo(); else edUndo(); }
  else if (mod && k === 'y'){ ev.preventDefault(); edRedo(); }
  else if (mod) return;
  else if (k === 's'){ edSplitHere(); }
  else if (k === 'delete' || k === 'backspace'){ ev.preventDefault(); edDelete(); }
  else if (k === 'arrowleft' || k === 'arrowright'){
    ev.preventDefault();
    edSeek(ed.t + (k === 'arrowleft' ? -1 : 1) * (ev.shiftKey ? 1 : 0.1));
    edKeepVisible();
  }
  else if (k === 'home'){ edSeek(0); $('edScroll').scrollLeft = 0; }
  else if (k === 'end'){ edSeek(edL().total); edKeepVisible(); }
});
document.addEventListener('keyup', ev => {   // a focused button must not also "click" on Space
  if (ev.key === ' ' && currentRoute() === 'editor' && ev.target.tagName === 'BUTTON') ev.preventDefault();
});
window.addEventListener('hashchange', () => { if (currentRoute() !== 'editor') edPause(); });

/* ---------------------------------------------------------------- side panel */
function edRenderPanel(){
  const box = $('edPanel');
  box.innerHTML = ed.tab === 'clips' ? edPanelClips() : ed.tab === 'audio' ? edPanelAudio()
    : ed.tab === 'clip' ? (ed.asel >= 0 ? edPanelAudioItem() : edPanelClip()) : edPanelFinish();
}
const SLIDER = 'w-full';
function edPanelAudio(){
  const row = a => {
    const used = (ed.tl.audio || []).filter(x => x.src === a.src && x.file === a.file).length;
    return `<div class="flex items-center gap-2 px-4 py-2.5">
      <div class="min-w-0 flex-1"><div class="truncate text-xs font-medium" title="${esc(a.file)}">${esc(edAudioName(a))}</div>
        <div class="hint">${edT(a.seconds)}${used ? ` · on timeline${used > 1 ? ' ×' + used : ''}` : ''}</div></div>
      ${a.src === 'music' ? `<button type="button" class="btn btn-ghost btn-icon btn-sm" data-pa="delmusic" data-file="${esc(a.file)}" title="Delete this music file" aria-label="Delete ${esc(a.file)}">${lu('trash-2')}</button>` : ''}
      <button type="button" class="btn btn-outline btn-sm" data-pa="addaudio" data-src="${a.src}" data-file="${esc(a.file)}">${lu('plus')}Add</button>
    </div>`;
  };
  const narr = ed.audioFiles.filter(a => a.src === 'project'), music = ed.audioFiles.filter(a => a.src === 'music');
  return `
    <div class="flex items-center justify-between gap-2 border-b px-4 py-3">
      <div class="font-semibold">Audio</div>
      <button type="button" class="btn btn-outline btn-sm" data-pa="upload">${lu('upload')}Add music file</button>
    </div>
    <p class="hint px-4 pt-3">Pieces are added at the playhead. Drag them on the audio track to move them.</p>
    <div class="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">Music you added</div>
    <div class="divide-y">${music.length ? music.map(row).join('') : '<div class="px-4 py-3 text-sm text-muted-foreground">None yet. Use <b>Add music file</b> (mp3, wav, m4a, ogg, flac; up to 28 MB).</div>'}</div>
    <div class="px-4 pb-1 pt-4 text-xs font-medium text-muted-foreground">Narration of this project</div>
    <div class="divide-y">${narr.length ? narr.map(row).join('') : '<div class="px-4 py-3 text-sm text-muted-foreground">No audio generated yet.</div>'}</div>`;
}
function edPanelAudioItem(){
  const i = ed.asel, a = (ed.tl.audio || [])[i];
  if (!a) return `<div class="px-5 py-10 text-center text-sm text-muted-foreground">Click a piece on the audio track to adjust it.</div>`;
  const d = EC.aDur(ed.alib, a), s = EC.aStart(ed.alib, a), e = EC.aEnd(ed.alib, a), len = e - s, field = 'input h-8 w-full py-0 text-xs';
  const past = a.at + len - edL().total;
  return `
    <div class="border-b px-4 py-3">
      <div class="hint">Audio piece ${i + 1} of ${ed.tl.audio.length} · ${a.src === 'music' ? 'music' : 'narration'}</div>
      <div class="truncate text-xs font-medium" title="${esc(a.file)}">${esc(edAudioName(a))}</div>
      <div class="hint">${edT(len)}${len < d - 0.05 ? ` (trimmed from ${edT(d)})` : ''} · from ${edT(a.at)} to ${edT(a.at + len)}</div>
    </div>
    <div class="space-y-4 p-4">
      <div>
        <div class="mb-2 flex items-center justify-between"><span class="label">Volume</span><span class="hint tabular-nums" data-vol-label>${edPctText(a.volume)}</span></div>
        <input type="range" min="0" max="200" step="5" value="${edPct(a.volume)}" class="${SLIDER}" data-in="avol" aria-label="Volume">
        <div class="mt-2 flex gap-2">
          <button type="button" class="btn btn-outline btn-sm" data-pa="amute">${lu(a.volume < 0.005 ? 'volume-2' : 'volume-x')}${a.volume < 0.005 ? 'Unmute' : 'Mute'}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pa="avol100" ${Math.abs(a.volume - 1) < 0.01 ? 'hidden' : ''}>Reset to 100%</button>
        </div>
        <p class="hint mt-1">100% is the file as it is. Above 100% makes it louder (it may distort).</p>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="text-xs">Fade in (s)<input type="number" class="${field}" min="0" max="${Math.min(30, len).toFixed(1)}" step="0.5" value="${a.fade_in}" data-in="afadein"></label>
        <label class="text-xs">Fade out (s)<input type="number" class="${field}" min="0" max="${Math.min(30, len).toFixed(1)}" step="0.5" value="${a.fade_out}" data-in="afadeout"></label>
      </div>
      <div>
        <div class="label mb-2">Position and trim <span class="hint font-normal">(seconds)</span></div>
        <div class="grid grid-cols-3 gap-2">
          <label class="text-xs">Starts at<input type="number" class="${field}" min="0" step="0.1" value="${+a.at.toFixed(2)}" data-in="aat"></label>
          <label class="text-xs">From<input type="number" class="${field}" min="0" max="${d}" step="0.1" value="${+s.toFixed(2)}" data-in="astart"></label>
          <label class="text-xs">To<input type="number" class="${field}" min="0" max="${d}" step="0.1" value="${+e.toFixed(2)}" data-in="aend"></label>
        </div>
        <button type="button" class="btn btn-outline btn-sm mt-2" data-pa="ahere">${lu('map-pin')}Start at the playhead</button>
        ${past > 0.05 ? `<p class="hint mt-1.5 text-destructive">The last ${edT(past)} runs past the end of the video and will be cut off.</p>` : ''}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-outline btn-sm" data-pa="adup">${lu('copy')}Duplicate</button>
        <button type="button" class="btn btn-outline btn-sm text-destructive" data-pa="adel">${lu('trash-2')}Remove</button>
      </div>
    </div>`;
}
function edPanelClips(){
  const files = Object.keys(ed.lib).sort(natural);
  const used = f => ed.tl.clips.filter(c => c.file === f).length;
  return `
    <div class="flex items-center justify-between gap-2 border-b px-4 py-3">
      <div class="font-semibold">Your clips</div>
      <button type="button" class="btn btn-outline btn-sm" data-pa="addall" ${files.length ? '' : 'disabled'}>${lu('list-plus')}Add all</button>
    </div>
    <div class="divide-y">${files.length ? files.map(f => `
      <div class="flex items-center gap-2 px-4 py-2.5">
        <div class="min-w-0 flex-1"><div class="truncate font-mono text-xs" title="${esc(f)}">${esc(f)}</div>
          <div class="hint">${edT(ed.lib[f])}${used(f) ? ` · on timeline${used(f) > 1 ? ' ×' + used(f) : ''}` : ''}</div></div>
        <button type="button" class="btn btn-outline btn-sm" data-pa="add" data-file="${esc(f)}">${lu('plus')}Add</button>
      </div>`).join('') : `<div class="px-4 py-8 text-center text-sm text-muted-foreground">No videos yet. Make some in <b>Videos</b> first.</div>`}
    </div>`;
}
function edPanelClip(){
  const i = ed.sel, c = edClip(i), n = ed.tl.clips.length;
  if (!c) return `<div class="px-5 py-10 text-center text-sm text-muted-foreground">Click a clip on the timeline to adjust it.</div>`;
  const d = ed.lib[c.file] || 0, s = EC.startOf(ed.lib, c), e = EC.endOf(ed.lib, c), field = 'input h-8 w-full py-0 text-xs';
  return `
    <div class="border-b px-4 py-3">
      <div class="hint">Clip ${i + 1} of ${n}</div>
      <div class="truncate font-mono text-xs" title="${esc(c.file)}">${esc(c.file)}</div>
      <div class="hint">${edT(e - s)}${EC.isTrimmed(ed.lib, c) ? ` (trimmed from ${edT(d)})` : ''}</div>
    </div>
    <div class="space-y-4 p-4">
      <div>
        <div class="label mb-2">Trim <span class="hint font-normal">(seconds in the clip)</span></div>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs">Start<input type="number" class="${field}" min="0" max="${d}" step="0.1" value="${+s.toFixed(2)}" data-in="start"></label>
          <label class="text-xs">End<input type="number" class="${field}" min="0" max="${d}" step="0.1" value="${+e.toFixed(2)}" data-in="end"></label>
          <button type="button" class="btn btn-outline btn-sm" data-pa="starthere" title="Start the clip at the playhead">${lu('scissors')}Start here</button>
          <button type="button" class="btn btn-outline btn-sm" data-pa="endhere" title="End the clip at the playhead">${lu('scissors')}End here</button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm mt-2" data-pa="reset" ${EC.isTrimmed(ed.lib, c) ? '' : 'hidden'}>${lu('rotate-ccw')}Reset trim</button>
        <p class="hint mt-1">You can also drag the edges of the clip on the timeline.</p>
      </div>
      ${i ? `<div>
        <div class="label mb-2">Join with the clip before</div>
        <select class="input h-8 py-0 text-xs" data-in="join">${Object.entries(JOIN_LABELS).map(([k, l]) => `<option value="${k}" ${c.join === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="mt-2 flex items-center justify-between gap-3 text-xs" ${c.join === 'cut' ? 'hidden' : ''}>Length (seconds)
          <input type="number" class="input h-8 w-24 py-0 text-xs" min="0.1" max="5" step="0.1" value="${c.join_len}" data-in="joinlen"></label>
        <p class="hint mt-1">${c.join === 'cut' ? 'A cut is instant.' : 'The two clips overlap during the transition. It shows in the exported video, not in the preview.'}</p>
      </div>` : ''}
      <div>
        <div class="mb-2 flex items-center justify-between"><span class="label">Volume of the clip's own sound</span><span class="hint tabular-nums" data-vol-label>${edPctText(edVol(c))}</span></div>
        <input type="range" min="0" max="200" step="5" value="${edPct(edVol(c))}" class="${SLIDER}" data-in="cvol" aria-label="Clip volume">
        <div class="mt-2 flex gap-2">
          <button type="button" class="btn btn-outline btn-sm" data-pa="cmute">${lu(edVol(c) < 0.005 ? 'volume-2' : 'volume-x')}${edVol(c) < 0.005 ? 'Unmute' : 'Mute'}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pa="cvol100" ${Math.abs(edVol(c) - 1) < 0.01 ? 'hidden' : ''}>Reset to 100%</button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-outline btn-sm" data-pa="up" ${i ? '' : 'disabled'}>${lu('arrow-left')}Move earlier</button>
        <button type="button" class="btn btn-outline btn-sm" data-pa="down" ${i < n - 1 ? '' : 'disabled'}>Move later${lu('arrow-right')}</button>
        <button type="button" class="btn btn-outline btn-sm" data-pa="split">${lu('scissors')}Split here</button>
        <button type="button" class="btn btn-outline btn-sm" data-pa="dup">${lu('copy')}Duplicate</button>
      </div>
      <button type="button" class="btn btn-outline btn-sm w-full text-destructive" data-pa="del">${lu('trash-2')}Remove from timeline</button>
    </div>`;
}
function edPanelFinish(){
  const L = edL(), exp = EC.exportLength(ed.tl, ed.lib), n = ed.tl.clips.length;
  return `
    <div class="border-b px-4 py-3"><div class="font-semibold">Finish and export</div></div>
    <div class="space-y-4 p-4">
      <label class="flex cursor-pointer items-center justify-between gap-3"><span class="label">Fade in from black</span>
        <input type="checkbox" role="switch" class="${SWITCH}" data-in="fadein" ${ed.tl.fade_in ? 'checked' : ''}></label>
      <label class="flex cursor-pointer items-center justify-between gap-3"><span class="label">Fade out to black</span>
        <input type="checkbox" role="switch" class="${SWITCH}" data-in="fadeout" ${ed.tl.fade_out ? 'checked' : ''}></label>
      <label class="flex items-center justify-between gap-3 text-sm"><span class="label">Fade length (seconds)</span>
        <input type="number" class="input h-8 w-24 py-0 text-xs" min="0.2" max="5" step="0.1" value="${ed.tl.fade_len}" data-in="fadelen"></label>
      <div>
        <label class="label mb-2 block" for="edName">Name of the new video</label>
        <input id="edName" class="input" maxlength="40" placeholder="Final_video" autocomplete="off" value="${esc(ed.name)}" data-in="name">
        <p class="hint mt-1.5">Saved in this project's Videos. Your original clips are never changed.</p>
      </div>
      <div class="rounded-lg bg-muted p-3 text-xs">
        <div class="flex justify-between"><span>Clips</span><b>${n}</b></div>
        <div class="flex justify-between"><span>Length</span><b>${edT(exp)}</b></div>
        <div class="flex justify-between"><span>Audio pieces</span><b>${(ed.tl.audio || []).length}</b></div>
        <div class="mt-1.5 text-muted-foreground">${!n ? '' : EC.isFastJoin(ed.tl, ed.lib) ? 'Only cuts and no trims: the clips are joined without re-encoding (instant, no quality loss).' : 'Trims, fades, transitions, volume changes or an audio track need the video to be re-encoded. Long videos take a few minutes.'}</div>
      </div>
      <button type="button" class="btn btn-primary w-full" data-pa="export" ${n && !ed.jobId ? '' : 'disabled'}>${lu('clapperboard')}Export video</button>
    </div>`;
}

$('edPanel').addEventListener('click', ev => {
  const b = ev.target.closest('[data-pa]');
  if (!b || b.disabled) return;
  const act = b.dataset.pa, i = ed.sel, c = edClip(i), ai = ed.asel;
  if (act === 'add') edAdd([b.dataset.file]);
  else if (act === 'addaudio') edAddAudio(b.dataset.src, b.dataset.file);
  else if (act === 'upload') $('edMusicFile').click();
  else if (act === 'delmusic') edDeleteMusic(b.dataset.file);
  else if (act === 'amute' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {volume: ed.tl.audio[ai].volume < 0.005 ? 1 : 0}));
  else if (act === 'avol100' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {volume: 1}));
  else if (act === 'ahere' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {at: ed.t}));
  else if (act === 'adup') edDuplicate();
  else if (act === 'adel') edDelete();
  else if (act === 'cmute' && c) edCommit(EC.setClipVolume(ed.tl, i, edVol(c) < 0.005 ? 1 : 0));
  else if (act === 'cvol100' && c) edCommit(EC.setClipVolume(ed.tl, i, 1));
  else if (act === 'addall'){
    const have = new Set(ed.tl.clips.map(x => x.file));
    const files = Object.keys(ed.lib).sort(natural).filter(f => !have.has(f));
    if (!files.length) toast('All clips are already on the timeline.'); else edAdd(files);
  }
  else if (act === 'up' && i > 0) edCommit(EC.moveClip(ed.tl, i, i - 1), {select: i - 1});
  else if (act === 'down' && i < ed.tl.clips.length - 1) edCommit(EC.moveClip(ed.tl, i, i + 1), {select: i + 1});
  else if (act === 'dup') edDuplicate();
  else if (act === 'del') edDelete();
  else if (act === 'split') edSplitHere();
  else if (act === 'reset' && c) edCommit(EC.resetTrim(ed.tl, ed.lib, i));
  else if ((act === 'starthere' || act === 'endhere') && c){
    const loc = EC.locate(ed.tl, ed.lib, ed.t);
    if (!loc || loc.i !== i){ toast('Move the playhead onto the selected clip first.'); return; }
    edCommit(EC.setTrim(ed.tl, ed.lib, i, act === 'starthere' ? {start: loc.src} : {end: loc.src}));
  }
  else if (act === 'export') edExport();
});
$('edPanel').addEventListener('change', ev => {
  const t = ev.target, key = t.dataset.in, i = ed.sel, c = edClip(i), ai = ed.asel;
  if (!key || key === 'name') return;
  if (key === 'avol' || key === 'cvol'){ edFinishLive(); edRenderPanel(); return; }
  if (key === 'aat' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {at: parseFloat(t.value) || 0}));
  else if (key === 'astart' && ai >= 0) edCommit(EC.trimAudioStart(ed.tl, ed.alib, ai, parseFloat(t.value) || 0));
  else if (key === 'aend' && ai >= 0) edCommit(EC.trimAudioEnd(ed.tl, ed.alib, ai, parseFloat(t.value) || 0));
  else if (key === 'afadein' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {fade_in: parseFloat(t.value) || 0}));
  else if (key === 'afadeout' && ai >= 0) edCommit(EC.setAudioProp(ed.tl, ed.alib, ai, {fade_out: parseFloat(t.value) || 0}));
  else if (key === 'start' && c) edCommit(EC.setTrim(ed.tl, ed.lib, i, {start: parseFloat(t.value) || 0}));
  else if (key === 'end' && c) edCommit(EC.setTrim(ed.tl, ed.lib, i, {end: parseFloat(t.value) || 0}));
  else if (key === 'join' && c){ const n = EC.copy(ed.tl); n.clips[i].join = t.value; edCommit(n); }
  else if (key === 'joinlen' && c){ const n = EC.copy(ed.tl); n.clips[i].join_len = EC.clamp(parseFloat(t.value) || 0.8, 0.1, 5); edCommit(n); }
  else if (key === 'fadein'){ const n = EC.copy(ed.tl); n.fade_in = t.checked; edCommit(n); }
  else if (key === 'fadeout'){ const n = EC.copy(ed.tl); n.fade_out = t.checked; edCommit(n); }
  else if (key === 'fadelen'){ const n = EC.copy(ed.tl); n.fade_len = EC.clamp(parseFloat(t.value) || 1, 0.2, 5); edCommit(n); }
  edRenderPanel();   // show the clamped value
});
$('edPanel').addEventListener('input', ev => {
  const t = ev.target, key = t.dataset.in;
  if (key === 'name'){ ed.name = t.value; return; }
  if (key !== 'avol' && key !== 'cvol') return;
  // a volume slider: heard at once (also while playing); one undo step is recorded when the slider is released
  if (!ed.live) ed.live = EC.copy(ed.tl);
  const v = (+t.value) / 100;
  ed.tl = key === 'avol' ? EC.setAudioProp(ed.tl, ed.alib, ed.asel, {volume: v}) : EC.setClipVolume(ed.tl, ed.sel, v);
  const label = $('edPanel').querySelector('[data-vol-label]');
  if (label) label.textContent = edPctText(v);
  edAudioLabels(); edApplyClipGain();
});
function edFinishLive(){
  if (!ed.live) return;
  const base = ed.live;
  ed.live = null;
  if (JSON.stringify(base) !== JSON.stringify(ed.tl)){ ed.hist.push(base); edSave(); edRenderChrome(); }
}
async function edDeleteMusic(file){
  if (!confirm(`Delete the music file "${file}" from this project? Pieces that use it are removed from the timeline.`)) return;
  try {
    await api.post('/api/editor/music/delete', {project: curProject(), file});
    ed.audioFiles = ed.audioFiles.filter(a => !(a.src === 'music' && a.file === file));
    delete ed.alib['music:' + file];
    const next = EC.copy(ed.tl);
    next.audio = (next.audio || []).filter(a => !(a.src === 'music' && a.file === file));
    edCommit(next);
    edRenderPanel();
  } catch (e){ toast(e.message, 5000); }
}
$('edMusicFile').onchange = async () => {   // upload a music file, then put it on the track at the playhead
  const f = $('edMusicFile').files[0];
  $('edMusicFile').value = '';
  if (!f) return;
  if (f.size > 28 * 1024 * 1024){ toast('That file is too large (max 28 MB).', 5000); return; }
  toast('Adding ' + f.name + '...');
  try {
    const r = await api.post('/api/editor/music', {project: curProject(), name: f.name, data: await readB64(f)});
    ed.alib[r.src + ':' + r.file] = r.seconds;
    ed.audioFiles.push(r);
    toast('Added ' + r.file);
    edAddAudio(r.src, r.file);
  } catch (e){ toast(e.message, 6000); }
};

/* ---------------------------------------------------------------- export */
async function edExport(){
  if (!ed.tl.clips.length || ed.jobId) return;
  $('edExport').disabled = true;
  try {
    clearTimeout(ed.saveTimer);
    const j = await api.post('/api/editor/export', {project: curProject(), timeline: ed.tl, name: ed.name});
    pollEdit(j.id, curProject());
  } catch (e){ toast(e.message, 6000); edRenderChrome(); }
}
$('edExport').onclick = edExport;

async function pollEdit(id, project){
  ed.jobId = id;
  const bar = $('edActive');
  bar.hidden = false; $('edProg').style.width = '0%'; $('edPct').textContent = ''; $('edStatus').textContent = 'Queued...';
  edRenderChrome(); if (ed.tab === 'finish') edRenderPanel();
  const finish = () => { bar.hidden = true; ed.jobId = null; edRenderChrome(); if (ed.tab === 'finish') edRenderPanel(); };
  let failures = 0;
  while (ed.jobId === id){
    let j;
    try { j = await api.get('/api/editor/jobs/' + encodeURIComponent(id)); failures = 0; }
    catch (e){
      if (e.network && ++failures < 8){ await sleep(2000); continue; }
      finish(); toast('Editor: ' + e.message); return;
    }
    if (j.status === 'done'){
      finish();
      toast('Video ready: ' + j.file + ' (see Videos)', 6000);
      if (currentRoute() === 'editor' && curProject() === project) edRefreshLib();
      return;
    }
    if (j.status === 'error'){ finish(); toast(j.error || 'Joining the clips failed.', 8000); return; }
    const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    $('edStatus').textContent = (j.status === 'queued' ? 'Queued...' : j.fast ? 'Joining the clips...' : 'Rendering the joined video...')
      + (j.elapsed != null && j.status !== 'queued' ? ` (${fmt(j.elapsed)})` : '');
    $('edProg').style.width = pct + '%'; $('edPct').textContent = j.total && j.status === 'joining' ? pct + '%' : '';
    await sleep(1200);
  }
}

/* ================================================================ re-attach to running jobs after a reload */
async function resumeActiveJobs(){
  let a;
  try { a = await api.get('/api/active'); } catch (e){ return; }
  const t = a.tts && a.tts[0];
  if (t && !ttsPollId){
    setBusy(true); resetOutput(); setBadge('run', 'Working');
    setStatus('Re-attached to a running job...');
    pollTts(t.id);
  }
  const v = a.video && a.video[0];
  if (v && !vidPollId) pollVideo(v.id, v.project);
  const e = a.edit && a.edit[0];
  if (e && !ed.jobId) pollEdit(e.id, e.project);
  const x = a.extract && a.extract[0];
  if (x && !extracting){
    extracting = true;
    showExtractProgress('Re-attached to a running extraction...');
    pollExtract(x.id, x.docId, x.project, x.name);
  }
}

/* ================================================================ start */
updateCount();
loadSettings();
loadProjects().then(resumeActiveJobs);
