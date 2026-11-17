/* =====================================================================
 * Stella Sound v4 · app.js
 * Two areas only:
 *   CREATE  – pick an instrument, play big pads in key, record loops.
 *   PRODUCE – loop library, 6-track song arranger, full-screen DJ Pads.
 * ===================================================================== */
'use strict';
const $ = (id) => document.getElementById(id);
const clamp = DSP.clamp;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CAT_COLOR = { Drums: '#ff5d73', Bass: '#ffb020', Chords: '#8b5cf6', Melody: '#22d3ee', FX: '#3ddc97' };
const FAM_COLOR = { Keys: '#a78bfa', Strings: '#fbbf24', Bass: '#fb923c', Winds: '#34d399', Synths: '#22d3ee', Mallets: '#f472b6', Drums: '#ff5d73' };
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} } };

/* ---------------------------- UI helpers ---------------------------- */
function toast(msg, ms = 1900) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }
const coarse = matchMedia('(pointer: coarse)');
function haptic() { if (coarse.matches && navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} } }

/** Minimal modal: returns a Promise resolving to the clicked action's value (null on dismiss). */
let modalResolve = null;
function modal({ title, body = '', actions = [{ label: 'OK', value: true, cls: 'primary' }], onOpen }) {
  if (modalResolve) modalResolve(null);
  $('mTitle').textContent = title; const b = $('mBody'); b.innerHTML = ''; if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
  const a = $('mActions'); a.innerHTML = '';
  return new Promise((res) => {
    modalResolve = (v) => { modalResolve = null; $('modal').hidden = true; res(v); };
    actions.forEach((ac) => { const btn = document.createElement('button'); btn.className = 'chip ' + (ac.cls || ''); btn.textContent = ac.label;
      btn.onclick = () => modalResolve(typeof ac.value === 'function' ? ac.value() : ac.value); a.appendChild(btn); });
    $('modal').hidden = false; if (onOpen) onOpen(b);
  });
}
$('modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal' && modalResolve) modalResolve(null); });
async function confirmBox(title, msg, ok = 'OK', danger = false) {
  return !!(await modal({ title, body: `<p>${esc(msg)}</p>`, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, cls: danger ? 'danger strong' : 'primary' }] }));
}
async function promptBox(title, value, { label = 'Name', extra = '', ok = 'Save' } = {}) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<label class="field"><span>${esc(label)}</span><input type="text" id="mInput" maxlength="40" autocomplete="off"></label>${extra}`;
  wrap.querySelector('#mInput').value = value;
  const read = () => { const v = wrap.querySelector('#mInput').value.trim(); const sel = wrap.querySelector('select'); return { name: v || value, opt: sel ? sel.value : null }; };
  return modal({ title, body: wrap, actions: [{ label: 'Cancel', value: null }, { label: ok, value: read, cls: 'primary' }],
    onOpen: (b) => { const i = b.querySelector('#mInput'); i.focus(); i.select(); i.onkeydown = (e) => { if (e.key === 'Enter') modalResolve(read()); }; } });
}

/* ---------------------------- Storage (IndexedDB) ---------------------------- */
const DB = (() => {
  let dbp = null; const mem = { loops: new Map(), songs: new Map() };
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open('stella-sound-v4', 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('loops')) d.createObjectStore('loops', { keyPath: 'id' }); if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' }); };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
      } catch (_) { res(null); }
    });
    return dbp;
  }
  async function run(storeName, mode, fn) {
    const d = await open();
    if (!d) { const m = mem[storeName]; return fn({ getAll: () => [...m.values()], put: (o) => m.set(o.id, o), delete: (id) => m.delete(id) }, true); }
    return new Promise((res, rej) => { const tx = d.transaction(storeName, mode), s = tx.objectStore(storeName), r = fn(s);
      tx.oncomplete = () => res(r && typeof r === 'object' && 'result' in r ? r.result : r); tx.onerror = () => rej(tx.error); });
  }
  return { all: (s) => run(s, 'readonly', (st) => st.getAll()), put: (s, o) => run(s, 'readwrite', (st) => st.put(o)), del: (s, id) => run(s, 'readwrite', (st) => st.delete(id)) };
})();

/* ---------------------------- Loops (presets + mine) ---------------------------- */
const userLoops = new Map();
const getLoop = (id) => PRESETS.byId.get(id) || userLoops.get(id) || null;
const genreName = (g) => g === 'mine' ? 'My Loops' : (PRESETS.GENRES[g] || {}).name || g;

/* =====================================================================
 * AREA 1 · CREATE
 * ===================================================================== */
const KEYROWS = ['zxcvbnm,', 'asdfghjk', 'qwertyui', '12345678']; // bottom → top
const C = Object.assign({
  sel: { type: 'inst', id: 'piano' }, key: 0, scale: 'Major', oct: 4, bpm: 100, bars: 2, metro: true, snap: true,
  takes: [],
}, store.get('stella4-create', {}), {
  playing: false, recording: false, t0: 0, nextBeatT: 0, beatIdx: 0, schedT: 0, take: null, lastCycle: -1, held: new Map(), pads: [], cols: 4, rows: 4,
});
if (!Array.isArray(C.takes)) C.takes = [];
const spb = () => 60 / C.bpm, loopLen = () => C.bars * 4 * spb();
const saveCreate = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => store.set('stella4-create', { sel: C.sel, key: C.key, scale: C.scale, oct: C.oct, bpm: C.bpm, bars: C.bars, metro: C.metro, takes: C.takes.filter((x) => x.length).map((tk) => tk.map(({ skip, ...e }) => e)) }), 600); }; })();
const curInst = () => (C.sel.type === 'inst' ? INST_BY_ID[C.sel.id] : null);
const curColor = () => (C.sel.type === 'kit' ? FAM_COLOR.Drums : FAM_COLOR[curInst().fam]);

function buildInstList() {
  const list = $('instList'); let html = '', fam = '';
  for (const i of INSTRUMENTS) { if (i.fam !== fam) { fam = i.fam; html += `<div class="inst-fam">${fam}</div>`; }
    html += `<button class="inst" role="option" data-type="inst" data-id="${i.id}" style="--pc:${FAM_COLOR[i.fam]}"><i></i>${esc(i.name)}</button>`; }
  html += `<div class="inst-fam">Drums</div>`;
  for (const k of KIT_LIST) html += `<button class="inst" role="option" data-type="kit" data-id="${k.id}" style="--pc:${FAM_COLOR.Drums}"><i></i>${esc(k.name)}</button>`;
  list.innerHTML = html;
  list.onclick = (e) => { const b = e.target.closest('.inst'); if (b) selectInstrument(b.dataset.type, b.dataset.id, true); };
}
function selectInstrument(type, id, user) {
  C.sel = { type, id };
  if (type === 'inst') { const i = INST_BY_ID[id]; if (user) C.oct = i.oct; Engine.setCreateSend(i.send); } else Engine.setCreateSend(0.08);
  document.querySelectorAll('#instList .inst').forEach((b) => { const on = b.dataset.type === type && b.dataset.id === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on);
    if (on && user && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  const name = type === 'kit' ? KIT_LIST.find((k) => k.id === id).name : INST_BY_ID[id].name;
  $('instName').textContent = name; $('instFam').textContent = type === 'kit' ? 'Drums' : INST_BY_ID[id].fam;
  $('instNow').style.setProperty('--pc', curColor());
  $('scaleGroup').style.visibility = $('octGroup').style.visibility = type === 'kit' ? 'hidden' : '';
  layoutPads(true); saveCreate();
}
/** Notes for the pad grid. 4-column layouts run straight up the scale; 8-column layouts
 *  stack rows a 4th apart (like Push / Launchpad "in key" mode) so the range stays playable. */
function padNotes(rows, cols) {
  const L = MUSIC.SCALES[C.scale].length, root = 12 * (C.oct + 1) + C.key, off = cols >= 8 ? Math.max(2, Math.round(L * 3 / 7)) : cols, out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const d = r * off + c, m = MUSIC.deg(root, C.scale, d); out.push(m <= 108 ? { midi: m, root: ((d % L) + L) % L === 0 } : null); }
  return out;
}
/** Build the pad grid for the current instrument and screen size (lowest note bottom-left). */
function layoutPads(force) {
  const g = $('padGrid'), w = g.clientWidth, h = g.clientHeight; if (!w || !h) return;
  let cols, rows;
  if (C.sel.type === 'kit') { const ar = w / h; cols = ar > 1.6 ? 6 : ar > 0.75 ? 4 : 3; rows = 12 / cols; }
  else { cols = w >= h * 1.15 ? 8 : 4; rows = clamp(Math.round(h / (w / cols) * (cols === 8 ? 1 : 1.05)), cols === 8 ? 2 : 3, cols === 8 ? 4 : 6); }
  const sig = [C.sel.type, C.sel.id, C.key, C.scale, C.oct, cols, rows].join('|'); if (!force && sig === g._sig) return; g._sig = sig;
  releaseAllHeld();
  C.cols = cols; C.rows = rows; g.style.gridTemplateColumns = `repeat(${cols},1fr)`; g.style.gridTemplateRows = `repeat(${rows},1fr)`;
  const n = cols * rows, color = curColor();
  C.pads = C.sel.type === 'kit' ? DSP.PIECES.slice(0, n).map((p) => ({ piece: p.id, label: p.name })) : padNotes(rows, cols).map((x) => x && ({ ...x, label: MUSIC.noteName(x.midi) }));
  let html = '';
  for (let r = rows - 1; r >= 0; r--) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, p = C.pads[i], key = (KEYROWS[r] || '')[c] || '';
    if (!p) { html += '<div></div>'; continue; }
    html += `<button class="pad${p.root ? ' root' : ''}" data-i="${i}" style="--pc:${color}"><span class="pk">${key.toUpperCase()}</span><span class="pn">${esc(p.label)}</span>${p.root ? '<span class="ps">Root</span>' : ''}</button>`;
  }
  g.innerHTML = html; C.padEls = {}; g.querySelectorAll('.pad').forEach((el) => { C.padEls[+el.dataset.i] = el; });
  C.keyMap = {}; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = (KEYROWS[r] || '')[c]; if (k && C.pads[r * cols + c]) C.keyMap[k] = r * cols + c; }
  $('octLbl').textContent = 'Oct ' + C.oct;
  prewarmPads();
}
/** Generate the visible pads' samples in the background so the first tap is instant. */
let prewarmToken = 0;
function prewarmPads() {
  if (!Engine.ctx) return; const tok = ++prewarmToken, sel = { ...C.sel }, list = C.pads.slice();
  let i = 0; const step = () => { if (tok !== prewarmToken || i >= list.length) return; const p = list[i++];
    if (p) { if (sel.type === 'kit') Engine.drumBuf(sel.id, p.piece); else Engine.noteBuf(sel.id, p.midi); } setTimeout(step, 4); };
  setTimeout(step, 30);
}

/* ---- playing pads ---- */
function padDown(idx, src) {
  Engine.init(); const p = C.pads[idx]; if (!p) return;
  if (C.held.has(src)) padUp(src);
  const t = Engine.now(); let rec, ev;
  if (p.piece) {
    if (p.piece === 'hat') Engine.stopTag((r) => r.tag === 'ohat', t, 0.03); // closed hat chokes open hat
    rec = Engine.voice(Engine.drumBuf(C.sel.id, p.piece), t, 0.9); if (rec && p.piece === 'ohat') rec.tag = 'ohat';
    ev = { k: C.sel.id, p: p.piece, v: 0.9 };
  } else { rec = Engine.voice(Engine.noteBuf(C.sel.id, p.midi), t, 0.85); ev = { i: C.sel.id, n: p.midi, v: 0.85, d: 0.25 }; }
  const rev = capture(ev, t);
  C.held.set(src, { idx, rec, ev: rev, t, drum: !!p.piece, rel: p.piece ? 0 : curInst().rel });
  const el = C.padEls[idx]; if (el) el.classList.add('on'); haptic();
}
function padUp(src) {
  const h = C.held.get(src); if (!h) return; C.held.delete(src);
  const t = Engine.now();
  if (!h.drum) Engine.release(h.rec, t, h.rel);
  if (h.ev && !h.drum) { let d = (t - h.t) / spb(); if (C.snap) d = Math.round(d * 4) / 4; h.ev.d = clamp(d, 0.25, C.bars * 4); saveCreate(); }
  if (![...C.held.values()].some((x) => x.idx === h.idx)) { const el = C.padEls[h.idx]; if (el) { if (h.drum) setTimeout(() => el.classList.remove('on'), 70); else el.classList.remove('on'); } }
}
function releaseAllHeld() { [...C.held.keys()].forEach(padUp); }
function setupPadInput() {
  const g = $('padGrid');
  g.addEventListener('pointerdown', (e) => { const el = e.target.closest('.pad'); if (!el) return; e.preventDefault(); try { g.setPointerCapture(e.pointerId); } catch (_) {} padDown(+el.dataset.i, 'p' + e.pointerId); });
  g.addEventListener('pointermove', (e) => { const k = 'p' + e.pointerId, h = C.held.get(k); if (!h || h.drum) return; // glide across melodic pads
    const el = document.elementFromPoint(e.clientX, e.clientY); const pad = el && el.closest && el.closest('.pad'); if (pad && +pad.dataset.i !== h.idx) { padUp(k); padDown(+pad.dataset.i, k); } });
  const up = (e) => padUp('p' + e.pointerId); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up); g.addEventListener('lostpointercapture', up);
  g.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ---- recording / looping ---- */
function capture(ev, t) {
  if (!C.recording || !C.take) return null; const sp = spb(), L = loopLen(); let rel = t - C.t0;
  if (rel < 0) { if (rel > -0.3 * sp) rel = 0; else return null; } // slightly early hits during count-in land on beat 1
  const cyc = Math.floor(rel / L); let b = (rel - cyc * L) / sp, skip = cyc;
  if (C.snap) b = Math.round(b * 4) / 4;
  if (b >= C.bars * 4 - 1e-6) { b = 0; skip = cyc + 1; }
  if (C.takes.reduce((n, tk) => n + tk.length, 0) >= 3000) { toast('Loop is full – save it or clear'); return null; }
  const e = { ...ev, b, skip }; C.take.push(e); updateCreateUI(); return e;
}
function newTake() { if (C.take && !C.take.length) return; C.take = []; C.takes.push(C.take); if (C.takes.length > 64) { const a = C.takes.shift(); C.takes[0].unshift(...a); } }
function playEvent(ev, t, sp) {
  if (ev.k) Engine.voice(Engine.drumBuf(ev.k, ev.p), t, ev.v ?? 0.9);
  else { const r = Engine.voice(Engine.noteBuf(ev.i, ev.n), t, ev.v ?? 0.85); Engine.release(r, t + (ev.d || 0.25) * sp, (INST_BY_ID[ev.i] || {}).rel || 0.2); }
}
function cTick() {
  const now = Engine.now(), hz = now + 0.12, sp = spb(), L = loopLen();
  while (C.nextBeatT < hz) { const i = C.beatIdx; if (C.metro || i < 0) Engine.play(Engine.clickBuf(((i % 4) + 4) % 4 === 0), C.nextBeatT, { bus: 'click' }); C.beatIdx++; C.nextBeatT += sp; }
  let from = Math.max(C.schedT, C.t0);
  while (from < hz) {
    const cyc = Math.floor((from - C.t0) / L + 1e-9), cs = C.t0 + cyc * L, to = Math.min(hz, cs + L);
    // Same sound at the same moment from several takes plays once; at most 12 sounds start together (keeps node count bounded).
    const seen = new Set(), per = new Map();
    for (const tk of C.takes) for (const ev of tk) { if (ev.b >= C.bars * 4) continue; const t = cs + ev.b * sp; if (t < from || t >= to || ev.skip === cyc) continue;
      const tk2 = Math.round(t * 1000), key = tk2 + '|' + (ev.k ? ev.k + ev.p : ev.i + ev.n), n = per.get(tk2) || 0;
      if (seen.has(key) || n >= 12) continue; seen.add(key); per.set(tk2, n + 1); playEvent(ev, t, sp); }
    from = to;
  }
  C.schedT = Math.max(C.schedT, hz);
  if (C.recording && now >= C.t0) { const cyc = Math.floor((now - C.t0) / L); if (cyc !== C.lastCycle) { if (C.lastCycle >= 0) newTake(); C.lastCycle = cyc; } }
}
function cStart(record) {
  Engine.init();
  if (C.playing) { if (record) punchIn(); return; }
  if (P.running) { stopAll(); toast('Produce stopped so your loop plays in time'); }
  const t = Engine.now() + 0.08, ci = record ? 4 * spb() : 0;
  C.t0 = t + ci; C.nextBeatT = t; C.beatIdx = record ? -4 : 0; C.schedT = t; C.playing = true; C.lastCycle = -1;
  if (record) { C.recording = true; C.take = null; newTake(); }
  Sched.add(cTick); cTick(); startRaf(); updateCreateUI();
}
function punchIn() { C.recording = true; C.take = null; newTake(); const now = Engine.now(); C.lastCycle = now >= C.t0 ? Math.floor((now - C.t0) / loopLen()) : -1; updateCreateUI(); }
function cStop() {
  if (!C.playing && !C.recording) { releaseAllHeld(); return; }
  C.playing = false; C.recording = false; Sched.remove(cTick); releaseAllHeld();
  if (Engine.ctx) Engine.stopTag((r) => r.bus === 'create' || r.bus === 'click', Engine.now(), 0.06);
  C.takes = C.takes.filter((tk) => tk.length); C.take = null; updateCreateUI(); saveCreate();
}
function toggleRec() {
  if (C.recording) { C.recording = false; C.takes = C.takes.filter((tk) => tk.length); C.take = null; updateCreateUI(); saveCreate(); toast('Recording stopped – still looping'); return; }
  cStart(true);
}
function retimeCreate(newBpm) {
  if (C.playing) { const now = Engine.now(), oldSp = spb(), pos = (now - C.t0) / oldSp, beatPos = (C.nextBeatT - now) / oldSp;
    C.bpm = newBpm; const sp = spb(); C.t0 = now - pos * sp; C.nextBeatT = now + beatPos * sp; C.schedT = now + 0.12; }
  else C.bpm = newBpm;
  $('cBpm').textContent = C.bpm; saveCreate();
}
const noteCount = () => C.takes.reduce((n, tk) => n + tk.filter((e) => e.b < C.bars * 4).length, 0);
function updateCreateUI() {
  $('cRec').classList.toggle('on', C.recording);
  $('cPlay').classList.toggle('on', C.playing);
  $('cPlay').querySelector('use').setAttribute('href', C.playing ? '#i-stop' : '#i-play'); $('cPlay').querySelector('span').textContent = C.playing ? 'Stop' : 'Play';
  $('cMeter').classList.toggle('rec', C.recording);
  $('cMetro').classList.toggle('on', C.metro); $('cBpm').textContent = C.bpm; $('cBars').value = C.bars;
  const n = noteCount(); $('cUndo').disabled = !C.takes.some((t) => t.length); $('cClear').disabled = !n; $('cSave').disabled = !n;
  if (!C.playing) { $('cFill').style.width = '0'; setText('cStatus', n ? `${n} notes recorded · ${C.bars} bar${C.bars > 1 ? 's' : ''}` : 'Ready – press Rec to record'); }
}
function createFrame() {
  if (!C.playing) return;
  const now = Engine.now(), sp = spb(), L = loopLen();
  if (now < C.t0) { const left = Math.ceil((C.t0 - now) / sp); setText('cStatus', `Count-in… ${left}`); $('cFill').style.width = '0'; return; }
  const pos = ((now - C.t0) % L) / L, bar = Math.floor(pos * C.bars) + 1;
  $('cFill').style.width = (pos * 100).toFixed(1) + '%';
  const takes = C.takes.filter((t) => t.length).length;
  setText('cStatus', (C.recording ? `● Recording · take ${Math.max(1, C.takes.length)}` : `Looping · ${takes} take${takes === 1 ? '' : 's'}`) + ` · bar ${bar}/${C.bars}`);
}
function setText(id, s) { const el = $(id); if (el._t !== s) { el._t = s; el.textContent = s; } }
async function saveAsLoop() {
  const evs = C.takes.flat().filter((e) => e.b < C.bars * 4); if (!evs.length) return toast('Record something first');
  const drumsOnly = evs.every((e) => e.k), fams = new Set(evs.filter((e) => e.i).map((e) => INST_BY_ID[e.i].fam)), ids = new Set(evs.filter((e) => e.i).map((e) => e.i));
  const def = drumsOnly ? 'Drums' : (fams.size === 1 && fams.has('Bass')) ? 'Bass' : [...ids].every((i) => ['pad', 'strings'].includes(i)) ? 'Chords' : 'Melody';
  const n = userLoops.size + 1;
  const extra = `<label class="field"><span>Category</span><select>${PRESETS.CATS.map((c) => `<option${c === def ? ' selected' : ''}>${c}</option>`).join('')}</select></label>`;
  const r = await promptBox('Save as Loop', `My Loop ${n}`, { label: 'Loop name', extra, ok: 'Save Loop' }); if (!r) return;
  const loop = { id: 'u' + Date.now().toString(36), name: r.name.slice(0, 40), cat: r.opt || def, genre: 'mine', bars: C.bars, bpm: C.bpm, user: true, created: Date.now(), events: evs.map(({ skip, ...e }) => e) };
  try { await DB.put('loops', loop); askPersist(); } catch (e) { storageError(e); return; }
  userLoops.set(loop.id, loop); Libs.forEach((l) => l.render());
  toast(`Saved “${loop.name}” to My Loops (Produce)`, 2600);
}
function setupCreate() {
  buildInstList();
  MUSIC.NOTE_NAMES.forEach((n, i) => $('keySel').add(new Option(n, i)));
  Object.keys(MUSIC.SCALES).forEach((s) => $('scaleSel').add(new Option(s, s)));
  if (!MUSIC.SCALES[C.scale]) C.scale = 'Major';
  $('keySel').value = C.key; $('scaleSel').value = C.scale;
  $('keySel').onchange = (e) => { C.key = +e.target.value; layoutPads(true); saveCreate(); };
  $('scaleSel').onchange = (e) => { C.scale = e.target.value; layoutPads(true); saveCreate(); };
  $('octDn').onclick = () => { C.oct = clamp(C.oct - 1, 0, 7); layoutPads(true); saveCreate(); };
  $('octUp').onclick = () => { C.oct = clamp(C.oct + 1, 0, 7); layoutPads(true); saveCreate(); };
  $('cRec').onclick = toggleRec;
  $('cPlay').onclick = () => (C.playing ? cStop() : cStart(false));
  $('cStop').onclick = cStop;
  $('cMetro').onclick = () => { C.metro = !C.metro; updateCreateUI(); saveCreate(); };
  holdRepeat($('cBpmDn'), () => retimeCreate(clamp(C.bpm - 1, 50, 200)));
  holdRepeat($('cBpmUp'), () => retimeCreate(clamp(C.bpm + 1, 50, 200)));
  $('cBars').onchange = (e) => { const was = C.playing; if (was) cStop(); C.bars = +e.target.value; updateCreateUI(); saveCreate(); if (was) cStart(false); };
  $('cUndo').onclick = () => { for (let i = C.takes.length - 1; i >= 0; i--) if (C.takes[i].length) { C.takes.splice(i, 1); if (C.recording) { C.take = null; newTake(); } toast('Last take removed'); break; } updateCreateUI(); saveCreate(); };
  $('cClear').onclick = async () => { if (!(await confirmBox('Clear recording?', 'All takes in this loop will be removed.', 'Clear', true))) return; cStop(); C.takes = []; updateCreateUI(); saveCreate(); };
  $('cSave').onclick = saveAsLoop;
  $('fsBtn').onclick = () => setFullscreen(true); $('fsExit').onclick = () => setFullscreen(false);
  $('instNow').onclick = pickInstrumentSheet;
  setupPadInput();
  new ResizeObserver(() => requestAnimationFrame(() => layoutPads(false))).observe($('padGrid'));
  const s = C.sel, ok = s && (s.type === 'kit' ? DSP.KITS[s.id] : INST_BY_ID[s.id]);
  selectInstrument(ok ? s.type : 'inst', ok ? s.id : 'piano', false);
  updateCreateUI();
}
async function pickInstrumentSheet() {
  const wrap = document.createElement('div'); wrap.className = 'm-menu';
  [...INSTRUMENTS.map((i) => ({ type: 'inst', id: i.id, name: i.name })), ...KIT_LIST.map((k) => ({ type: 'kit', id: k.id, name: k.name }))].forEach((x) => {
    const b = document.createElement('button'); b.className = 'chip' + (C.sel.type === x.type && C.sel.id === x.id ? ' on' : ''); b.textContent = x.name; b.onclick = () => modalResolve(x); wrap.appendChild(b); });
  const r = await modal({ title: 'Instrument', body: wrap, actions: [{ label: 'Close', value: null }] }); if (r) selectInstrument(r.type, r.id, true);
}
function setFullscreen(on) {
  document.body.classList.toggle('fs', on);
  const d = document.documentElement;
  if (on && d.requestFullscreen && !document.fullscreenElement) d.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTimeout(() => layoutPads(false), 120);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('fs')) { document.body.classList.remove('fs'); setTimeout(() => layoutPads(false), 80); } });
function holdRepeat(btn, fn) {
  let t1, t2; const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(); fn(); t1 = setTimeout(() => { t2 = setInterval(fn, 70); }, 420); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}

/* =====================================================================
 * AREA 2 · PRODUCE – one clock shared by the song, DJ pads and previews.
 * Loops are scheduled one bar at a time (one BufferSource per lane per bar),
 * so edits take effect on the next bar and node count stays tiny.
 * ===================================================================== */
const P = { bpm: 90, running: false, t0: 0, nextBar: 0, songOn: false, songOffset: 0, songFrom: 0, cursor: 0, pads: new Map(), preview: null, loadingPad: null };
const barDur = () => 240 / P.bpm;
/* Tempo map: tempo changes take effect on a bar line, so playback never stops or jumps. */
P.seg = [];
const seg0 = () => P.seg[0] || { bar: 0, t: P.t0, bpm: P.bpm };
function segForBar(b) { for (let i = P.seg.length - 1; i > 0; i--) if (b >= P.seg[i].bar) return P.seg[i]; return seg0(); }
const timeOfBar = (b) => { const s = segForBar(b); return s.t + (b - s.bar) * 240 / s.bpm; };
const barAt = (t) => { let s = seg0(); for (let i = 1; i < P.seg.length; i++) if (t >= P.seg[i].t) s = P.seg[i]; return s.bar + (t - s.t) * s.bpm / 240; };
const LANES = 6;
function blankSong() { return { id: null, name: 'Untitled Song', bpm: 90, lanes: Array.from({ length: LANES }, (_, i) => ({ name: 'Track ' + (i + 1), vol: 0.8, mute: false })), clips: [] }; }
let song = store.get('stella4-song', null); if (!song || !Array.isArray(song.clips) || !Array.isArray(song.lanes) || song.lanes.length !== LANES) song = blankSong();
P.bpm = clamp(song.bpm || 90, 60, 190);
const songEnd = () => song.clips.reduce((m, c) => Math.max(m, c.start + c.len), 0);
let clipSeq = Date.now() % 100000;
const newClipId = () => 'c' + (clipSeq++).toString(36);

function clockStart() { if (P.running) return; Engine.init(); P.t0 = Engine.now() + 0.1; P.seg = [{ bar: 0, t: P.t0, bpm: P.bpm }]; P.nextBar = 0; P.running = true; Sched.add(pTick); startRaf(); }
function clockStopIfIdle() { if (P.running && !P.songOn && !P.pads.size) { P.running = false; Sched.remove(pTick); } }
function nextLaunchBar() { if (!P.running) { clockStart(); return 0; } return Math.max(0, Math.ceil(barAt(Engine.now() + 0.06) - 1e-6)); }
function pTick() {
  if (!P.running) return;
  const now = Engine.now();
  while (timeOfBar(P.nextBar) < now + 0.4) { scheduleBar(P.nextBar); P.nextBar++; }
  const cur = barAt(now);
  if (P.songOn && cur >= P.songOffset + (songEnd() - P.songFrom)) { P.songOn = false; P.cursor = 0; updateProduceUI(); }
  for (const [i, pd] of P.pads) if (pd.stopBar != null && cur >= pd.stopBar) P.pads.delete(i);
  clockStopIfIdle();
}
function scheduleBar(b) {
  if (P.songOn) { const sb = b - P.songOffset + P.songFrom; if (sb >= P.songFrom && sb < songEnd()) for (const c of song.clips) if (c.start <= sb && sb < c.start + c.len) scheduleClipBar(c, sb, b); }
  for (const [idx, pd] of P.pads) if (b >= pd.startBar && (pd.stopBar == null || b < pd.stopBar)) schedulePadBar(idx, pd, b);
}
function scheduleClipBar(c, sb, b) {
  const def = getLoop(c.loop), lane = song.lanes[c.lane]; if (!def || !lane) return;
  const buf = Engine.cachedLoop(def, P.bpm); if (!buf) { Engine.renderLoop(def, P.bpm); return; }
  const off = ((sb - c.start) % def.bars) * barDur();
  const r = Engine.play(buf, timeOfBar(b), { bus: def.cat, vel: lane.mute ? 0 : lane.vol, offset: off, dur: barDur() }); if (r) r.tag = { clip: c.id, lane: c.lane, bar: b };
}
function schedulePadBar(idx, pd, b) {
  const buf = Engine.cachedLoop(pd.def, P.bpm); if (!buf) return;
  const off = ((b - pd.startBar) % pd.def.bars) * barDur();
  const r = Engine.play(buf, timeOfBar(b), { bus: pd.def.cat, vel: 0.9, offset: off, dur: barDur() }); if (r) r.tag = { pad: idx, bar: b };
}
async function prepareLoops(defs, label) {
  const todo = defs.filter((d) => d && !Engine.cachedLoop(d, P.bpm)); let n = 0;
  for (const d of todo) { await Engine.renderLoop(d, P.bpm); n++; if (label && todo.length > 1) toast(`${label} ${n}/${todo.length}`, 1200); }
}
let songStarting = false;
async function songPlay() {
  Engine.init();
  if (P.songOn) return songStop();
  if (songStarting) return;
  if (!song.clips.length) return toast('Drag a loop onto a track first');
  stopPreview(); songStarting = true;
  const btn = $('pPlay'); btn.classList.add('busy');
  try { await prepareLoops([...new Set(song.clips.map((c) => c.loop))].map(getLoop), 'Preparing sounds…'); } finally { btn.classList.remove('busy'); songStarting = false; }
  if (P.cursor >= songEnd()) P.cursor = 0;
  const b = nextLaunchBar(); P.songOffset = b; P.songFrom = P.cursor; P.songOn = true;
  for (let bb = b; bb < P.nextBar; bb++) { const sb = bb - P.songOffset + P.songFrom; for (const c of song.clips) if (c.start <= sb && sb < c.start + c.len) scheduleClipBar(c, sb, bb); }
  pTick(); startRaf(); updateProduceUI();
}
function songStop() {
  P.songOn = false; if (Engine.ctx) Engine.stopTag((r) => r.tag && r.tag.clip != null, Engine.now(), 0.04);
  clockStopIfIdle(); updateProduceUI();
}
function stopAll() {
  P.pads.clear(); P.songOn = false; stopPreview();
  if (Engine.ctx) Engine.stopTag((r) => r.tag && typeof r.tag === 'object', Engine.now(), 0.04);
  clockStopIfIdle(); updateProduceUI(); DJ.refresh(true);
}
/** After an edit while playing, drop the clip's scheduled audio and re-schedule the bars already queued. */
function rescheduleClip(id) {
  if (!P.songOn || !Engine.ctx) return; const now = Engine.now();
  Engine.stopTag((r) => r.tag && r.tag.clip === id, now, 0.02);
  const c = song.clips.find((x) => x.id === id); if (!c) return;
  for (let bb = Math.ceil(barAt(now) + 0.02); bb < P.nextBar; bb++) { const sb = bb - P.songOffset + P.songFrom; if (c.start <= sb && sb < c.start + c.len) scheduleClipBar(c, sb, bb); }
  const def = getLoop(c.loop); if (def) Engine.renderLoop(def, P.bpm);
}
/** Change tempo. While playing, the loops are re-rendered at the new tempo in the background and the
 *  change lands on the next bar line, so the music keeps going. Rapid taps are merged. */
let tempoTimer = 0, tempoTok = 0;
function setProduceBpm(v) {
  v = clamp(Math.round(v), 60, 190); if (v === song.bpm && v === P.bpm) return;
  song.bpm = v; $('pBpm').textContent = v; $('djBpm').textContent = v; saveSong();
  clearTimeout(tempoTimer);
  if (!P.running) return applyTempoNow(v);
  tempoTimer = setTimeout(() => applyTempo(v), 220);
}
function applyTempoNow(v) {
  ++tempoTok; const pv = P.preview && P.preview.id; P.bpm = v;
  if (pv) { stopPreview(); preview(pv); }
  Engine.clearLoopCache((k) => !k.includes('@' + v + '#'));
}
async function applyTempo(v) {
  const tok = ++tempoTok, defs = new Set();
  if (P.songOn) song.clips.forEach((c) => defs.add(getLoop(c.loop)));
  P.pads.forEach((pd) => defs.add(pd.def));
  $('pBpm').parentElement.classList.add('busy');
  try { for (const d of defs) if (d) { await Engine.renderLoop(d, v); if (tok !== tempoTok) return; } }
  finally { if (tok === tempoTok) $('pBpm').parentElement.classList.remove('busy'); }
  if (!P.running) return applyTempoNow(v);
  const S = P.nextBar; P.seg.push({ bar: S, t: timeOfBar(S), bpm: v }); if (P.seg.length > 8) P.seg.splice(0, P.seg.length - 8);
  const pv = P.preview && P.preview.id; P.bpm = v; if (pv) { stopPreview(); preview(pv); }
  setTimeout(() => { if (P.bpm === v) Engine.clearLoopCache((k) => !k.includes('@' + v + '#')); }, 4000);
}

/* ---------- previews ---------- */
async function preview(id) {
  Engine.init();
  if (P.preview && P.preview.id === id) return stopPreview();
  stopPreview(); const def = getLoop(id); if (!def) return;
  const me = { id }; P.preview = me; markLibState(); startRaf();
  const buf = await Engine.renderLoop(def, P.bpm);
  if (P.preview !== me) return;
  let t = Engine.now() + 0.02; if (P.running) { const q = Math.ceil(barAt(t) * 4) / 4, fb = Math.floor(q); t = timeOfBar(fb) + (q - fb) * barDur(); }
  const r = Engine.play(buf, t, { bus: def.cat, vel: 0.9, loop: true }); if (r) r.tag = { preview: id };
  me.rec = r; markLibState();
}
function stopPreview() { if (!P.preview) return; if (P.preview.rec) Engine.release(P.preview.rec, Engine.now(), 0.05); P.preview = null; markLibState(); }
function markLibState() { document.querySelectorAll('.loop').forEach((el) => { const on = P.preview && P.preview.id === el.dataset.id; el.classList.toggle('playing', !!(on && P.preview.rec)); el.classList.toggle('loading', !!(on && !P.preview.rec)); }); }

/* ---------- library component (used in Produce and in the DJ assign drawer) ---------- */
const Libs = [];
class Library {
  constructor(listEl, segEl, genreEl, opts) {
    Object.assign(this, { listEl, segEl, genreEl, opts, cat: 'All', genre: opts.genre || 'all' });
    segEl.innerHTML = ['All', ...PRESETS.CATS, 'Mine'].map((c) => `<button data-c="${c}" style="--cc:${CAT_COLOR[c] || (c === 'Mine' ? '#f472b6' : '#8b5cf6')}">${c === 'Mine' ? 'My Loops' : c}</button>`).join('');
    segEl.onclick = (e) => { const b = e.target.closest('button'); if (b) { this.cat = b.dataset.c; this.render(); this.listEl.scrollTop = 0; } };
    genreEl.add(new Option('All genres', 'all')); Object.entries(PRESETS.GENRES).forEach(([k, g]) => genreEl.add(new Option(`${g.name} · ${g.bpm}`, k)));
    genreEl.value = this.genre; genreEl.onchange = () => { this.genre = genreEl.value; this.render(); this.listEl.scrollTop = 0; };
    listEl.addEventListener('pointerdown', (e) => this.down(e));
    listEl.addEventListener('click', (e) => { const add = e.target.closest('.ladd'), del = e.target.closest('.ldel'), item = e.target.closest('.loop');
      if (!item) return; if (add) { e.stopPropagation(); this.opts.onAdd && this.opts.onAdd(item.dataset.id); } else if (del) { e.stopPropagation(); deleteUserLoop(item.dataset.id); } });
    Libs.push(this); this.render();
  }
  items() {
    const mine = [...userLoops.values()].sort((a, b) => b.created - a.created);
    if (this.cat === 'Mine') return mine;
    let all = [...mine, ...PRESETS.list];
    if (this.cat !== 'All') all = all.filter((l) => l.cat === this.cat);
    if (this.genre !== 'all') all = all.filter((l) => l.genre === this.genre);
    return all;
  }
  render() {
    this.segEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === this.cat));
    const items = this.items(); let html = '', grp = null;
    if (!items.length) html = this.cat === 'Mine' ? '<div class="lib-empty">No loops of your own yet.<br>Record one in <b>Create</b>, then tap <b>Save as Loop</b>.</div>' : '<div class="lib-empty">No loops here.</div>';
    for (const l of items) {
      const g = this.genre === 'all' ? genreName(l.genre) : l.cat; if (g !== grp) { grp = g; html += `<div class="lib-group">${esc(g)}</div>`; }
      html += `<div class="loop" role="listitem" data-id="${l.id}" style="--cc:${CAT_COLOR[l.cat]}"><div class="grip" title="Drag"><i></i><svg><use href="#i-grip"/></svg></div>` +
        `<div class="lmeta"><span class="lname">${esc(l.name)}</span><span class="lsub">${esc(this.genre === 'all' ? l.cat : genreName(l.genre))} · ${l.bars} bar${l.bars > 1 ? 's' : ''}</span></div>` +
        (l.user ? `<button class="ldel" title="Delete loop" aria-label="Delete loop"><svg><use href="#i-trash"/></svg></button>` : '') +
        (this.opts.onAdd ? `<button class="ladd" title="Add to song" aria-label="Add to song"><svg><use href="#i-plus"/></svg></button>` : '') + `</div>`;
    }
    this.listEl.innerHTML = html; markLibState();
  }
  /** Tap = preview/assign; drag (grip, mouse, or a sideways swipe) = drag & drop. Vertical swipes scroll the list. */
  down(e) {
    const item = e.target.closest('.loop'); if (!item || e.target.closest('.ladd, .ldel') || e.button > 0) return;
    const id = item.dataset.id, grip = !!e.target.closest('.grip'), x0 = e.clientX, y0 = e.clientY, mouse = e.pointerType === 'mouse';
    let dragging = false, dead = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId || dead) return; const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (dragging) { ev.preventDefault(); Drag.move(ev.clientX, ev.clientY); return; }
      if ((mouse || grip) ? Math.hypot(dx, dy) > 5 : (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2)) { dragging = true; Drag.begin(id, ev.clientX, ev.clientY); }
      else if (!mouse && !grip && Math.abs(dy) > 10) dead = true;
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return; cleanup();
      if (dragging) Drag.end(ev.type === 'pointercancel' ? null : ev.clientX, ev.clientY);
      else if (!dead && ev.type === 'pointerup' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) this.opts.onTap(id);
    };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
}
async function deleteUserLoop(id) {
  const l = userLoops.get(id); if (!l) return;
  const used = song.clips.filter((c) => c.loop === id).length;
  if (!(await confirmBox('Delete loop?', `“${l.name}” will be removed${used ? ` along with ${used} clip${used > 1 ? 's' : ''} in this song` : ''}.`, 'Delete', true))) return;
  if (P.preview && P.preview.id === id) stopPreview();
  if (used) { pushUndo(); const gone = new Set(song.clips.filter((c) => c.loop === id).map((c) => c.id)); song.clips = song.clips.filter((c) => c.loop !== id);
    if (Engine.ctx) Engine.stopTag((r) => r.tag && gone.has(r.tag.clip), Engine.now()); }
  for (const [i, pd] of P.pads) if (pd.def.id === id) { P.pads.delete(i); Engine.stopTag((r) => r.tag && r.tag.pad === i, Engine.now()); }
  userLoops.delete(id); await DB.del('loops', id).catch(() => {}); Engine.clearLoopCache((k) => k.startsWith(id + '@'));
  Libs.forEach((x) => x.render()); renderArranger(); saveSong(); if (DJ.open) DJ.render(); toast('Loop deleted');
}

/* ---------- drag & drop (pointer events: mouse, touch and pen) ---------- */
const Drag = {
  st: null,
  begin(id, x, y) {
    const def = getLoop(id); if (!def) return; const g = $('dragGhost');
    g.textContent = def.name; g.style.setProperty('--cc', CAT_COLOR[def.cat]); g.hidden = false;
    this.st = { id, def, target: null }; document.body.classList.add('dragging'); this.move(x, y); haptic();
  },
  move(x, y) {
    const st = this.st; if (!st) return; const g = $('dragGhost'); g.style.left = x + 'px'; g.style.top = y + 'px';
    const el = document.elementFromPoint(x, y), lane = el && el.closest && el.closest('.lane'), pad = el && el.closest && el.closest('.djpad');
    document.querySelectorAll('.djpad.drop').forEach((p) => p.classList.remove('drop'));
    Arr.clearDropGhost();
    if (lane && !DJ.open) { const li = +lane.dataset.lane, len = defaultLen(st.def), s = findFree(li, Arr.barFromX(x), len); st.target = { lane: li, start: s, len }; Arr.showDropGhost(li, s, len, st.def); Arr.autoScroll(x); }
    else if (pad) { pad.classList.add('drop'); st.target = { pad: +pad.dataset.i }; }
    else st.target = null;
  },
  end(x) {
    const st = this.st; this.st = null; $('dragGhost').hidden = true; document.body.classList.remove('dragging'); Arr.clearDropGhost();
    document.querySelectorAll('.djpad.drop').forEach((p) => p.classList.remove('drop'));
    if (!st || x == null || !st.target) return;
    if (st.target.pad != null) DJ.assignTo(st.target.pad, st.id);
    else if (st.target.start + st.target.len > 128) toast('Songs can be up to 128 bars');
    else addClip(st.id, st.target.lane, st.target.start, st.target.len);
  },
};
// While a loop is being dragged on a touch screen, stop the list from scrolling (which would cancel the drag).
window.addEventListener('touchmove', (e) => { if (Drag.st && e.cancelable) e.preventDefault(); }, { passive: false });

/* ---------- arranger ---------- */
const undoStack = [];
function pushUndo() { undoStack.push(JSON.stringify({ lanes: song.lanes, clips: song.clips, bpm: song.bpm })); if (undoStack.length > 40) undoStack.shift(); $('pUndo').disabled = false; }
function undo() {
  const s = undoStack.pop(); $('pUndo').disabled = !undoStack.length; if (!s) return toast('Nothing to undo');
  const o = JSON.parse(s), before = song.clips.map((c) => c.id); song.lanes = o.lanes; song.clips = o.clips;
  if (o.bpm && o.bpm !== P.bpm) setProduceBpm(o.bpm);
  new Set([...before, ...song.clips.map((c) => c.id)]).forEach(rescheduleClip);
  song.lanes.forEach((_, i) => applyLaneGain(i));
  Arr.sel = null; renderArranger(); saveSong(); toast('Undo');
}
const saveSong = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => store.set('stella4-song', song), 500); }; })();
const defaultLen = (def) => Math.max(4, def.bars);
function overlaps(lane, start, len, ignore) { return song.clips.some((c) => c.id !== ignore && c.lane === lane && c.start < start + len && start < c.start + c.len); }
function findFree(lane, start, len, ignore) {
  start = Math.max(0, start);
  for (let d = 0; d < 200; d++) { if (!overlaps(lane, start + d, len, ignore)) return start + d; if (start - d >= 0 && !overlaps(lane, start - d, len, ignore)) return start - d; }
  return songEnd();
}
function addClip(loopId, lane, start, len) {
  const def = getLoop(loopId); if (!def) return null;
  const g = PRESETS.GENRES[def.genre];
  if (!song.clips.length && !def.user && g && P.bpm !== g.bpm && !P.pads.size) { setProduceBpm(g.bpm); toast(`Song tempo set to ${P.bpm} BPM (${g.name})`); }
  if (start + len > 128) { toast('Songs can be up to 128 bars'); return null; }
  pushUndo(); const c = { id: newClipId(), lane, start, len, loop: loopId }; song.clips.push(c); Arr.sel = c.id;
  Engine.renderLoop(def, P.bpm); rescheduleClip(c.id); renderArranger(); saveSong(); haptic();
  return c;
}
/** “+” button: append to the track already holding this category (or the first empty track). */
function quickAdd(loopId) {
  const def = getLoop(loopId); if (!def) return;
  let lane = -1;
  for (let i = 0; i < LANES && lane < 0; i++) if (song.clips.some((c) => c.lane === i && (getLoop(c.loop) || {}).cat === def.cat)) lane = i;
  for (let i = 0; i < LANES && lane < 0; i++) if (!song.clips.some((c) => c.lane === i)) lane = i;
  if (lane < 0) lane = (song.clips.find((c) => c.id === Arr.sel) || { lane: 0 }).lane;
  const end = song.clips.filter((c) => c.lane === lane).reduce((m, c) => Math.max(m, c.start + c.len), 0);
  const c = addClip(loopId, lane, end, defaultLen(def)); if (c) { toast(`Added to ${song.lanes[lane].name} at bar ${end + 1}`); Arr.scrollToBar(end); }
}
const Arr = {
  sel: null,
  barW() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--barw')) || 56; },
  laneH() { const l = document.querySelector('.lane'); return l ? l.getBoundingClientRect().height : 54; },
  barFromX(x) { const r = $('lanes').getBoundingClientRect(); return Math.max(0, Math.floor((x - r.left) / this.barW())); },
  laneFromY(y) { const r = $('lanes').getBoundingClientRect(); return clamp(Math.floor((y - r.top) / this.laneH()), 0, LANES - 1); },
  showDropGhost(li, start, len, def) {
    const lane = document.querySelector(`.lane[data-lane="${li}"]`); if (!lane) return; lane.classList.add('drop');
    const g = document.createElement('div'); g.className = 'drop-ghost'; g.style.left = start * this.barW() + 'px'; g.style.width = len * this.barW() - 2 + 'px'; g.style.setProperty('--cc', CAT_COLOR[def.cat]); lane.appendChild(g);
  },
  clearDropGhost() { document.querySelectorAll('.drop-ghost').forEach((g) => g.remove()); document.querySelectorAll('.lane.drop').forEach((l) => l.classList.remove('drop')); },
  autoScroll(x) { const tl = $('timeline'), r = tl.getBoundingClientRect(); if (x > r.right - 40) tl.scrollLeft += 14; else if (x < r.left + 30) tl.scrollLeft -= 14; },
  scrollToBar(b) { const tl = $('timeline'), x = b * this.barW(); if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 80) tl.scrollLeft = Math.max(0, x - 40); },
};
function totalBars() { return clamp(Math.ceil((songEnd() + 8) / 4) * 4, 16, 128); }
function renderArranger() {
  const bw = Arr.barW(), total = Math.min(128, Math.max(totalBars(), Math.ceil(($('timeline').clientWidth || 0) / bw)));
  $('tlInner').style.width = total * bw + 'px';
  let rh = ''; for (let b = 0; b < total; b++) rh += `<span class="${b % 4 === 0 ? 'major' : ''}" style="left:${b * bw}px;width:${bw}px">${b % 4 === 0 || bw > 50 ? b + 1 : ''}</span>`;
  $('ruler').innerHTML = rh;
  let lh = '';
  for (let i = 0; i < LANES; i++) {
    lh += `<div class="lane" data-lane="${i}">`;
    for (const c of song.clips) {
      if (c.lane !== i) continue; const def = getLoop(c.loop), color = def ? CAT_COLOR[def.cat] : '#555';
      lh += `<div class="clip${def ? '' : ' missing'}${Arr.sel === c.id ? ' sel' : ''}" data-id="${c.id}" style="left:${c.start * bw + 1}px;width:${c.len * bw - 2}px;--cc:${color};--repw:${(def ? def.bars : c.len) * bw}px">` +
        `<span class="cn">${esc(def ? def.name : 'Missing loop')}</span><span class="cs">${def ? esc(def.cat) : ''}</span><div class="rz" title="Drag to resize"></div></div>`;
    }
    lh += '</div>';
  }
  $('lanes').innerHTML = lh;
  let hh = '<div class="ruler-pad"></div>';
  song.lanes.forEach((l, i) => { const first = song.clips.filter((c) => c.lane === i).map((c) => getLoop(c.loop)).find(Boolean);
    hh += `<div class="lane-head${l.mute ? ' muted' : ''}" data-lane="${i}" style="--lc:${first ? CAT_COLOR[first.cat] : 'var(--line2)'}"><div class="lh-row"><span class="lh-name" title="Double-tap to rename">${esc(l.name)}</span><button class="mute${l.mute ? ' on' : ''}" title="Mute" aria-label="Mute ${esc(l.name)}">M</button></div>` +
      `<input type="range" min="0" max="1" step="0.01" value="${l.vol}" aria-label="${esc(l.name)} volume"></div>`; });
  $('laneHeads').innerHTML = hh;
  $('cursor').style.left = P.cursor * bw + 'px';
  updateClipBar();
  const es = $('emptyState');
  if (!song.clips.length && !es) {
    const d = document.createElement('div'); d.id = 'emptyState'; d.className = 'lib-empty'; d.style.cssText = 'position:absolute;left:12px;top:40px;width:min(420px,80vw);pointer-events:none;text-align:left';
    d.innerHTML = 'Drag loops here to build your song, or<br><button class="chip accent" id="tplBtn" style="pointer-events:auto;margin-top:8px">Start from a genre template</button>';
    $('tlInner').appendChild(d); $('tplBtn').onclick = templatePicker;
  } else if (song.clips.length && es) es.remove();
}
function updateClipBar() {
  const c = song.clips.find((x) => x.id === Arr.sel), bar = $('clipBar'); bar.classList.toggle('empty', !c);
  if (!c) { $('clipInfo').textContent = song.clips.length ? 'Tap a clip to edit it' : 'No clips yet'; return; }
  const def = getLoop(c.loop); $('clipInfo').textContent = `${def ? def.name : 'Missing'} · ${song.lanes[c.lane].name} · bar ${c.start + 1}`; $('clipLen').textContent = c.len + (c.len > 1 ? ' bars' : ' bar');
}
function selectClip(id) { Arr.sel = id; document.querySelectorAll('.clip').forEach((el) => el.classList.toggle('sel', el.dataset.id === id)); updateClipBar(); }
function editClip(fn) { const c = song.clips.find((x) => x.id === Arr.sel); if (!c) return; pushUndo(); fn(c); rescheduleClip(c.id); renderArranger(); saveSong(); }
function deleteClip() { const c = song.clips.find((x) => x.id === Arr.sel); if (!c) return; pushUndo(); song.clips = song.clips.filter((x) => x !== c); if (Engine.ctx) Engine.stopTag((r) => r.tag && r.tag.clip === c.id, Engine.now(), 0.03); Arr.sel = null; renderArranger(); saveSong(); }
function duplicateClip() { const c = song.clips.find((x) => x.id === Arr.sel); if (!c) return; const s = findFree(c.lane, c.start + c.len, c.len); if (s + c.len > 128) return toast('Songs can be up to 128 bars');
  pushUndo(); const n = { ...c, id: newClipId(), start: s }; song.clips.push(n); Arr.sel = n.id; rescheduleClip(n.id); renderArranger(); saveSong(); Arr.scrollToBar(s); }
function setupArranger() {
  const lanes = $('lanes');
  lanes.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.clip'); if (!el) { if (e.target.closest('.lane')) selectClip(null); return; }
    if (e.button > 0) return; e.preventDefault();
    const c = song.clips.find((x) => x.id === el.dataset.id); if (!c) return; selectClip(c.id);
    const resize = !!e.target.closest('.rz'), x0 = e.clientX, y0 = e.clientY, bw = Arr.barW(), lh = Arr.laneH(); let moved = false, nl = c.lane, ns = c.start, nlen = c.len;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0; if (!moved && Math.hypot(dx, dy) < 6) return; moved = true; el.classList.add('drag');
      if (resize) { const next = song.clips.filter((o) => o.lane === c.lane && o.start > c.start && o.id !== c.id).reduce((m, o) => Math.min(m, o.start), 128);
        nlen = clamp(Math.round(c.len + dx / bw), 1, next - c.start); el.style.width = nlen * bw - 2 + 'px'; }
      else { nl = Arr.laneFromY(ev.clientY); ns = clamp(Math.round(c.start + dx / bw), 0, 128 - c.len);
        el.style.left = ns * bw + 1 + 'px'; el.style.transform = `translateY(${(nl - c.lane) * lh}px)`; el.classList.toggle('bad', overlaps(nl, ns, c.len, c.id)); Arr.autoScroll(ev.clientX); }
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!moved) return;
      if (resize) { if (nlen !== c.len) editClip((x) => { x.len = nlen; }); else renderArranger(); }
      else { const s = findFree(nl, ns, c.len, c.id); if (s !== c.start || nl !== c.lane) editClip((x) => { x.lane = nl; x.start = s; }); else renderArranger(); }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  $('ruler').addEventListener('click', (e) => { const r = $('ruler').getBoundingClientRect(); P.cursor = clamp(Math.floor((e.clientX - r.left) / Arr.barW()), 0, 127); $('cursor').style.left = P.cursor * Arr.barW() + 'px';
    if (P.songOn) { songStop(); songPlay(); } });
  $('laneHeads').addEventListener('click', (e) => { const m = e.target.closest('.mute'); if (!m) return; const i = +m.closest('.lane-head').dataset.lane, l = song.lanes[i]; l.mute = !l.mute; applyLaneGain(i); renderArranger(); saveSong(); });
  $('laneHeads').addEventListener('input', (e) => { if (e.target.type !== 'range') return; const i = +e.target.closest('.lane-head').dataset.lane; song.lanes[i].vol = +e.target.value; applyLaneGain(i); saveSong(); });
  $('laneHeads').addEventListener('dblclick', async (e) => { const h = e.target.closest('.lane-head'); if (!h || e.target.closest('button,input')) return; const i = +h.dataset.lane;
    const r = await promptBox('Rename track', song.lanes[i].name, { label: 'Track name', ok: 'Rename' }); if (r) { song.lanes[i].name = r.name.slice(0, 20); renderArranger(); saveSong(); } });
  $('clipShorter').onclick = () => editClip((c) => { c.len = Math.max(1, c.len - 1); });
  $('clipLonger').onclick = () => { const c = song.clips.find((x) => x.id === Arr.sel); if (!c) return; if (overlaps(c.lane, c.start + c.len, 1, c.id)) return toast('The next clip is in the way'); if (c.start + c.len >= 128) return; editClip((x) => { x.len += 1; }); };
  $('clipDup').onclick = duplicateClip; $('clipDel').onclick = deleteClip;
  $('pPlay').onclick = songPlay;
  $('pStart').onclick = () => { P.cursor = 0; $('cursor').style.left = '0px'; $('timeline').scrollLeft = 0; if (P.songOn) { songStop(); songPlay(); } };
  holdRepeat($('pBpmDn'), () => setProduceBpm(song.bpm - 1)); holdRepeat($('pBpmUp'), () => setProduceBpm(song.bpm + 1));
  $('pUndo').onclick = undo; $('pUndo').disabled = true;
  $('songName').onclick = async () => { const r = await promptBox('Rename song', song.name, { label: 'Song name', ok: 'Rename' }); if (r) { song.name = r.name.slice(0, 40); updateProduceUI(); saveSong(); } };
  $('songMenu').onclick = songMenu;
  window.addEventListener('resize', () => { const bw = Arr.barW(); const w = $('timeline').clientWidth; if (bw !== Arr._bw || Math.abs(w - (Arr._tw || 0)) > 40) { Arr._bw = bw; Arr._tw = w; if (tab === 'produce') renderArranger(); } });
}
function applyLaneGain(i) {
  if (!Engine.ctx) return; const l = song.lanes[i]; if (!l) return; const v = l.mute ? 0 : l.vol, t = Engine.now();
  for (const r of Engine.active) if (r.tag && r.tag.clip && r.tag.lane === i) r.g.gain.setTargetAtTime(v, t, 0.02);
}
function updateProduceUI() {
  const on = P.songOn; $('pPlay').classList.toggle('on', on); $('pPlay').querySelector('use').setAttribute('href', on ? '#i-stop' : '#i-play'); $('pPlay').querySelector('span').textContent = on ? 'Stop' : 'Play';
  $('pBpm').textContent = P.bpm; $('djBpm').textContent = P.bpm; $('songName').textContent = song.name;
  $('playhead').classList.toggle('on', on); if (!on) $('cursor').style.left = P.cursor * Arr.barW() + 'px';
}
function produceFrame() {
  if (!P.songOn || !P.running || tab !== 'produce') return; const cur = barAt(Engine.now()) - P.songOffset; if (cur < 0) return;
  const x = (P.songFrom + cur) * Arr.barW(); $('playhead').style.transform = `translateX(${x}px)`;
  const tl = $('timeline'); if (!Drag.st && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft)) tl.scrollLeft = Math.max(0, x - 60);
}

/* ---------- songs: new / open / save / export / templates ---------- */
async function songMenu() {
  const wrap = document.createElement('div'); wrap.className = 'm-menu';
  const items = [['new', '#i-new', 'New song'], ['open', '#i-folder', 'Open saved song…'], ['save', '#i-save', song.id ? 'Save' : 'Save song…'], ['saveas', '#i-dup', 'Save as copy…'], ['tpl', '#i-star', 'Start from a genre template…'], ['wav', '#i-down', 'Export WAV'], ['backup', '#i-down', 'Back up everything (file)…'], ['restore', '#i-folder', 'Restore from backup file…']];
  items.forEach(([v, ic, label]) => { const b = document.createElement('button'); b.className = 'chip'; b.dataset.v = v; b.innerHTML = `<svg><use href="${ic}"/></svg>${label}`; b.onclick = () => modalResolve(v); wrap.appendChild(b); });
  const r = await modal({ title: song.name, body: wrap, actions: [{ label: 'Close', value: null }] });
  if (r === 'new') { if (song.clips.length && !(await confirmBox('New song?', 'Unsaved changes to this song will be lost (Undo can bring it back).', 'New song'))) return;
    stopAll(); pushUndo(); const bpm = P.bpm; song = blankSong(); song.bpm = bpm; Arr.sel = null; P.cursor = 0; renderArranger(); updateProduceUI(); saveSong(); }
  else if (r === 'open') openSongDialog();
  else if (r === 'save') saveSongDb(false);
  else if (r === 'saveas') saveSongDb(true);
  else if (r === 'tpl') templatePicker();
  else if (r === 'wav') exportWav();
  else if (r === 'backup') exportBackup();
  else if (r === 'restore') importBackup();
}
async function saveSongDb(asCopy) {
  if (!song.id || asCopy) { const r = await promptBox(asCopy ? 'Save as copy' : 'Save song', asCopy ? song.name + ' (copy)' : song.name, { label: 'Song name' }); if (!r) return; song.name = r.name.slice(0, 40); song.id = 's' + Date.now().toString(36); }
  song.updated = Date.now();
  try { await DB.put('songs', JSON.parse(JSON.stringify(song))); toast(`Saved “${song.name}”`); askPersist(); } catch (e) { storageError(e); }
  updateProduceUI(); saveSong();
}
async function openSongDialog() {
  const songs = (await DB.all('songs').catch(() => [])).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const wrap = document.createElement('div'); wrap.className = 'm-list';
  if (!songs.length) wrap.innerHTML = '<p>No saved songs yet. Use <b>Song → Save</b> to keep one.</p>';
  songs.forEach((s) => { const row = document.createElement('div'); row.className = 'm-item';
    row.innerHTML = `<button class="grow">${esc(s.name)}<small>${s.clips.length} clips · ${s.bpm} BPM · ${new Date(s.updated || 0).toLocaleDateString()}</small></button><button class="icon-btn" aria-label="Delete song"><svg><use href="#i-trash"/></svg></button>`;
    row.querySelector('.grow').onclick = () => modalResolve({ open: s });
    row.querySelector('.icon-btn').onclick = async () => { await DB.del('songs', s.id).catch(() => {}); row.remove(); toast('Song deleted'); };
    wrap.appendChild(row); });
  const r = await modal({ title: 'Open song', body: wrap, actions: [{ label: 'Close', value: null }] });
  if (r && r.open) loadSong(r.open);
}
function loadSong(s) {
  stopAll(); pushUndo(); const ns = JSON.parse(JSON.stringify(s)); if (!Array.isArray(ns.lanes) || ns.lanes.length !== LANES) ns.lanes = blankSong().lanes;
  song = ns; const bpm = song.bpm || 90; song.bpm = P.bpm; setProduceBpm(bpm); Arr.sel = null; P.cursor = 0; renderArranger(); updateProduceUI(); saveSong(); toast(`Opened “${song.name}”`);
}
async function templatePicker() {
  const wrap = document.createElement('div'); wrap.className = 'm-menu';
  Object.entries(PRESETS.GENRES).forEach(([k, g]) => { const b = document.createElement('button'); b.className = 'chip'; b.dataset.v = k; b.textContent = `${g.name} · ${g.bpm} BPM`; b.onclick = () => modalResolve(k); wrap.appendChild(b); });
  const k = await modal({ title: 'Genre template', body: wrap, actions: [{ label: 'Cancel', value: null }] }); if (!k) return;
  if (song.clips.length && !(await confirmBox('Replace this song?', 'The template replaces the clips in this song. Undo can bring them back.', 'Use template'))) return;
  stopAll(); pushUndo(); applyTemplate(k);
  toast(`${PRESETS.GENRES[k].name} template loaded – press Play`);
}
function applyTemplate(k, name) {
  const L = (cat, n) => `${k}-${cat}-${n}`, g = PRESETS.GENRES[k];
  const plan = [[0, 'drums', 1, 8, 16], [0, 'drums', 2, 24, 8], [1, 'drums', 3, 16, 16], [2, 'bass', 1, 8, 16], [2, 'bass', 2, 24, 8], [3, 'chords', 1, 0, 24], [3, 'chords', 2, 24, 8], [4, 'melody', 1, 16, 16], [5, 'fx', 1, 4, 4], [5, 'fx', 2, 22, 2]];
  song.clips = plan.filter(([, c, n]) => getLoop(L(c, n))).map(([lane, c, n, start, len]) => ({ id: newClipId(), lane, start, len, loop: L(c, n) }));
  ['Drums', 'Percussion', 'Bass', 'Chords', 'Melody', 'FX'].forEach((nm, i) => { song.lanes[i].name = nm; song.lanes[i].mute = false; song.lanes[i].vol = 0.8; });
  song.name = name || g.name + ' Song'; song.id = null; setProduceBpm(g.bpm); Arr.sel = null; P.cursor = 0; renderArranger(); updateProduceUI(); saveSong(); $('timeline').scrollLeft = 0;
}
let exporting = false;
async function exportWav() {
  if (!song.clips.length) return toast('Add some clips first'); if (exporting) return;
  exporting = true; toast('Rendering WAV…', 4000);
  try {
    const blob = await Engine.exportSong(song, getLoop); window.__lastWav = blob;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (song.name.replace(/[^\w\- ]+/g, '').trim() || 'stella-song') + '.wav';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 15000);
    toast(`WAV exported (${(blob.size / 1048576).toFixed(1)} MB)`);
  } catch (e) { console.error(e); toast('Export failed'); } finally { exporting = false; }
}

/* =====================================================================
 * DJ PADS – full-screen clip launcher, 5 columns × 4 rows per bank.
 * Pads start on the next bar, tap again to stop at the next bar.
 * One loop per column, like a real clip launcher.
 * ===================================================================== */
const PADKEYS = ['12345', 'qwert', 'asdfg', 'zxcvb']; // top → bottom rows
const DJ = {
  open: false, bank: store.get('stella4-bank', 'house'), custom: store.get('stella4-pads', {}), assign: false, selPad: null, lastState: {}, padEls: null,
  defaultLoop(bank, idx) { const col = idx % 5, row = Math.floor(idx / 5); return `${bank}-${PRESETS.CATS[col].toLowerCase()}-${row + 1}`; },
  loopAt(idx) { const o = (this.custom[this.bank] || {})[idx]; return getLoop(o !== undefined ? o : this.defaultLoop(this.bank, idx)); },
  render() {
    $('djCols').innerHTML = PRESETS.CATS.map((c, i) => `<button class="dj-col" data-col="${i}" style="--cc:${CAT_COLOR[c]}" title="Stop all ${c}"><i></i>${c}<small>■</small></button>`).join('');
    let h = '';
    for (let i = 0; i < 20; i++) { const def = this.loopAt(i), key = PADKEYS[Math.floor(i / 5)][i % 5].toUpperCase();
      h += def ? `<button class="djpad" data-i="${i}" style="--cc:${CAT_COLOR[def.cat]}"><span class="dn">${esc(def.name).replace(/([A-Za-z]{4})([A-Za-z]{4,})/g, '$1&shy;$2')}</span><span class="dk"><span>${def.user ? 'Mine · ' : ''}${def.bars} bar${def.bars > 1 ? 's' : ''}</span><span class="key">${key}</span></span><span class="prog"></span></button>`
        : `<button class="djpad empty" data-i="${i}" style="--cc:${CAT_COLOR[PRESETS.CATS[i % 5]]}" aria-label="Empty pad"><svg><use href="#i-plus"/></svg></button>`; }
    $('djGrid').innerHTML = h; this.padEls = [...$('djGrid').children]; this.lastState = {}; this.refresh(true);
  },
  refresh(force) {
    if (!this.open || !this.padEls) return;
    const cur = P.running ? barAt(Engine.now()) : -1, liveCols = new Set();
    this.padEls.forEach((el, i) => {
      const pd = P.pads.get(i); let st = 'idle', prog = 0;
      if (pd && pd.bank === this.bank) {
        if (cur < pd.startBar) st = 'queued'; else { st = pd.stopBar != null ? 'stopping' : 'playing'; liveCols.add(i % 5); prog = ((cur - pd.startBar) % pd.def.bars) / pd.def.bars; }
      }
      if (P.loadingPad === i) st = 'loading';
      const s = st + (this.selPad === i ? '+sel' : '');
      if (force || this.lastState[i] !== s) { this.lastState[i] = s; el.classList.toggle('playing', st === 'playing' || st === 'stopping'); el.classList.toggle('queued', st === 'queued'); el.classList.toggle('stopping', st === 'stopping'); el.classList.toggle('loading', st === 'loading'); el.classList.toggle('selected', this.selPad === i); }
      const pg = el.lastChild; if (pg && pg.className === 'prog') pg.style.width = (st === 'playing' || st === 'stopping' ? prog * 100 : 0).toFixed(1) + '%';
    });
    document.querySelectorAll('.dj-col').forEach((c, i) => c.classList.toggle('live', liveCols.has(i)));
    const dots = $('beatDots').children, beat = P.running && cur >= 0 ? Math.floor(cur * 4) % 4 : -1;
    for (let k = 0; k < 4; k++) { dots[k].classList.toggle('on', k === beat); dots[k].classList.toggle('down', k === 0 && beat === 0); }
  },
  async tap(idx) {
    Engine.init();
    if (this.assign) { this.selPad = idx; $('assignTitle').textContent = `Pad ${idx + 1} selected – tap a loop`; this.refresh(true); return; }
    const def = this.loopAt(idx); if (!def) return toast('Empty pad – tap Assign to add a loop');
    const el = this.padEls[idx]; el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 90); haptic();
    const pd = P.pads.get(idx), now = Engine.now();
    if (pd && pd.bank === this.bank) {
      if (pd.stopBar == null) {
        if (now < timeOfBar(pd.startBar)) { P.pads.delete(idx); Engine.stopTag((r) => r.tag && r.tag.pad === idx, now); } // cancel a queued launch
        else { pd.stopBar = Math.max(nextLaunchBar(), pd.startBar + 1); Engine.stopTag((r) => r.tag && r.tag.pad === idx && r.tag.bar >= pd.stopBar, now); }
      } else { // tapped while stopping: keep it playing
        pd.stopBar = null; for (let bb = Math.ceil(barAt(now)); bb < P.nextBar; bb++) if (!this.hasSource(idx, bb)) schedulePadBar(idx, pd, bb);
      }
      this.refresh(true); clockStopIfIdle(); return;
    }
    stopPreview();
    if (!Engine.cachedLoop(def, P.bpm)) { P.loadingPad = idx; startRaf(); this.refresh(true); await Engine.renderLoop(def, P.bpm); P.loadingPad = null; }
    const sb = nextLaunchBar(), t = Engine.now();
    for (const [j, q] of P.pads) if (j % 5 === idx % 5 || q.bank !== this.bank) {
      if (q.startBar >= sb) { P.pads.delete(j); Engine.stopTag((r) => r.tag && r.tag.pad === j, t); }
      else if (q.stopBar == null || q.stopBar > sb) { q.stopBar = sb; Engine.stopTag((r) => r.tag && r.tag.pad === j && r.tag.bar >= sb, t); }
    }
    const npd = { def, startBar: sb, stopBar: null, bank: this.bank }; P.pads.set(idx, npd);
    for (let bb = sb; bb < P.nextBar; bb++) schedulePadBar(idx, npd, bb);
    pTick(); startRaf(); this.refresh(true);
  },
  hasSource(idx, bar) { for (const r of Engine.active) if (r.tag && r.tag.pad === idx && r.tag.bar === bar && !r.released) return true; return false; },
  stopCol(col) { if (!P.running) return; const sb = nextLaunchBar(), t = Engine.now();
    for (const [j, q] of P.pads) if (j % 5 === col) { if (q.startBar >= sb) { P.pads.delete(j); Engine.stopTag((r) => r.tag && r.tag.pad === j, t); } else { q.stopBar = sb; Engine.stopTag((r) => r.tag && r.tag.pad === j && r.tag.bar >= sb, t); } }
    this.refresh(true); },
  assignLoop(id) { if (this.selPad == null) return preview(id); this.assignTo(this.selPad, id); },
  assignTo(idx, id) {
    const def = getLoop(id); if (!def) return;
    (this.custom[this.bank] = this.custom[this.bank] || {})[idx] = id; store.set('stella4-pads', this.custom);
    if (P.pads.has(idx)) { P.pads.delete(idx); Engine.stopTag((r) => r.tag && r.tag.pad === idx, Engine.now()); }
    stopPreview(); Engine.renderLoop(def, P.bpm); this.render(); toast(`${def.name} → pad ${idx + 1}`);
  },
  clearPad() { if (this.selPad == null) return toast('Select a pad first'); (this.custom[this.bank] = this.custom[this.bank] || {})[this.selPad] = null; store.set('stella4-pads', this.custom); P.pads.delete(this.selPad); this.render(); },
  setBank(b) {
    if (b === this.bank || !PRESETS.GENRES[b]) return;
    if (P.running) { const sb = nextLaunchBar(), t = Engine.now(); for (const [j, q] of P.pads) { q.stopBar = Math.max(sb, q.startBar); Engine.stopTag((r) => r.tag && r.tag.pad === j && r.tag.bar >= q.stopBar, t); } }
    this.bank = b; store.set('stella4-bank', b); $('bankSel').value = b; this.selPad = null;
    const g = PRESETS.GENRES[b]; if (!P.songOn && !P.pads.size && !song.clips.length) setProduceBpm(g.bpm);
    this.render(); this.prewarm();
  },
  prewarm() { if (!Engine.ctx) return; const defs = []; for (let i = 0; i < 20; i++) { const d = this.loopAt(i); if (d) defs.push(d); }
    const bpm = P.bpm, bank = this.bank; (async () => { for (const d of defs) { if (!this.open || P.bpm !== bpm || this.bank !== bank) return; await Engine.renderLoop(d, bpm); } })(); },
  show() { Engine.init(); this.open = true; $('djView').hidden = false; stopPreview(); this.render(); this.prewarm(); startRaf();
    const d = document.documentElement; if (coarse.matches && d.requestFullscreen && !document.fullscreenElement) d.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); },
  hide() { if (!this.open) return; this.open = false; $('djView').hidden = true; this.setAssign(false); if (document.fullscreenElement && !document.body.classList.contains('fs')) document.exitFullscreen().catch(() => {}); },
  setAssign(on) { this.assign = on; this.selPad = null; $('djAssign').classList.toggle('on', on); $('djDrawer').hidden = !on; $('assignTitle').textContent = 'Pick a pad, then a loop'; if (!on) stopPreview(); this.refresh(true); },
};
function setupDJ() {
  Object.entries(PRESETS.GENRES).forEach(([k, g]) => $('bankSel').add(new Option(g.name, k)));
  if (!PRESETS.GENRES[DJ.bank]) DJ.bank = 'house'; $('bankSel').value = DJ.bank;
  $('bankSel').onchange = (e) => DJ.setBank(e.target.value);
  $('djBtn').onclick = () => DJ.show(); $('djClose').onclick = () => DJ.hide();
  $('djStopAll').onclick = stopAll; $('djAssign').onclick = () => DJ.setAssign(!DJ.assign);
  holdRepeat($('djBpmDn'), () => setProduceBpm(song.bpm - 1)); holdRepeat($('djBpmUp'), () => setProduceBpm(song.bpm + 1));
  $('djGrid').addEventListener('pointerdown', (e) => { const p = e.target.closest('.djpad'); if (!p || e.button > 0) return; e.preventDefault(); DJ.tap(+p.dataset.i); });
  $('djGrid').addEventListener('contextmenu', (e) => e.preventDefault());
  $('djCols').addEventListener('click', (e) => { const c = e.target.closest('.dj-col'); if (c) DJ.stopCol(+c.dataset.col); });
  $('bankReset').onclick = () => { delete DJ.custom[DJ.bank]; store.set('stella4-pads', DJ.custom); DJ.render(); toast('Bank reset to presets'); };
  $('padClear').onclick = () => DJ.clearPad();
  new Library($('djLibList'), $('djCatSeg'), $('djGenreSel'), { genre: 'all', onTap: (id) => DJ.assignLoop(id) });
}

/* =====================================================================
 * Shared: tabs, keyboard, animation loop, lifecycle
 * ===================================================================== */
let tab = 'create';
function switchTab(t) {
  if (t === tab) return;
  // Leaving Create ends its loop (it needs the pads); Produce keeps playing in the background so you can jam over it.
  if (tab === 'create') { const was = C.recording ? 'Recording stopped' : C.playing ? 'Create loop stopped' : ''; cStop(); if (was) toast(was); if (document.body.classList.contains('fs')) setFullscreen(false); }
  if (tab === 'produce') { stopPreview(); DJ.hide(); }
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('.area').forEach((a) => a.classList.toggle('on', a.id === t));
  if (t === 'produce') { showHint('produce'); renderArranger(); updateProduceUI(); } else { showHint('create'); layoutPads(true); }
}
function showHint(area) { const el = $(area + 'Hint'); if (!store.get('stella4-hint-' + area, false)) el.hidden = false; }
document.querySelectorAll('.hint-x').forEach((x) => x.onclick = () => { const h = x.closest('.hint'); h.hidden = true; store.set('stella4-hint-' + h.id.replace('Hint', ''), true); });

/* One requestAnimationFrame loop, only while something is moving and the page is visible. */
let rafId = 0;
function startRaf() { if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame); }
function frame() {
  rafId = 0; if (document.hidden) return;
  createFrame(); produceFrame(); DJ.refresh(false);
  if (C.playing || P.running || P.preview || P.loadingPad != null) rafId = requestAnimationFrame(frame);
  else { updateCreateUI(); updateProduceUI(); DJ.refresh(true); }
}

const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
window.addEventListener('keydown', (e) => {
  if (!$('modal').hidden) { if (e.key === 'Escape' && modalResolve) modalResolve(null); return; }
  if (typing(e) || e.altKey || ((e.ctrlKey || e.metaKey) && !['z', 'd'].includes(e.key.toLowerCase()))) return;
  const k = e.key.toLowerCase();
  if (DJ.open) {
    if (e.key === 'Escape') return DJ.hide();
    if (e.key === ' ') { e.preventDefault(); return stopAll(); }
    if (e.repeat) return; for (let r = 0; r < 4; r++) { const c = PADKEYS[r].indexOf(k); if (c >= 0) { e.preventDefault(); return DJ.tap(r * 5 + c); } }
    return;
  }
  if (tab === 'create') {
    if (e.key === ' ') { e.preventDefault(); if (!e.repeat) (C.playing ? cStop() : cStart(false)); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) toggleRec(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('octDn').click(); return; } if (e.key === 'ArrowRight') { e.preventDefault(); $('octUp').click(); return; }
    if (e.key === 'Escape' && document.body.classList.contains('fs')) return setFullscreen(false);
    if (e.repeat || e.ctrlKey || e.metaKey) return; const i = C.keyMap && C.keyMap[k]; if (i != null) { e.preventDefault(); padDown(i, 'k' + k); }
    return;
  }
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat) songPlay(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return undo(); }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); return duplicateClip(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return deleteClip(); }
  if (k === 'd' && !e.ctrlKey && !e.metaKey && !e.repeat) { e.preventDefault(); return DJ.show(); }
  if (e.key === 'Escape') selectClip(null);
});
window.addEventListener('keyup', (e) => padUp('k' + e.key.toLowerCase()));
window.addEventListener('blur', releaseAllHeld);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseAllHeld(); if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (Engine.ctx && !C.playing && !P.running && !P.preview) Engine.ctx.suspend().catch(() => {}); }
  else { if (Engine.ctx && Engine.ctx.state === 'suspended') Engine.ctx.resume().catch(() => {}); startRaf(); }
});
// Unlock audio on the first gesture (autoplay policy), then pre-generate the visible pads.
const unlock = () => { Engine.init(); prewarmPads(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);

$('helpBtn').onclick = () => modal({ title: 'Stella Sound v' + APP_VERSION, body: `
  <p><b>Create</b> – pick an instrument and tap the pads (lowest note bottom-left, always in key). Press <b>Rec</b>: after a 1-bar count-in everything you play loops. Each pass is a take; <b>Undo</b> removes the last one. <b>Save as Loop</b> sends it to Produce.</p>
  <p><b>Produce</b> – tap a loop to hear it, drag it onto a track (or tap +), then press <b>Play</b>. Drag clips to move them, drag the right edge to resize. <b>Song</b> saves, opens and exports WAV.</p>
  <p><b>DJ Pads</b> – a pad starts on the next bar; tap it again to stop. One loop plays per column. <b>Assign</b> puts any loop, including yours, on a pad.</p>
  <p>Produce keeps playing when you switch to Create, so you can jam over your song. Your work is saved on this device; use <b>Song → Back up everything</b> to keep a copy.</p>
  <p style="color:var(--muted)">Keys – Create: pads on Z–M, A–K, Q–I, 1–8 · Space play/stop · Enter record · ←/→ octave. Produce: Space play/stop · Ctrl+Z undo · Ctrl+D duplicate · Del delete clip · D DJ pads. DJ: pads on 1–5, Q–T, A–G, Z–B · Space stop all · Esc close.</p>`, actions: [{ label: 'Got it', value: true, cls: 'primary' }] });

async function init() {
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
  setupCreate();
  new Library($('libList'), $('catSeg'), $('genreSel'), { onTap: preview, onAdd: quickAdd });
  setupArranger(); setupDJ(); renderArranger(); updateProduceUI(); showHint('create');
  try { (await DB.all('loops')).forEach((l) => userLoops.set(l.id, l)); } catch (_) {}
  Libs.forEach((l) => l.render()); renderArranger();
  v5Setup();
  window.__stella = { Engine, Sched, C, P, DJ, get song() { return song; }, getLoop, userLoops, renderArranger, addClip, songPlay, songStop, stopAll, cStart, cStop, toggleRec, switchTab, layoutPads, Arr, quickAdd, preview, loadSong, undo };
}
init();

/* =====================================================================
 * v5 · release polish: updates, audio lifecycle (iOS), wake lock,
 * storage persistence, backups, first-run demo, error safety net.
 * ===================================================================== */
const APP_VERSION = '1.0.0';

/* ---- storage: ask the browser to keep our data, explain quota problems ---- */
let persistAsked = false;
function askPersist() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return; persistAsked = true;
  navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
}
function storageError(e) {
  const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
  toast(quota ? 'Storage is full – delete some songs or loops, or use Song → Back up' : 'Could not save on this device (private mode?)', 4200);
}

/* ---- backup / restore: one JSON file with songs, my loops and pad setup ---- */
async function exportBackup() {
  try {
    const data = { app: 'stella-sound', version: APP_VERSION, created: new Date().toISOString(),
      songs: await DB.all('songs').catch(() => []), loops: [...userLoops.values()], current: song,
      pads: store.get('stella4-pads', {}), create: store.get('stella4-create', null) };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); window.__lastBackup = data;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `stella-sound-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 15000);
    toast(`Backup saved (${data.songs.length} songs, ${data.loops.length} loops)`);
  } catch (e) { console.warn(e); toast('Backup failed'); }
}
function importBackup() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => { const f = inp.files && inp.files[0]; if (f) await restoreBackup(await f.text()); };
  inp.click();
}
async function restoreBackup(text) {
  let d; try { d = JSON.parse(text); } catch (_) { return toast('That file is not a Stella Sound backup'); }
  if (!d || d.app !== 'stella-sound' || !Array.isArray(d.songs) || !Array.isArray(d.loops)) return toast('That file is not a Stella Sound backup');
  if (!(await confirmBox('Restore backup?', `Adds ${d.songs.length} songs and ${d.loops.length} loops from ${(d.created || '').slice(0, 10)}. Items with the same name/ID are replaced.`, 'Restore'))) return;
  try {
    for (const l of d.loops) if (l && l.id && Array.isArray(l.events)) { l.user = true; await DB.put('loops', l); userLoops.set(l.id, l); }
    for (const s of d.songs) if (s && s.id && Array.isArray(s.clips)) await DB.put('songs', s);
    if (d.pads && typeof d.pads === 'object') { store.set('stella4-pads', d.pads); DJ.custom = d.pads; }
    askPersist(); Libs.forEach((l) => l.render()); DJ.render();
    if (d.current && Array.isArray(d.current.clips)) loadSong(d.current);
    toast('Backup restored');
  } catch (e) { storageError(e); }
}

