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
const VIEWS = ['empty', 'generate', 'documents', 'doc', 'audio'];
const TITLES = {generate: 'Generate speech', documents: 'Documents', doc: 'Document', audio: 'Audio library'};
function show(view){
  VIEWS.forEach(v => { $('view-' + v).hidden = v !== view; });
  const nav = view === 'doc' ? 'documents' : view;
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.route === nav);
    if (a.dataset.route === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('crumbPage').textContent = TITLES[view] || '';
  openSidebar(false);
}
function currentRoute(){ return location.hash.replace(/^#\/?/, ''); }
function route(){
  if (!curProject()){ show('empty'); $('crumbPage').textContent = 'Get started'; return; }
  const h = currentRoute();
  if (h.startsWith('doc/')){ show('doc'); openDoc(h.slice(4)); return; }
  const v = ['generate', 'documents', 'audio'].includes(h) ? h : 'generate';
  show(v);
  if (v === 'documents') loadDocs();
  if (v === 'audio') loadAudio();
}
document.querySelectorAll('.nav-link').forEach(a => {
  a.href = '#/' + a.dataset.route;   // real links: keyboard focusable, middle-click works
  a.onclick = () => openSidebar(false);
});
window.addEventListener('hashchange', route);

/* ================================================================ generate speech */
function updateCount(){
  const n = $('text').value.length;
  $('count').textContent = n.toLocaleString() + ' characters';
  $('est').textContent = '~' + Math.round(n / 15).toLocaleString() + ' s of audio';
}
$('text').oninput = updateCount;
$('clearScript').onclick = () => { $('text').value = ''; updateCount(); $('text').focus(); };
$('ex').oninput = () => { $('exv').textContent = (+$('ex').value).toFixed(2); };
$('cfg').oninput = () => { $('cfv').textContent = (+$('cfg').value).toFixed(2); };

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
  const vf = $('voice').files[0];
  if (vf && vf.size > 25 * 1024 * 1024){ setStatus('The voice sample is too large (max 25 MB).', true); return; }
  setBusy(true); resetOutput();
  setStatus('Sending request...'); setBadge('run', 'Working'); setJob('tts', 'Starting...');
  try {
    const body = {text, project: curProject(), exaggeration: $('ex').value, cfg: $('cfg').value};
    if (vf) body.voice = await fileToB64(vf);
    const j = await api.post('/api/generate', body);
    pollTts(j.id);
  } catch (e){
    setStatus('Error: ' + e.message, true); setBadge('err', 'Error'); setJob('tts', null); setBusy(false);
  }
};

function renderDetails(j){
  $('stats').hidden = false; $('parts').hidden = false;
  $('sDone').textContent = j.done + ' / ' + j.total;
  $('sLeft').textContent = (j.total - j.done) + ' parts';
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
    <div class="mt-5 border-t pt-5">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate font-medium">${esc(project)} / ${esc(file)}${seconds ? ' &middot; ' + esc(seconds) + ' s' : ''}</span>
        <a class="btn btn-primary btn-sm" href="${url}" download>${ICON.dl} Download .wav</a>
      </div>
      <audio class="mt-3 w-full" controls src="${url}"></audio>
    </div>`;
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
      setStatus(`Finished. ${j.seconds} seconds of audio saved as ${j.file} in project ${j.project}.`);
      setBadge('ok', 'Done'); setJob('tts', null);
      showResult(j.project, j.file, j.seconds);
      setBusy(false); refreshCounts(); toast('Saved ' + j.file);
      if (currentRoute() === 'audio') loadAudio();
      ttsPollId = null; return;
    }
    if (j.status === 'error'){
      setStatus(j.error || 'Generation failed.', true); setBadge('err', 'Error');
      setJob('tts', null); setBusy(false); ttsPollId = null; return;
    }
    if (j.total){
      const pct = Math.round(j.done / j.total * 100);
      $('prog').style.width = pct + '%'; $('pct').textContent = pct + '%';
      setStatus(`Generating part ${Math.min(j.done + 1, j.total)} of ${j.total}. This can take a while on CPU.`);
      setJob('tts', `Generating ${j.done}/${j.total} parts`);
      renderDetails(j);
    } else {
      setStatus(j.status === 'queued' ? 'Queued...' : 'Loading the voice model. The first run takes longer.');
      setJob('tts', j.status === 'queued' ? 'Queued' : 'Loading model');
    }
    await sleep(1500);
  }
}

/* ================================================================ audio library */
let audioLoadSeq = 0;
async function loadAudio(){
  const p = curProject(), seq = ++audioLoadSeq;
  const box = $('audioList');
  let files;
  try { files = await api.get(qp('/api/files', {project: p})); }
  catch (e){ if (seq === audioLoadSeq) box.innerHTML = `<div class="px-5 py-12 text-center text-destructive">${esc(e.message)}</div>`; return; }
  if (seq !== audioLoadSeq) return;
  if (!files.length){
    box.innerHTML = `<div class="px-5 py-12 text-center text-muted-foreground">No audio yet. <a class="underline" href="#/generate">Generate your first file</a>.</div>`;
    return;
  }
  box.innerHTML = files.map(f => `
    <div class="p-4 md:px-5" data-file="${esc(f)}">
      <div class="flex items-center gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted [&_svg]:size-4">${ICON.play}</span>
        <span class="flex-1 truncate font-mono text-xs">${esc(f)}</span>
        <button class="btn btn-outline btn-sm" data-play>Play</button>
        <a class="btn btn-outline btn-sm" href="${audioUrl(p, f)}" download>${ICON.dl}<span class="hidden sm:inline">Download</span></a>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const row = b.closest('[data-file]');
    if (row.querySelector('audio')) return;
    box.querySelectorAll('audio').forEach(x => { x.pause(); x.remove(); });
    const a = document.createElement('audio');
    a.controls = true; a.autoplay = true; a.className = 'mt-3 w-full';
    a.src = audioUrl(p, row.dataset.file);
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
  if (doc && doc.id === id && doc.project === project && $('exPages').childElementCount){ $('crumbPage').textContent = doc.name; return; }
  const seq = ++openSeq;
  saver.flushAll();
  $('docName').textContent = 'Loading...'; $('docMeta').textContent = ''; $('exPages').innerHTML = ''; $('exNav').innerHTML = '';
  let d;
  try { d = await api.get(qp('/api/doc', {project, id})); }
  catch (e){ if (seq === openSeq){ showError(e); location.hash = '#/documents'; } return; }
  if (seq !== openSeq || curProject() !== project) return;   // user navigated away meanwhile
  doc = Object.assign(d, {project}); selected.clear(); $('exSearch').value = '';
  $('crumbPage').textContent = doc.name;
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
  const x = a.extract && a.extract[0];
  if (x && !extracting){
    extracting = true;
    showExtractProgress('Re-attached to a running extraction...');
    pollExtract(x.id, x.docId, x.project, x.name);
  }
}

/* ================================================================ start */
updateCount();
loadProjects().then(resumeActiveJobs);
