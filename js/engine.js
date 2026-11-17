/* =====================================================================
 * Stella Sound v4 · engine.js
 * Audio engine built to stay stable on phones for hours:
 *  - ONE AudioContext, ONE shared reverb (convolver) and ONE master chain.
 *  - Every sound is a pre-rendered AudioBuffer played by a single
 *    BufferSource + Gain pair. Every source disconnects itself on 'ended'
 *    and is tracked in `active`, so the live node count is always bounded.
 *  - Live instrument voices are capped (MAX_VOICES) with oldest-voice stealing.
 *  - Note samples and rendered loops live in byte-budgeted LRU caches.
 *  - ONE shared timer (Sched) drives every look-ahead scheduler; it only
 *    runs while something is playing.
 * ===================================================================== */
'use strict';
const INSTRUMENTS = [
  { id: 'piano', name: 'Grand Piano', fam: 'Keys', oct: 4, rel: 0.35, send: 0.2 },
  { id: 'epiano', name: 'Electric Piano', fam: 'Keys', oct: 4, rel: 0.35, send: 0.22 },
  { id: 'guitar', name: 'Acoustic Guitar', fam: 'Strings', oct: 3, rel: 0.3, send: 0.2 },
  { id: 'strings', name: 'String Ensemble', fam: 'Strings', oct: 4, rel: 0.55, send: 0.35 },
  { id: 'ebass', name: 'Electric Bass', fam: 'Bass', oct: 2, rel: 0.12, send: 0.05 },
  { id: 'synthbass', name: 'Synth Bass', fam: 'Bass', oct: 2, rel: 0.1, send: 0.05 },
  { id: 'bass808', name: '808 Bass', fam: 'Bass', oct: 1, rel: 0.25, send: 0.03 },
  { id: 'brass', name: 'Brass Section', fam: 'Winds', oct: 4, rel: 0.18, send: 0.25 },
  { id: 'flute', name: 'Flute', fam: 'Winds', oct: 5, rel: 0.15, send: 0.3 },
  { id: 'sax', name: 'Saxophone', fam: 'Winds', oct: 4, rel: 0.15, send: 0.25 },
  { id: 'lead', name: 'Synth Lead', fam: 'Synths', oct: 4, rel: 0.2, send: 0.28 },
  { id: 'pad', name: 'Synth Pad', fam: 'Synths', oct: 4, rel: 1.0, send: 0.45 },
  { id: 'marimba', name: 'Marimba', fam: 'Mallets', oct: 4, rel: 0.3, send: 0.22 },
  { id: 'bells', name: 'Bells', fam: 'Mallets', oct: 5, rel: 1.2, send: 0.35 },
];
const KIT_LIST = [
  { id: 'acoustic', name: 'Acoustic Kit' }, { id: 'boombap', name: 'Boom-Bap Kit' },
  { id: 'trap', name: 'Trap 808 Kit' }, { id: 'house', name: 'House Kit' },
];
const INST_BY_ID = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i]));

/** Byte-budgeted least-recently-used cache. */
class LRU {
  constructor(budgetBytes) { this.m = new Map(); this.bytes = 0; this.budget = budgetBytes; }
  get(k) { const e = this.m.get(k); if (!e) return undefined; this.m.delete(k); this.m.set(k, e); return e.v; }
  has(k) { return this.m.has(k); }
  set(k, v, bytes) {
    if (this.m.has(k)) this.delete(k);
    this.m.set(k, { v, bytes }); this.bytes += bytes;
    for (const [key, e] of this.m) { if (this.bytes <= this.budget || this.m.size <= 1) break; this.m.delete(key); this.bytes -= e.bytes; }
  }
  delete(k) { const e = this.m.get(k); if (e) { this.bytes -= e.bytes; this.m.delete(k); } }
  clear() { this.m.clear(); this.bytes = 0; }
}

/** Single shared timer for every scheduler (no stacked setIntervals). */
const Sched = {
  fns: new Set(), id: null,
  add(fn) { this.fns.add(fn); if (!this.id) this.id = setInterval(() => this.fns.forEach((f) => { try { f(); } catch (e) { console.error(e); } }), 25); },
  remove(fn) { this.fns.delete(fn); if (!this.fns.size && this.id) { clearInterval(this.id); this.id = null; } },
};