/* ---- audio lifecycle: iOS unlock, resume after interruptions, wake lock ---- */
let iosUnlocked = false;
function resumeAudio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (_) {} // iOS: play even with the Silent switch on
  const c = Engine.init(); if (!c) return;
  if (c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => {});
  if (!iosUnlocked) { iosUnlocked = true; try { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch (_) {} }
}
['pointerdown', 'touchend', 'keydown'].forEach((ev) => window.addEventListener(ev, resumeAudio, { capture: true, passive: true }));
let wakeLock = null, wakeBusy = false;
async function syncWake() {
  const busy = C.playing || P.running;
  if (!('wakeLock' in navigator) || wakeBusy) return;
  if (busy && !wakeLock && !document.hidden) { wakeBusy = true; try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (_) { wakeLock = null; } wakeBusy = false; }
  else if (!busy && wakeLock) { const w = wakeLock; wakeLock = null; w.release().catch(() => {}); }
}
/** Small, cheap state sync: live dot on the Produce tab + wake lock. */
function syncLive() {
  const live = P.running; const tb = document.querySelector('.tabs [data-tab=produce]');
  if (tb && tb.classList.contains('live') !== live) { tb.classList.toggle('live', live); tb.setAttribute('aria-label', live ? 'Produce (playing)' : 'Produce'); }
  syncWake();
}
setInterval(syncLive, 700);

