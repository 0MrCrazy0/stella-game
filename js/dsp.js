/* =====================================================================
 * Stella Sound v4 · dsp.js
 * Pure-JavaScript sample synthesis. Every instrument note, drum hit and
 * FX sound is rendered ONCE into a mono Float32Array, then cached and
 * played back by a single AudioBufferSourceNode. This replaces v3's
 * "build 5–12 live oscillator/filter nodes per note" approach, which was
 * the main cause of audio-thread overload and browser crashes on phones.
 * ===================================================================== */
'use strict';
const DSP = (() => {
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /** Small deterministic PRNG (xorshift) so renders are repeatable. Returns -1..1 */
  function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2147483648 - 1; };
  }

  /** RBJ biquad filter (lp / hp / bp) processed sample by sample. */
  class Biquad {
    constructor(type, f, q, sr) { this.type = type; this.sr = sr; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
    set(f, q = 0.707) {
      const sr = this.sr; f = clamp(f, 10, sr * 0.45);
      const w = TAU * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
      let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
      if (this.type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
      else if (this.type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
      else { b0 = al; b1 = 0; b2 = -al; }
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    }
    p(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
    }
  }

  /** PolyBLEP correction for band-limited saw / pulse (no harsh aliasing). */
  function blep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }
  class Saw {
    constructor(f, sr, phase = 0) { this.ph = phase; this.inc = f / sr; }
    n(mod = 1) { const dt = this.inc * mod; let v = 2 * this.ph - 1 - blep(this.ph, dt); this.ph += dt; if (this.ph >= 1) this.ph -= 1; return v; }
  }
  class Pulse {
    constructor(f, sr, width = 0.5, phase = 0) { this.ph = phase; this.inc = f / sr; this.w = width; }
    n(mod = 1) {
      const dt = this.inc * mod; let p2 = this.ph + this.w; if (p2 >= 1) p2 -= 1;
      const v = (2 * this.ph - 1 - blep(this.ph, dt)) - (2 * p2 - 1 - blep(p2, dt));
      this.ph += dt; if (this.ph >= 1) this.ph -= 1; return v;
    }
  }

  /** Fade-in/fade-out edges (click-free) and peak-normalise. */
  function finish(out, sr, peak = 0.6, fadeOut = 0.03, fadeIn = 0.0015) {
    const fi = Math.max(1, Math.floor(fadeIn * sr)), fo = Math.max(1, Math.floor(fadeOut * sr)), n = out.length;
    for (let i = 0; i < fi && i < n; i++) out[i] *= i / fi;
    for (let i = 0; i < fo && i < n; i++) out[n - 1 - i] *= i / fo;
    let m = 0; for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > m) m = a; }
    if (m > 1e-6 && peak) { const g = peak / m; for (let i = 0; i < n; i++) out[i] *= g; }
    return out;
  }
  /** Linear attack then hold, with a smooth fade over the last `tail` seconds. */
  function sustainEnv(t, dur, att, tail) {
    let e = t < att ? Math.sin((t / att) * Math.PI / 2) : 1;
    if (t > dur - tail) e *= Math.max(0, (dur - t) / tail);
    return e;
  }

  /* ----------------------------- Instruments ----------------------------- */
  const INST = {};

  /** Grand piano: inharmonic additive partials, two detuned strings per partial,
   *  two-stage decay (fast "prompt" + slow "aftersound") and a felt-hammer thump. */
  INST.piano = (f, sr) => {
    const dur = clamp(5.2 * Math.pow(130 / f, 0.3), 2.2, 6), n = Math.floor(dur * sr), out = new Float32Array(n);
    const B = 0.00025 + f * 0.0000012, K = Math.min(14, Math.floor(sr * 0.42 / f));
    for (let k = 1; k <= K; k++) {
      const fk = f * k * Math.sqrt(1 + B * k * k); if (fk > sr * 0.45) break;
      const amp = Math.pow(k, -1.15) * Math.exp(-(k * f) / 5200) * (k === 1 ? 1 : 0.85);
      const tf = 0.25 * dur / (1 + 0.45 * k), ts = dur * 0.55 / (1 + 0.18 * k);
      for (const det of [-0.00045, 0.00045]) {
        const w = TAU * fk * (1 + det) / sr, c = Math.cos(w), s = Math.sin(w);
        let re = 1, im = 0, ef = 0.62, es = 0.38; const df = Math.exp(-1 / (tf * sr)), ds = Math.exp(-1 / (ts * sr));
        for (let i = 0; i < n; i++) {
          out[i] += amp * (ef + es) * im;
          const r2 = re * c - im * s; im = re * s + im * c; re = r2; ef *= df; es *= ds;
        }
      }
    }
    // hammer thump
    const r = rng(f * 7), lp = new Biquad('lp', Math.min(f * 6, 4000), 0.7, sr), hn = Math.floor(0.012 * sr);
    for (let i = 0; i < hn; i++) out[i] += lp.p(r()) * 0.12 * (1 - i / hn);
    // gentle attack 1.5ms
    return finish(out, sr, 0.62, 0.08, 0.0015);
  };

  /** Electric piano (tine EP): 2-operator FM with decaying index + bell-like tine transient. */
  INST.epiano = (f, sr) => {
    const dur = clamp(3.6 * Math.pow(200 / f, 0.25), 1.6, 4.5), n = Math.floor(dur * sr), out = new Float32Array(n);
    const wc = TAU * f / sr, wt = TAU * f * 14 / sr; const tineAmt = clamp(260 / f, 0.15, 0.8);
    for (let i = 0; i < n; i++) {
      const t = i / sr, idx = 1.9 * Math.exp(-t / 0.22) + 0.35;
      const mod = Math.sin(wc * i) * idx;
      const body = Math.sin(wc * i + mod);
      const tine = Math.sin(wt * i) * 0.12 * tineAmt * Math.exp(-t / 0.04);
      const env = Math.exp(-t / (dur * 0.38)) * (1 + 0.06 * Math.sin(TAU * 4.6 * t));
      out[i] = (body + tine) * env;
    }
    return finish(out, sr, 0.6, 0.06, 0.001);
  };

  /** Karplus–Strong plucked string with all-pass tuning, pluck-position comb and body resonances. */
  function pluck(f, sr, { dur, t60, bright, pos, body, seed }) {
    const n = Math.floor(dur * sr), out = new Float32Array(n);
    const N = sr / f, L = Math.max(2, Math.floor(N - 0.5)), d = N - L - 0.5, C = (1 - d) / (1 + d);
    const buf = new Float32Array(L), r = rng(seed), lp = new Biquad('lp', bright, 0.6, sr);
    const tmp = new Float32Array(L); for (let i = 0; i < L; i++) tmp[i] = lp.p(r());
    const off = Math.max(1, Math.floor(L * pos));
    for (let i = 0; i < L; i++) buf[i] = tmp[i] - (i >= off ? tmp[i - off] : 0) * 0.85;
    const rho = Math.pow(0.001, 1 / (t60 * f));
    let idx = 0, prev = 0, apx = 0, apy = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[idx];
      const avg = (0.5 * (y + prev)) * rho; prev = y;
      const ap = C * avg + apx - C * apy; apx = avg; apy = ap;
      buf[idx] = ap; idx = (idx + 1) % L; out[i] = y;
    }
    if (body) { // wooden body: two soft resonances mixed in
      const b1 = new Biquad('bp', body[0], 2.5, sr), b2 = new Biquad('bp', body[1], 3, sr);
      for (let i = 0; i < n; i++) { const x = out[i]; out[i] = x + b1.p(x) * 0.6 + b2.p(x) * 0.4; }
    }
    return out;
  }
  INST.guitar = (f, sr) => finish(pluck(f, sr, { dur: clamp(3.2 * Math.pow(196 / f, 0.2), 1.6, 3.6), t60: clamp(3.2 * Math.pow(196 / f, 0.5), 0.9, 5), bright: clamp(f * 9, 2500, 9000), pos: 0.18, body: [110, 240], seed: f * 13 }), sr, 0.62, 0.08);

  /** Fingered electric bass: darker KS string + sine fundamental reinforcement. */
  INST.ebass = (f, sr) => {
    const dur = 2.4, out = pluck(f, sr, { dur, t60: 2.6, bright: clamp(f * 14, 900, 2400), pos: 0.12, body: null, seed: f * 31 });
    const lp = new Biquad('lp', 2200, 0.7, sr), w = TAU * f / sr;
    for (let i = 0; i < out.length; i++) { const t = i / sr; out[i] = lp.p(out[i]) + Math.sin(w * i) * 0.45 * Math.exp(-t / 1.1) * Math.min(1, t / 0.004); }
    return finish(out, sr, 0.65, 0.08);
  };

  /** Analog-style synth bass: saw + sub square through an enveloped resonant low-pass. */
  INST.synthbass = (f, sr) => {
    const dur = 1.6, n = Math.floor(dur * sr), out = new Float32Array(n);
    const s1 = new Saw(f, sr), s2 = new Saw(f * 1.004, sr, 0.3), sub = new Pulse(f / 2, sr, 0.5), lp = new Biquad('lp', f * 10, 3.2, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr; if ((i & 15) === 0) lp.set(f * 1.6 + f * 10 * Math.exp(-t / 0.11) + 60, 3.2);
      const x = s1.n() * 0.5 + s2.n() * 0.35 + sub.n() * 0.45;
      out[i] = lp.p(x) * (0.75 + 0.25 * Math.exp(-t / 0.15)) * Math.min(1, t / 0.003);
    }
    for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.4);
    return finish(out, sr, 0.62, 0.1);
  };

  /** 808 sub bass: sine with a fast pitch drop, saturation for audibility on small speakers. */
  INST.bass808 = (f, sr) => {
    const dur = 2.6, n = Math.floor(dur * sr), out = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, fr = f * (1 + 1.2 * Math.exp(-t / 0.018)); ph += TAU * fr / sr;
      const x = Math.sin(ph); out[i] = Math.tanh(2.2 * x) / Math.tanh(2.2) * Math.exp(-t / 1.3) * Math.min(1, t / 0.002);
    }
    return finish(out, sr, 0.7, 0.15);
  };

  /** Ensemble strings: 6 detuned band-limited saws, delayed vibrato, bowed attack, warm low-pass. */
  INST.strings = (f, sr) => {
    const dur = 4.5, n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(f * 3);
    const osc = [-11, -6, -2, 2, 6, 11].map((c) => new Saw(f * Math.pow(2, c / 1200), sr, (r() + 1) / 2));
    const lp1 = new Biquad('lp', Math.min(f * 5, 6500), 0.6, sr), lp2 = new Biquad('lp', Math.min(f * 7, 9000), 0.6, sr), hp = new Biquad('hp', 90, 0.7, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr, vib = 1 + 0.0032 * Math.sin(TAU * 5.3 * t) * Math.min(1, Math.max(0, (t - 0.25) / 0.5));
      let x = 0; for (const o of osc) x += o.n(vib);
      out[i] = hp.p(lp2.p(lp1.p(x))) * sustainEnv(t, dur, 0.28, 0.8);
    }
    return finish(out, sr, 0.55, 0.05, 0.002);
  };

  /** Brass section: saws with pitch scoop, opening filter "blat", slight swell. */
  INST.brass = (f, sr) => {
    const dur = 3, n = Math.floor(dur * sr), out = new Float32Array(n);
    const osc = [-6, 0, 6].map((c, k) => new Saw(f * Math.pow(2, c / 1200), sr, k * 0.31)), lp = new Biquad('lp', f * 2, 1.4, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr, scoop = Math.pow(2, (-35 * Math.exp(-t / 0.035)) / 1200), vib = 1 + 0.003 * Math.sin(TAU * 5 * t) * Math.min(1, Math.max(0, t - 0.35) * 2);
      if ((i & 15) === 0) lp.set(Math.min(f * (1.5 + 3.5 * Math.min(1, t / 0.07)) * (0.85 + 0.15 * Math.exp(-t / 0.4)), 7000), 1.4);
      let x = 0; for (const o of osc) x += o.n(scoop * vib);
      out[i] = Math.tanh(lp.p(x) * 0.9) * sustainEnv(t, dur, 0.035, 0.6) * (0.9 + 0.1 * Math.exp(-t / 0.2));
    }
    return finish(out, sr, 0.55, 0.05, 0.002);
  };

  /** Flute: near-sine tone + breath noise + attack chiff + delayed vibrato. */
  INST.flute = (f, sr) => {
    const dur = 3.5, n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(f * 5), bp = new Biquad('bp', f * 2, 2.5, sr), hp = new Biquad('hp', 3000, 0.7, sr); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, vd = Math.min(1, Math.max(0, (t - 0.3) / 0.4)), vib = 1 + 0.004 * Math.sin(TAU * 5 * t) * vd; ph += TAU * f * vib / sr;
      const tone = Math.sin(ph) + 0.22 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph);
      const nz = r(), breath = bp.p(nz) * 0.25 + hp.p(nz) * 0.03, chiff = nz * 0.25 * Math.exp(-t / 0.025);
      out[i] = (tone * (1 + 0.05 * Math.sin(TAU * 5 * t) * vd) + breath + chiff) * sustainEnv(t, dur, 0.07, 0.6);
    }
    return finish(out, sr, 0.5, 0.05, 0.002);
  };

  /** Saxophone: reedy pulse/saw blend through body formants, breathy attack, vibrato. */
  INST.sax = (f, sr) => {
    const dur = 3, n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(f * 9);
    const p = new Pulse(f, sr, 0.38), s = new Saw(f * 1.002, sr, 0.5), f1 = new Biquad('bp', 1150, 1.4, sr), f2 = new Biquad('bp', 2600, 2.5, sr), lp = new Biquad('lp', 1200, 0.8, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr, vd = Math.min(1, Math.max(0, (t - 0.35) / 0.4)), vib = 1 + 0.005 * Math.sin(TAU * 5.4 * t) * vd;
      if ((i & 15) === 0) lp.set(Math.min(800 + f * 6 * Math.min(1, t / 0.06), 6000), 0.8);
      const x = lp.p(p.n(vib) * 0.6 + s.n(vib) * 0.4 + r() * 0.04);
      out[i] = Math.tanh((x + f1.p(x) * 1.2 + f2.p(x) * 0.6) * 1.6) * sustainEnv(t, dur, 0.04, 0.5);
    }
    return finish(out, sr, 0.5, 0.05, 0.002);
  };

  /** Synth lead: 5-voice supersaw + sub square, delayed vibrato. */
  INST.lead = (f, sr) => {
    const dur = 3, n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(f * 11);
    const osc = [-14, -7, 0, 7, 14].map((c) => new Saw(f * Math.pow(2, c / 1200), sr, (r() + 1) / 2)), sub = new Pulse(f / 2, sr, 0.5), lp = new Biquad('lp', Math.min(3200 + f * 2, 9000), 0.9, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr, vib = 1 + 0.005 * Math.sin(TAU * 5.6 * t) * Math.min(1, Math.max(0, (t - 0.3) / 0.4));
      let x = 0; for (const o of osc) x += o.n(vib); x = x * 0.3 + sub.n(vib) * 0.25;
      out[i] = lp.p(x) * sustainEnv(t, dur, 0.01, 0.5);
    }
    return finish(out, sr, 0.5, 0.05, 0.002);
  };

  /** Warm pad: wide detuned saws, slow attack, slowly breathing filter. */
  INST.pad = (f, sr) => {
    const dur = 6, n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(f * 17);
    const osc = [-18, -8, 0, 9, 19].map((c) => new Saw(f * Math.pow(2, c / 1200), sr, (r() + 1) / 2)), lp = new Biquad('lp', 900, 0.9, sr), w = TAU * f / 2 / sr;
    for (let i = 0; i < n; i++) {
      const t = i / sr; if ((i & 31) === 0) lp.set(Math.min(700 + f * 2.2 + 900 * (0.5 - 0.5 * Math.cos(TAU * 0.18 * t)), 6000), 0.9);
      let x = 0; for (const o of osc) x += o.n(); x = x * 0.25 + Math.sin(w * i) * 0.3;
      out[i] = lp.p(x) * sustainEnv(t, dur, 0.7, 1.2);
    }
    return finish(out, sr, 0.5, 0.05, 0.01);
  };

  /** Modal synthesis for struck bars. */
  function modal(f, sr, { dur, ratios, amps, decays, click }) {
    const n = Math.floor(dur * sr), out = new Float32Array(n);
    ratios.forEach((ra, k) => {
      const fk = f * ra; if (fk > sr * 0.45) return;
      const w = TAU * fk / sr, c = Math.cos(w), s = Math.sin(w), dk = Math.exp(-1 / (decays[k] * sr));
      let re = 1, im = 0, e = amps[k];
      for (let i = 0; i < n; i++) { out[i] += e * im; const r2 = re * c - im * s; im = re * s + im * c; re = r2; e *= dk; }
    });
    const r = rng(f * 23), lp = new Biquad('lp', click, 0.7, sr), cn = Math.floor(0.004 * sr);
    for (let i = 0; i < cn; i++) out[i] += lp.p(r()) * 0.3 * (1 - i / cn);
    return out;
  }
  INST.marimba = (f, sr) => { const T = clamp(0.9 * Math.pow(220 / f, 0.5), 0.25, 1.6);
    return finish(modal(f, sr, { dur: Math.min(2, T * 2.2 + 0.2), ratios: [1, 3.99, 9.9], amps: [1, 0.32, 0.1], decays: [T, T / 4, T / 9], click: 3000 }), sr, 0.65, 0.05, 0.0008); };
  INST.bells = (f, sr) => finish(modal(f, sr, { dur: 3.2, ratios: [1, 2.76, 5.4, 8.93, 13.34], amps: [1, 0.55, 0.3, 0.16, 0.08], decays: [2.2, 1.1, 0.55, 0.3, 0.15], click: 7000 }), sr, 0.55, 0.1, 0.0008);

  /* ----------------------------- Drums ----------------------------- */
  function kick(sr, { f0 = 150, f1 = 50, sweep = 0.05, decay = 0.35, click = 0.25, drive = 1.5, len = 0.7, seed = 1 }) {
    const n = Math.floor(len * sr), out = new Float32Array(n), r = rng(seed), lp = new Biquad('lp', 5000, 0.7, sr); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr; ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / sweep)) / sr;
      out[i] = Math.tanh(Math.sin(ph) * drive) * Math.exp(-t / decay) + lp.p(r()) * click * Math.exp(-t / 0.004);
    }
    return finish(out, sr, 0.9, 0.02, 0.0005);
  }
  function snare(sr, { tone = 190, decayT = 0.09, decayN = 0.17, hp = 1600, lpF = 9000, mix = 0.62, len = 0.45, seed = 2, snap = 0.3 }) {
    const n = Math.floor(len * sr), out = new Float32Array(n), r = rng(seed), h = new Biquad('hp', hp, 0.7, sr), l = new Biquad('lp', lpF, 0.7, sr); let p1 = 0, p2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, fr = tone * (1 + 0.5 * Math.exp(-t / 0.01)); p1 += TAU * fr / sr; p2 += TAU * fr * 1.72 / sr;
      const body = (Math.sin(p1) + 0.5 * Math.sin(p2)) * Math.exp(-t / decayT);
      const nz = l.p(h.p(r())) * (Math.exp(-t / decayN) + snap * Math.exp(-t / 0.008));
      out[i] = body * (1 - mix) + nz * mix * 1.6;
    }
    return finish(out, sr, 0.85, 0.02, 0.0005);
  }
  function clap(sr, { seed = 3, decay = 0.16, freq = 1150 }) {
    const n = Math.floor(0.5 * sr), out = new Float32Array(n), r = rng(seed), bp = new Biquad('bp', freq, 1.1, sr), hp = new Biquad('hp', 600, 0.7, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr; let e = 0;
      for (const o of [0, 0.011, 0.022]) if (t >= o && t < o + 0.011) e = Math.max(e, Math.exp(-(t - o) / 0.004));
      if (t >= 0.031) e = Math.max(e, Math.exp(-(t - 0.031) / decay));
      out[i] = hp.p(bp.p(r())) * e;
    }
    return finish(out, sr, 0.8, 0.02, 0.0003);
  }
  /** Metallic hat/cymbal: six inharmonic square waves (classic 808 ratios) + noise. */
  function metal(sr, { decay = 0.05, hp = 7000, len = 0.3, noise = 0.5, base = 1, seed = 4, attack = 0.0005 }) {
    const n = Math.floor(len * sr), out = new Float32Array(n), r = rng(seed), h = new Biquad('hp', hp, 0.8, sr), h2 = new Biquad('hp', hp, 0.8, sr), b = new Biquad('bp', 10000, 0.9, sr);
    const fr = [205.3, 304.4, 369.6, 522.7, 800, 540].map((x) => x * base * 1.7); const ph = fr.map(() => 0);
    for (let i = 0; i < n; i++) {
      const t = i / sr; let x = 0;
      for (let k = 0; k < 6; k++) { ph[k] += fr[k] / sr; if (ph[k] >= 1) ph[k] -= 1; x += ph[k] < 0.5 ? 1 : -1; }
      x = x / 6 * (1 - noise) + r() * noise;
      out[i] = h2.p(h.p(b.p(x) * 0.6 + x * 0.4)) * Math.exp(-t / decay) * Math.min(1, t / attack);
    }
    return finish(out, sr, 0.6, 0.02, 0.0003);
  }
  function tom(sr, { f0 = 160, f1 = 100, decay = 0.3, seed = 5 }) {
    const n = Math.floor((decay * 3 + 0.05) * sr), out = new Float32Array(n), r = rng(seed), lp = new Biquad('lp', 3000, 0.7, sr); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr; ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / 0.06)) / sr;
      out[i] = Math.sin(ph) * Math.exp(-t / decay) + lp.p(r()) * 0.25 * Math.exp(-t / 0.01); }
    return finish(out, sr, 0.8, 0.02, 0.0005);
  }
  function tonal(sr, { freqs, decay, type = 'sine', len, bpF, seed = 6, noise = 0 }) {
    const n = Math.floor(len * sr), out = new Float32Array(n), r = rng(seed), bp = bpF ? new Biquad('bp', bpF, 1.5, sr) : null; const ph = freqs.map(() => 0);
    for (let i = 0; i < n; i++) { const t = i / sr; let x = 0;
      freqs.forEach((f, k) => { ph[k] += f / sr; if (ph[k] >= 1) ph[k] -= 1; x += type === 'square' ? (ph[k] < 0.5 ? 1 : -1) : Math.sin(TAU * ph[k]); });
      x = x / freqs.length + r() * noise; if (bp) x = bp.p(x) * 2; out[i] = x * Math.exp(-t / decay); }
    return finish(out, sr, 0.6, 0.01, 0.0005);
  }
  function shaker(sr, { seed = 7, decay = 0.06, len = 0.2 }) {
    const n = Math.floor(len * sr), out = new Float32Array(n), r = rng(seed), hp = new Biquad('hp', 5500, 0.8, sr);
    for (let i = 0; i < n; i++) { const t = i / sr; out[i] = hp.p(r()) * Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.012) / decay); }
    return finish(out, sr, 0.45, 0.01, 0.001);
  }
  function rim(sr) { const o = tonal(sr, { freqs: [1700, 2400], decay: 0.012, type: 'square', len: 0.08, bpF: 2200, noise: 0.3 }); return finish(o, sr, 0.6, 0.005); }

  /** Kit definitions: piece id → generator. Each kit = 12 pads. */
  const KITS = {
    acoustic: { kick: (s) => kick(s, { f0: 120, f1: 55, sweep: 0.03, decay: 0.28, click: 0.35, drive: 1.2, len: 0.6 }),
      snare: (s) => snare(s, { tone: 185, decayN: 0.2, hp: 1400 }), rim: rim, clap: (s) => clap(s, {}),
      hat: (s) => metal(s, { decay: 0.045, hp: 7500, len: 0.15, noise: 0.55 }), ohat: (s) => metal(s, { decay: 0.32, hp: 7000, len: 0.8, noise: 0.55 }),
      tom1: (s) => tom(s, { f0: 260, f1: 180, decay: 0.22 }), tom2: (s) => tom(s, { f0: 190, f1: 130, decay: 0.26 }), tom3: (s) => tom(s, { f0: 140, f1: 90, decay: 0.32 }),
      crash: (s) => metal(s, { decay: 1.0, hp: 4500, len: 2.6, noise: 0.7, base: 0.8, attack: 0.002 }), ride: (s) => metal(s, { decay: 0.7, hp: 6000, len: 1.6, noise: 0.3, base: 1.3 }),
      shaker: (s) => shaker(s, {}) },
    boombap: { kick: (s) => kick(s, { f0: 110, f1: 48, sweep: 0.04, decay: 0.32, click: 0.2, drive: 2.2, len: 0.6, seed: 11 }),
      snare: (s) => snare(s, { tone: 210, decayN: 0.16, hp: 1100, lpF: 6000, mix: 0.7, seed: 12, snap: 0.5 }), rim: rim, clap: (s) => clap(s, { decay: 0.12, freq: 1000, seed: 13 }),
      hat: (s) => metal(s, { decay: 0.035, hp: 6500, len: 0.12, noise: 0.7, seed: 14 }), ohat: (s) => metal(s, { decay: 0.22, hp: 6500, len: 0.6, noise: 0.7, seed: 15 }),
      tom1: (s) => tom(s, { f0: 240, f1: 170, decay: 0.2 }), tom2: (s) => tom(s, { f0: 170, f1: 120, decay: 0.25 }), tom3: (s) => tom(s, { f0: 120, f1: 80, decay: 0.3 }),
      crash: (s) => metal(s, { decay: 0.9, hp: 5000, len: 2.2, noise: 0.75, base: 0.8, attack: 0.002 }), ride: (s) => metal(s, { decay: 0.6, hp: 6000, len: 1.4, noise: 0.3, base: 1.3 }),
      shaker: (s) => shaker(s, { decay: 0.05 }) },
    trap: { kick: (s) => kick(s, { f0: 170, f1: 46, sweep: 0.035, decay: 0.75, click: 0.15, drive: 1.8, len: 1.4, seed: 21 }),
      snare: (s) => snare(s, { tone: 240, decayN: 0.13, hp: 2200, mix: 0.72, seed: 22, snap: 0.6 }), rim: rim, clap: (s) => clap(s, { decay: 0.18, freq: 1300, seed: 23 }),
      hat: (s) => metal(s, { decay: 0.03, hp: 8500, len: 0.1, noise: 0.4, seed: 24 }), ohat: (s) => metal(s, { decay: 0.18, hp: 8000, len: 0.5, noise: 0.4, seed: 25 }),
      tom1: (s) => tom(s, { f0: 300, f1: 200, decay: 0.18 }), tom2: (s) => tom(s, { f0: 210, f1: 150, decay: 0.22 }), tom3: (s) => tom(s, { f0: 150, f1: 100, decay: 0.3 }),
      crash: (s) => metal(s, { decay: 0.8, hp: 5500, len: 2, noise: 0.6, base: 0.9, attack: 0.002 }), ride: (s) => tonal(s, { freqs: [560, 845], decay: 0.12, type: 'square', len: 0.4, bpF: 900 }),
      shaker: (s) => tonal(s, { freqs: [2600], decay: 0.02, len: 0.08, noise: 0.2 }) },
    house: { kick: (s) => kick(s, { f0: 210, f1: 50, sweep: 0.022, decay: 0.3, click: 0.3, drive: 2, len: 0.55, seed: 31 }),
      snare: (s) => snare(s, { tone: 200, decayN: 0.14, hp: 1800, mix: 0.68, seed: 32 }), rim: rim, clap: (s) => clap(s, { decay: 0.2, freq: 1200, seed: 33 }),
      hat: (s) => metal(s, { decay: 0.04, hp: 8000, len: 0.12, noise: 0.35, seed: 34 }), ohat: (s) => metal(s, { decay: 0.2, hp: 7500, len: 0.5, noise: 0.35, seed: 35 }),
      tom1: (s) => tom(s, { f0: 280, f1: 190, decay: 0.2 }), tom2: (s) => tom(s, { f0: 200, f1: 140, decay: 0.24 }), tom3: (s) => tom(s, { f0: 140, f1: 95, decay: 0.3 }),
      crash: (s) => metal(s, { decay: 0.9, hp: 5000, len: 2.2, noise: 0.6, base: 0.9, attack: 0.002 }), ride: (s) => metal(s, { decay: 0.5, hp: 7000, len: 1.2, noise: 0.25, base: 1.4 }),
      shaker: (s) => shaker(s, { decay: 0.07 }) },
  };
  const PIECES = [
    { id: 'kick', name: 'Kick' }, { id: 'snare', name: 'Snare' }, { id: 'clap', name: 'Clap' }, { id: 'rim', name: 'Rimshot' },
    { id: 'hat', name: 'Closed Hat' }, { id: 'ohat', name: 'Open Hat' }, { id: 'shaker', name: 'Shaker' }, { id: 'ride', name: 'Ride' },
    { id: 'tom3', name: 'Floor Tom' }, { id: 'tom2', name: 'Mid Tom' }, { id: 'tom1', name: 'High Tom' }, { id: 'crash', name: 'Crash' },
  ];

  /* ----------------------------- FX ----------------------------- */
  /** FX one-shots sized to a duration in seconds (used by FX loops). */
  function fx(id, sr, dur, root = 57) {
    dur = clamp(dur, 0.5, 16); const n = Math.floor(dur * sr), out = new Float32Array(n), r = rng(id.length * 77 + root);
    if (id === 'riser' || id === 'downlifter') {
      const bp = new Biquad('bp', 400, 3, sr), up = id === 'riser'; const s = new Saw(mtof(root - 12), sr);
      for (let i = 0; i < n; i++) { const t = i / n, p = up ? t : 1 - t;
        if ((i & 31) === 0) bp.set(250 * Math.pow(40, p), 3);
        const env = up ? Math.pow(t, 2) * (t > 0.97 ? (1 - t) / 0.03 : 1) : Math.pow(1 - t, 1.5);
        out[i] = (bp.p(r()) * 1.2 + s.n(Math.pow(4, p)) * 0.12) * env; }
    } else if (id === 'impact') {
      let ph = 0; const lp = new Biquad('lp', 1800, 0.7, sr), h = new Biquad('hp', 4000, 0.7, sr);
      for (let i = 0; i < n; i++) { const t = i / sr; ph += TAU * (32 + 70 * Math.exp(-t / 0.15)) / sr; const nz = r();
        out[i] = Math.tanh(Math.sin(ph) * 2) * Math.exp(-t / 1.1) + lp.p(nz) * 0.5 * Math.exp(-t / 0.3) + h.p(nz) * 0.25 * Math.exp(-t / 0.9); }
    } else if (id === 'sweep') {
      const hp = new Biquad('bp', 300, 1.2, sr);
      for (let i = 0; i < n; i++) { const t = i / n; if ((i & 31) === 0) hp.set(300 * Math.pow(30, Math.sin(Math.PI * t)), 1.2);
        out[i] = hp.p(r()) * Math.sin(Math.PI * t); }
    } else if (id === 'vinyl') { // loopable crackle + hiss
      const lp = new Biquad('lp', 3500, 0.7, sr), hp = new Biquad('hp', 700, 0.7, sr);
      for (let i = 0; i < n; i++) { let x = hp.p(lp.p(r())) * 0.05; if (r() > 0.9993) x += r() * 0.9; out[i] = x; }
      return finish(out, sr, 0.35, 0.002, 0.002);
    } else if (id === 'revcym') {
      const cy = metal(sr, { decay: 0.9, hp: 5000, len: dur, noise: 0.7, base: 0.8, attack: 0.002 });
      for (let i = 0; i < n; i++) out[i] = cy[n - 1 - i] || 0;
    } else if (id === 'drone') { // evolving tonal bed for ambient
      const osc = [0, 7, 12, 19].map((st, k) => new Saw(mtof(root - 12 + st) * (1 + (k - 1.5) * 0.002), sr, k * 0.2)), lp = new Biquad('lp', 600, 1, sr);
      for (let i = 0; i < n; i++) { const t = i / sr; if ((i & 31) === 0) lp.set(500 + 700 * (0.5 - 0.5 * Math.cos(TAU * t / dur)), 1);
        let x = 0; for (const o of osc) x += o.n(); out[i] = lp.p(x * 0.25) * Math.sin(Math.PI * Math.min(1, i / n)); }
      return finish(out, sr, 0.5, 0.05, 0.05);
    } else if (id === 'noise') { // white-noise build
      const hp = new Biquad('hp', 2000, 0.7, sr);
      for (let i = 0; i < n; i++) { const t = i / n; out[i] = hp.p(r()) * t * (t > 0.97 ? (1 - t) / 0.03 : 1); }
    }
    return finish(out, sr, 0.6, 0.01, 0.002);
  }

  /** Metronome clicks. */
  function click(sr, accent) { const n = Math.floor(0.05 * sr), out = new Float32Array(n), w = TAU * (accent ? 1760 : 1175) / sr;
    for (let i = 0; i < n; i++) out[i] = Math.sin(w * i) * Math.exp(-i / sr / 0.012); return finish(out, sr, accent ? 0.5 : 0.32, 0.005, 0.0005); }

  /** Stereo reverb impulse: diffuse decaying noise with frequency-dependent damping. */
  function impulse(sr, seconds = 2.2) {
    const n = Math.floor(seconds * sr), L = new Float32Array(n), R = new Float32Array(n), rl = rng(101), rr = rng(202);
    let ll = 0, lr = 0; const pre = Math.floor(0.012 * sr);
    for (let i = pre; i < n; i++) { const t = (i - pre) / (n - pre), env = Math.pow(1 - t, 2.2) * Math.exp(-t * 2.5), damp = 0.15 + 0.8 * t;
      ll += (rl() - ll) * (1 - damp); lr += (rr() - lr) * (1 - damp); L[i] = ll * env; R[i] = lr * env; }
    let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    for (let i = 0; i < n; i++) { L[i] /= m * 6; R[i] /= m * 6; }
    return [L, R];
  }

  return { INST, KITS, PIECES, fx, click, impulse, mtof, clamp, rng };
})();