/** Yield to the browser between heavy render steps (keeps the UI responsive). */
const yieldNow = (() => { const ch = new MessageChannel(), q = []; ch.port1.onmessage = () => { const r = q.shift(); r && r(); };
  return () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); }); })();

const Engine = (() => {
  const MAX_VOICES = 32;
  let ctx = null, sr = 48000, chain = null, irData = null;
  const active = new Set();          // every playing/scheduled source record
  const voices = [];                 // live instrument voices (subset of active)
  const notes = new LRU(40 * 1024 * 1024);   // per-note / per-drum samples for live playing (Create, metronome)
  const raw = new LRU(24 * 1024 * 1024);     // raw sample data used only while rendering loops (keeps Create's cache warm)
  const loops = new LRU(72 * 1024 * 1024);   // rendered loops (per tempo)
  const pending = new Map();         // in-flight loop renders (dedupe)
  const SENDS = { Drums: 0.07, Bass: 0.02, Chords: 0.28, Melody: 0.25, FX: 0.3, create: 0.2, click: 0 };
  const TARGET = { Drums: 0.17, Bass: 0.15, Chords: 0.11, Melody: 0.1, FX: 0.08 };

  /** Master chain used by both the live context and the WAV export context. */
  function buildChain(c) {
    const input = c.createGain(), comp = c.createDynamicsCompressor(), lim = c.createDynamicsCompressor(), out = c.createGain();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.knee.value = 10; comp.attack.value = 0.01; comp.release.value = 0.25;
    lim.threshold.value = -2; lim.ratio.value = 20; lim.knee.value = 0; lim.attack.value = 0.002; lim.release.value = 0.1;
    out.gain.value = 0.9;
    const conv = c.createConvolver(), wet = c.createGain(); wet.gain.value = 1;
    if (!irData || irData.sr !== c.sampleRate) { const [L, R] = DSP.impulse(c.sampleRate, 2.4); irData = { sr: c.sampleRate, L, R }; }
    const ir = c.createBuffer(2, irData.L.length, c.sampleRate); ir.copyToChannel(irData.L, 0); ir.copyToChannel(irData.R, 1);
    conv.normalize = false; conv.buffer = ir;
    input.connect(comp); conv.connect(wet); wet.connect(comp); comp.connect(lim); lim.connect(out); out.connect(c.destination);
    const buses = {};
    for (const [name, amt] of Object.entries(SENDS)) {
      const g = c.createGain(), s = c.createGain(); s.gain.value = amt; g.connect(input); g.connect(s); s.connect(conv); g.send = s; buses[name] = g;
    }
    buses.create.gain.value = 0.55; buses.click.gain.value = 0.7;
    return { input, out, buses, comp, lim };
  }

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    sr = Math.min(48000, ctx.sampleRate);
    chain = buildChain(ctx);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  const now = () => (ctx ? ctx.currentTime : 0);
  function toBuffer(data, rate = sr) { const b = ctx.createBuffer(1, data.length, rate); b.copyToChannel(data, 0); return b; }

  /* ---------- sample sources (generated once, cached) ---------- */
  function noteBuf(inst, midi) {
    const k = inst + ':' + midi; let b = notes.get(k); if (b) return b;
    const gen = DSP.INST[inst] || DSP.INST.piano; b = toBuffer(gen(DSP.mtof(midi), sr)); notes.set(k, b, b.length * 4); return b;
  }
  function drumBuf(kit, piece) {
    const k = 'kit:' + kit + ':' + piece; let b = notes.get(k); if (b) return b;
    const g = (DSP.KITS[kit] || DSP.KITS.acoustic)[piece]; if (!g) return null; b = toBuffer(g(sr)); notes.set(k, b, b.length * 4); return b;
  }
  function fxBuf(id, dur, root) {
    const k = 'fx:' + id + ':' + dur.toFixed(3) + ':' + root; let b = notes.get(k); if (b) return b;
    b = toBuffer(DSP.fx(id, sr, dur, root)); notes.set(k, b, b.length * 4); return b;
  }
  let clicks = null;
  function clickBuf(accent) { if (!clicks) clicks = [toBuffer(DSP.click(sr, false)), toBuffer(DSP.click(sr, true))]; return clicks[accent ? 1 : 0]; }

  /* ---------- playback primitives ---------- */
  /** Start a buffer. Returns a record that cleans itself up on 'ended'. */
  function play(buf, when, { bus = 'create', vel = 1, offset = 0, dur, loop = false, tag } = {}) {
    if (!ctx || !buf) return null;
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.loop = loop; g.gain.value = vel;
    src.connect(g); g.connect(chain.buses[bus] || chain.buses.create);
    const t = Math.max(when, ctx.currentTime);
    if (dur != null) src.start(t, offset, dur); else src.start(t, offset);
    const rec = { src, g, when: t, tag, bus, ended: false };
    src.onended = () => { rec.ended = true; try { src.disconnect(); g.disconnect(); } catch (_) {} active.delete(rec); const i = voices.indexOf(rec); if (i >= 0) voices.splice(i, 1); };
    active.add(rec); return rec;
  }
  /** Smoothly fade a record out and stop it (no clicks). */
  function release(rec, when, rel = 0.03) {
    if (!rec || rec.ended) return;
    const t = Math.max(when ?? ctx.currentTime, ctx.currentTime), p = rec.g.gain;
    if (rec.relAt != null && t >= rec.relAt) return; // already set to release no later than this
    rec.relAt = t; rec.released = true;
    if (t < rec.when) { try { rec.src.stop(rec.when); } catch (_) {} return; } // not started yet: cancel outright
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
    p.setTargetAtTime(0, t, Math.max(0.005, rel / 4));
    try { rec.src.stop(t + rel * 1.6 + 0.03); } catch (_) {}
  }
  /** Live instrument voice with polyphony cap (oldest voice is stolen). */
  function voice(buf, when, vel, bus = 'create') {
    while (voices.length >= MAX_VOICES) { const old = voices.shift(); release(old, ctx.currentTime, 0.02); }
    const r = play(buf, when, { bus, vel }); if (r) voices.push(r); return r;
  }
  function setCreateSend(amount) { if (chain) chain.buses.create.send.gain.setTargetAtTime(amount, ctx.currentTime, 0.05); }
  function stopTag(pred, when, rel = 0.03) { for (const r of [...active]) if (pred(r)) release(r, when, rel); }
  function panic() { for (const r of [...active]) release(r, ctx.currentTime, 0.02); voices.length = 0; }

  /* ---------- loop rendering (events → one mono AudioBuffer, cached per tempo) ---------- */
  function loopKey(def, bpm) { return def.id + '@' + bpm + '#' + (def.rev || 0); }
  function cachedLoop(def, bpm) { return loops.get(loopKey(def, bpm)); }
  function renderLoop(def, bpm) {
    init();
    const key = loopKey(def, bpm), hit = loops.get(key); if (hit) return Promise.resolve(hit);
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      await null; // always settle after pending.set() below (short loops used to finish synchronously and leave a stale entry)
      const spb = 60 / bpm, len = Math.max(1, Math.round(def.bars * 4 * spb * sr)), out = new Float32Array(len);
      const evs = def.events || [];
      for (let ei = 0; ei < evs.length; ei++) {
        const e = evs[ei]; let buf, noteLen = Infinity, rel = 0.05;
        let data;
        if (e.k) data = rawData('kit:' + e.k + ':' + e.p, () => { const g = (DSP.KITS[e.k] || DSP.KITS.acoustic)[e.p]; return g ? g(sr) : null; });
        else if (e.fx) data = rawData('fx:' + e.fx + ':' + (e.d * spb).toFixed(3) + ':' + (e.n || 57), () => DSP.fx(e.fx, sr, e.d * spb, e.n || 57));
        else { data = rawData(e.i + ':' + e.n, () => (DSP.INST[e.i] || DSP.INST.piano)(DSP.mtof(e.n), sr)); noteLen = Math.max(0.03, e.d * spb) * sr; rel = (INST_BY_ID[e.i] || {}).rel || 0.2; }
        if (!data) continue;
        const v = e.v ?? 0.8, relS = rel * sr, k = Math.exp(-1 / relS);
        const maxJ = Math.min(data.length, len, noteLen + relS * 6), fadeAt = maxJ - Math.floor(0.006 * sr);
        let idx = ((Math.round(e.b * spb * sr) % len) + len) % len, env = 1;
        for (let j = 0; j < maxJ; j++) {
          if (j > noteLen) env *= k;
          const f = j > fadeAt ? (maxJ - j) / (maxJ - fadeAt) : 1;
          out[idx] += data[j] * v * env * f; if (++idx >= len) idx = 0;
        }
        if (ei % 6 === 5) await yieldNow();
      }
      // loudness-normalise per category, with a peak ceiling
      let pk = 0, ss = 0; for (let i = 0; i < len; i++) { const a = out[i]; ss += a * a; if (a > pk) pk = a; else if (-a > pk) pk = -a; }
      const rms = Math.sqrt(ss / len) || 1e-9, g = Math.min((TARGET[def.cat] || 0.12) / rms, 0.92 / (pk || 1));
      for (let i = 0; i < len; i++) out[i] *= g;
      const buf = toBuffer(out); loops.set(key, buf, len * 4); pending.delete(key); return buf;
    })();
    p.catch(() => pending.delete(key));
    pending.set(key, p); return p;
  }
  /** Sample data for loop rendering: reuse a live buffer if one exists, otherwise generate into the render-only cache. */
  function rawData(k, gen) {
    const live = notes.m.get(k); if (live) return live.v.getChannelData(0);
    let d = raw.get(k); if (d) return d; d = gen(); if (d) raw.set(k, d, d.length * 4); return d;
  }
  function clearLoopCache(pred) { if (!pred) { loops.clear(); return; } for (const k of [...loops.m.keys()]) if (pred(k)) loops.delete(k); }

  /* ---------- WAV export: offline render of an arrangement ---------- */
  async function exportSong(song, getDef) {
    init();
    const bpm = song.bpm, bar = 4 * 60 / bpm, end = Math.max(1, ...song.clips.map((c) => c.start + c.len));
    const rate = 44100, total = end * bar + 2.5;
    const oc = new OfflineAudioContext(2, Math.ceil(total * rate), rate), ch = buildChain(oc);
    for (const c of song.clips) {
      const def = getDef(c.loop), lane = song.lanes[c.lane]; if (!def || !lane || lane.mute) continue;
      const buf = await renderLoop(def, bpm), s = oc.createBufferSource(), g = oc.createGain();
      s.buffer = buf; s.loop = true; g.gain.value = lane.vol; s.connect(g); g.connect(ch.buses[def.cat] || ch.buses.Chords);
      s.start(0.05 + c.start * bar, 0, c.len * bar);
    }
    const rendered = await oc.startRendering();
    return encodeWav(rendered);
  }
  function encodeWav(buf) {
    const chn = buf.numberOfChannels, len = buf.length, data = new Int16Array(len * chn), cd = [];
    for (let c = 0; c < chn; c++) cd.push(buf.getChannelData(c));
    for (let i = 0, o = 0; i < len; i++) for (let c = 0; c < chn; c++, o++) { const s = Math.max(-1, Math.min(1, cd[c][i])); data[o] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const head = new DataView(new ArrayBuffer(44)), w = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); head.setUint32(4, 36 + data.byteLength, true); w(8, 'WAVE'); w(12, 'fmt '); head.setUint32(16, 16, true);
    head.setUint16(20, 1, true); head.setUint16(22, chn, true); head.setUint32(24, buf.sampleRate, true); head.setUint32(28, buf.sampleRate * chn * 2, true);
    head.setUint16(32, chn * 2, true); head.setUint16(34, 16, true); w(36, 'data'); head.setUint32(40, data.byteLength, true);
    return new Blob([head, data.buffer], { type: 'audio/wav' });
  }

  function stats() { return { active: active.size, voices: voices.length, notesMB: +(notes.bytes / 1048576).toFixed(1), rawMB: +(raw.bytes / 1048576).toFixed(1), loopsMB: +(loops.bytes / 1048576).toFixed(1), loopCount: loops.m.size, ctxState: ctx ? ctx.state : 'none' }; }

  return {
    init, now, get ctx() { return ctx; }, get chain() { return chain; }, get sr() { return sr; },
    noteBuf, drumBuf, clickBuf, play, release, voice, stopTag, panic, setCreateSend,
    renderLoop, cachedLoop, clearLoopCache, exportSong, encodeWav, stats, active,
  };
})();