/* ---- updates: new service worker → offer a reload ---- */
function showUpdateBar() {
  if ($('updateBar')) return;
  const bar = document.createElement('div'); bar.id = 'updateBar'; bar.className = 'update-bar'; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>New version available</span><button class="chip primary sm" id="updReload">Reload</button><button class="icon-btn sm" id="updX" aria-label="Later"><svg><use href="#i-close"/></svg></button>';
  document.body.appendChild(bar); $('updReload').onclick = () => location.reload(); $('updX').onclick = () => bar.remove();
}
function registerSW() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBar(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

/* ---- safety net: never leave the user with a silent, broken screen ---- */
let lastErrToast = 0;
function softError(msg) { console.warn('[Stella Sound]', msg); const n = Date.now(); if (n - lastErrToast > 8000) { lastErrToast = n; toast('Something went wrong – your work is saved. If sound stops, tap Stop and Play.', 4000); } }
window.addEventListener('error', (e) => softError(e.message));
window.addEventListener('unhandledrejection', (e) => softError(e.reason && e.reason.message || String(e.reason)));

function v5Setup() {
  $('appVer').textContent = 'v' + APP_VERSION;
  const c = Engine.ctx; // audio context state changes (iOS "interrupted", phone calls…)
  const hook = () => { const ctx = Engine.ctx; if (!ctx || ctx.__hooked) return; ctx.__hooked = true;
    ctx.addEventListener('statechange', () => { if (ctx.state !== 'running' && !document.hidden && (C.playing || P.running)) { ctx.resume().catch(() => {}); toast('Audio was interrupted – tap anywhere to resume', 3000); } }); };
  window.addEventListener('pointerdown', hook, { capture: true, passive: true }); window.addEventListener('keydown', hook, { capture: true }); if (c) hook();
  // First run: a ready-made demo song so Produce isn't empty.
  if (!store.get('stella5-demo', false)) { store.set('stella5-demo', true); if (!song.clips.length) { applyTemplate('lofi', 'Demo – Lo-Fi Song'); saveSong(); } }
  registerSW();
}

/* ---- tall screens (tablets in portrait, big monitors): grow the 6 tracks to fill the arranger ---- */
function fitLanes() {
  const body = document.querySelector('.arr-body'); if (!body || !body.clientHeight) return;
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--laneh')) || 54;
  const ruler = (document.querySelector('.ruler') || {}).offsetHeight || 26;
  const fit = Math.round(clamp(Math.floor((body.clientHeight - ruler - 12) / LANES), base, base * 3.5));
  if (Math.abs((parseFloat(body.style.getPropertyValue('--laneh-fit')) || 0) - fit) >= 2) body.style.setProperty('--laneh-fit', fit + 'px');
}
if (window.ResizeObserver) new ResizeObserver(() => fitLanes()).observe(document.querySelector('.arr-body'));
