/* =====================================================================
 * Stella Sound v4 · presets.js
 * Preset loop library: 10 genres × 16 loops (Drums, Bass, Chords, Melody, FX).
 * Loops are stored as tiny musical event lists (positions in BEATS), never
 * as audio, so the library costs almost no memory. Audio is rendered on
 * demand at the current song tempo and cached (see engine.js).
 *
 * Event formats:
 *   note : { b: beat, d: beats, i: instrumentId, n: midi, v: velocity }
 *   drum : { b: beat, k: kitId, p: pieceId, v: velocity }
 *   fx   : { b: beat, d: beats, fx: fxId, n: rootMidi, v }
 * ===================================================================== */
'use strict';
const MUSIC = (() => {
  const SCALES = {
    'Major': [0, 2, 4, 5, 7, 9, 11], 'Minor': [0, 2, 3, 5, 7, 8, 10], 'Dorian': [0, 2, 3, 5, 7, 9, 10],
    'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11], 'Major Pentatonic': [0, 2, 4, 7, 9], 'Minor Pentatonic': [0, 3, 5, 7, 10],
    'Blues': [0, 3, 5, 6, 7, 10], 'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  /** Scale degree (may be negative or > 7) → MIDI note. */
  function deg(root, scale, d) { const s = SCALES[scale], L = s.length, o = Math.floor(d / L); return root + o * 12 + s[((d % L) + L) % L]; }
  return { SCALES, NOTE_NAMES, noteName, deg };
})();

const PRESETS = (() => {
  const { deg } = MUSIC;
  const rng = DSP.rng;
  const CATS = ['Drums', 'Bass', 'Chords', 'Melody', 'FX'];
  const GENRES = {
    hiphop: { name: 'Hip-Hop', bpm: 90 }, house: { name: 'House', bpm: 124 }, trap: { name: 'Trap', bpm: 140 },
    lofi: { name: 'Lo-Fi', bpm: 80 }, pop: { name: 'Pop', bpm: 110 }, techno: { name: 'Techno', bpm: 128 },
    dnb: { name: 'Drum & Bass', bpm: 172 }, afro: { name: 'Afrobeats', bpm: 105 }, rock: { name: 'Rock', bpm: 120 },
    ambient: { name: 'Ambient', bpm: 70 },
  };

  /* ---------- builders ---------- */
  /** Drum pattern strings: x = hit, X = accent, o = ghost, . = rest. */
  function drums(kit, res, bars, map, swing = 0.5, seed = 1) {
    const ev = [], r = rng(seed), stepB = 4 / res, total = res * bars;
    for (const [piece, pat] of Object.entries(map)) {
      for (let s = 0; s < total; s++) {
        const c = pat.length % res === 0 ? pat[s % pat.length] : pat[s]; if (c === '.' || c === undefined) continue;
        const v = (c === 'X' ? 1 : c === 'x' ? 0.86 : 0.5) * (1 + r() * 0.06);
        const sw = (res === 16 && s % 2 === 1) ? (2 * swing - 1) * stepB : 0;
        ev.push({ b: s * stepB + sw, k: kit, p: piece, v: Math.min(1, v) });
      }
    }
    return ev;
  }
  /** Keep chord voicings in a comfortable register around `center`. */
  function voice(notes, center) {
    return notes.map((n) => { while (n < center - 7) n += 12; while (n > center + 9) n -= 12; return n; }).sort((a, b) => a - b);
  }
  function chordNotes(g, d, type = 'triad') {
    if (type === 'power') { const r0 = deg(g.root, g.scale, d); return [r0, r0 + 7, r0 + 12]; }
    const idx = type === '7th' ? [0, 2, 4, 6] : [0, 2, 4];
    return idx.map((k) => deg(g.root, g.scale, d + k));
  }
  /** Chords: one chord per bar, played with the bar rhythm [[step,len],...] (16 steps/bar). */
  function chords(g, inst, rhythm, { type = 'triad', center = 64, strum = 0, vel = 0.7, seed = 3 } = {}) {
    const ev = [], r = rng(seed);
    g.prog.forEach((d, bar) => {
      const ns = voice(chordNotes(g, d, type), center);
      rhythm.forEach(([st, len, accent]) => ns.forEach((n, k) => ev.push({ b: bar * 4 + st / 4 + k * strum, d: len / 4 - k * strum, i: inst, n, v: vel * (accent || 1) * (1 + r() * 0.05) })));
    });
    return ev;
  }
  /** Bass: per-bar rhythm [[step,len,interval]] where interval is semitones above the chord root. */
  /** Keep a note in the song's key: an out-of-scale interval moves one semitone, preferring a chord tone (3rd/5th/7th). */
  function inKey(g, root, n) {
    const pcs = new Set(MUSIC.SCALES[g.scale].map((x) => (g.root + x) % 12)), ok = (m) => pcs.has(((m % 12) + 12) % 12);
    if (ok(n)) return n; const cand = [n + 1, n - 1].filter(ok); if (!cand.length) return n;
    const chordy = (m) => [0, 3, 4, 7, 10, 11].includes((((m - root) % 12) + 12) % 12);
    return cand.find(chordy) ?? cand[0];
  }
  function bass(g, inst, rhythm, { oct = -2, vel = 0.85, seed = 4 } = {}) {
    const ev = [], r = rng(seed);
    g.prog.forEach((d, bar) => {
      let root = deg(g.root, g.scale, d) + oct * 12; while (root > g.root + oct * 12 + 7) root -= 12;
      rhythm.forEach(([st, len, iv = 0]) => ev.push({ b: bar * 4 + st / 4, d: len / 4, i: inst, n: inKey(g, root, root + iv), v: vel * (1 + r() * 0.06) }));
    });
    return ev;
  }
  /** Arpeggio through the chord tones of each bar. */
  function arp(g, inst, order, stepLen, { type = 'triad', center = 72, vel = 0.65, gate = 0.9, seed = 5 } = {}) {
    const ev = [], r = rng(seed);
    g.prog.forEach((d, bar) => {
      const ns = voice(chordNotes(g, d, type), center), ext = [...ns, ...ns.map((n) => n + 12)];
      for (let s = 0, k = 0; s < 16; s += stepLen, k++) ev.push({ b: bar * 4 + s / 4, d: stepLen / 4 * gate, i: inst, n: ext[order[k % order.length] % ext.length], v: vel * (1 + r() * 0.08) });
    });
    return ev;
  }
  /** Melody: seeded walk through the scale, landing on chord tones on the first note of each bar. */
  function melody(g, inst, rhythms, { seed = 7, base = 7, vel = 0.75, range = [3, 12] } = {}) {
    const ev = [], r = rng(seed); let cur = base;
    g.prog.forEach((d, bar) => {
      const rh = rhythms[bar % rhythms.length];
      rh.forEach(([st, len], k) => {
        if (k === 0) { const tones = [d, d + 2, d + 4, d + 7, d + 9].filter((x) => x >= range[0] && x <= range[1]);
          cur = tones.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a, tones[0] ?? base); }
        else { const mv = [-2, -1, -1, 1, 1, 2, 0][Math.floor((r() + 1) / 2 * 7) % 7]; cur = Math.max(range[0], Math.min(range[1], cur + mv)); }
        if (bar === g.prog.length - 1 && k === rh.length - 1) cur = Math.round(cur / 7) * 7 || 7;
        ev.push({ b: bar * 4 + st / 4, d: len / 4, i: inst, n: deg(g.root, g.scale, cur), v: vel * (1 + r() * 0.08) });
      });
    });
    return ev;
  }
  const fxEv = (id, bars, root, at = 0) => [{ b: at, d: bars * 4 - at, fx: id, n: root, v: 0.8 }];

  /* ---------- genre recipes ---------- */
  const R = { // common rhythms (16 steps per bar)
    whole: [[0, 16]], halves: [[0, 8], [8, 8]], pulse8: [[0, 2], [2, 2], [4, 2], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2]],
    offbeat: [[2, 2], [6, 2], [10, 2], [14, 2]], charleston: [[0, 3], [3, 5, 0.85], [10, 6, 0.9]], push: [[0, 6], [6, 4], [10, 6]],
  };
  const list = [];
  function add(genre, cat, name, bars, events, extra = {}) {
    list.push({ id: `${genre}-${cat.toLowerCase()}-${list.filter((l) => l.genre === genre && l.cat === cat).length + 1}`, name, cat, genre, bars, events, ...extra });
  }

  // 1. Hip-Hop (boom-bap)
  { const g = { root: 57, scale: 'Minor', prog: [0, 5, 3, 4] }, k = 'boombap', sw = 0.58; GENRES.hiphop.key = { root: g.root, scale: g.scale };
    add('hiphop', 'Drums', 'Boom-Bap Beat', 2, drums(k, 16, 2, { kick: 'x.........x.....x......x.x......', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.xo' }, sw, 11));
    add('hiphop', 'Drums', 'Dusty Groove', 2, drums(k, 16, 2, { kick: 'x..x......x..x..x.....x...x.....', snare: '....x.......x..o....x.......x...', hat: 'x.xox.x.x.xox.x.x.xox.x.x.xox.xo', ohat: '..............x...............x.' }, sw, 12));
    add('hiphop', 'Drums', 'Hats & Rim', 1, drums(k, 16, 1, { hat: 'xoxoxoxoxoxoxoxo', rim: '...x.......x..x.', shaker: '..x...x...x...x.' }, sw, 13));
    add('hiphop', 'Drums', 'Kick & Snare', 1, drums(k, 16, 1, { kick: 'x......x..x.....', snare: '....x.......x...' }, sw, 14));
    add('hiphop', 'Bass', 'Deep Bassline', 4, bass(g, 'ebass', [[0, 6], [7, 3], [10, 4]]));
    add('hiphop', 'Bass', 'Walking Bass', 4, bass(g, 'ebass', [[0, 4], [4, 4, 3], [8, 4, 7], [12, 4, 5]], { seed: 41 }));
    add('hiphop', 'Bass', 'Sub Hits', 4, bass(g, 'synthbass', [[0, 3], [10, 3]], { seed: 42 }));
    add('hiphop', 'Chords', 'Soul Keys', 4, chords(g, 'epiano', R.charleston, { type: '7th', center: 62 }));
    add('hiphop', 'Chords', 'Piano Loop', 4, chords(g, 'piano', [[0, 8], [10, 6, 0.8]], { center: 64, seed: 31 }));
    add('hiphop', 'Chords', 'String Swells', 4, chords(g, 'strings', R.whole, { center: 64, vel: 0.55, seed: 32 }));
    add('hiphop', 'Melody', 'Flute Hook', 4, melody(g, 'flute', [[[0, 3], [3, 3], [6, 2], [10, 6]], [[0, 6], [8, 4], [12, 4]]], { seed: 71 }));
    add('hiphop', 'Melody', 'Bell Motif', 4, arp(g, 'bells', [0, 2, 1, 3], 4, { center: 76, vel: 0.5 }));
    add('hiphop', 'Melody', 'Piano Riff', 4, melody(g, 'piano', [[[0, 2], [2, 2], [4, 4], [10, 2], [12, 4]]], { seed: 72 }));
    add('hiphop', 'FX', 'Vinyl Crackle', 2, fxEv('vinyl', 2, 57));
    add('hiphop', 'FX', 'Scratch Sweep', 1, fxEv('sweep', 1, 57));
    add('hiphop', 'FX', 'Impact', 2, fxEv('impact', 2, 45));
  }
  // 2. House
  { const g = { root: 53, scale: 'Minor', prog: [0, 5, 2, 6] }, k = 'house', sw = 0.52; GENRES.house.key = { root: g.root, scale: g.scale };
    add('house', 'Drums', 'Four on the Floor', 1, drums(k, 16, 1, { kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', ohat: '..x...x...x...x.' }, sw, 21));
    add('house', 'Drums', 'Groove House', 2, drums(k, 16, 2, { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'xxxxxxxxxxxxxxxo', ohat: '..x...x...x...x.', shaker: 'o.x.o.x.o.x.o.x.' }, sw, 22));
    add('house', 'Drums', 'Tops & Shaker', 1, drums(k, 16, 1, { hat: 'x.x.x.x.x.x.x.x.', shaker: 'oxoxoxoxoxoxoxox', rim: '.......x.....x..' }, sw, 23));
    add('house', 'Drums', 'Kick Only', 1, drums(k, 16, 1, { kick: 'x...x...x...x...' }, sw, 24));
    add('house', 'Bass', 'Offbeat Bass', 4, bass(g, 'synthbass', R.offbeat, { oct: -1 }));
    add('house', 'Bass', 'Rolling Bass', 4, bass(g, 'synthbass', [[2, 1], [3, 1, 12], [6, 1], [7, 1, 12], [10, 1], [11, 1, 12], [14, 1], [15, 1, 12]], { oct: -1, seed: 43 }));
    add('house', 'Bass', 'Deep Sub', 4, bass(g, 'bass808', [[0, 3], [6, 2], [8, 3], [14, 2]], { oct: -1, seed: 44 }));
    add('house', 'Chords', 'Piano Stabs', 4, chords(g, 'piano', [[2, 2], [6, 2], [9, 2], [12, 3]], { type: '7th', center: 64 }));
    add('house', 'Chords', 'Deep Pad', 4, chords(g, 'pad', R.whole, { type: '7th', center: 62, vel: 0.6 }));
    add('house', 'Chords', 'EP Chords', 4, chords(g, 'epiano', [[0, 6], [6, 4], [10, 6]], { type: '7th', center: 64, seed: 33 }));
    add('house', 'Melody', 'Synth Hook', 4, melody(g, 'lead', [[[0, 2], [3, 2], [6, 2], [8, 4], [14, 2]]], { seed: 73, vel: 0.6 }));
    add('house', 'Melody', 'Bell Arp', 4, arp(g, 'bells', [0, 1, 2, 3, 2, 1], 2, { center: 76, vel: 0.45 }));
    add('house', 'Melody', 'Marimba Groove', 4, arp(g, 'marimba', [0, 2, 1, 2, 3, 2, 1, 2], 2, { center: 72, vel: 0.6 }));
    add('house', 'FX', 'Riser', 4, fxEv('riser', 4, 53));
    add('house', 'FX', 'White Noise Build', 2, fxEv('noise', 2, 53));
    add('house', 'FX', 'Downlifter', 2, fxEv('downlifter', 2, 53));
  }
  // 3. Trap
  { const g = { root: 60, scale: 'Minor', prog: [0, 5, 6, 4] }, k = 'trap'; GENRES.trap.key = { root: g.root, scale: g.scale };
    add('trap', 'Drums', 'Trap Beat', 2, drums(k, 32, 2, { kick: 'x...........x.......x...........x.......x...x...........x.......', clap: '................x...............................x...............', hat: 'x...x...x...x...x...x.x.x...x...x...x...x...x...x...xxxxx...x...' }, 0.5, 31));
    add('trap', 'Drums', 'Rolling Hats', 2, drums(k, 32, 2, { kick: 'x.......x...........x...x.......x.......x...........x...........', clap: '................x...............................x...............', hat: 'x.x.x.x.x.x.x.x.xxxxx.x.x.x.x.x.x.x.x.x.x.x.xxxxxxxxx.x.x.x.x.x.', ohat: '............................x...............................x...' }, 0.5, 32));
    add('trap', 'Drums', 'Hi-Hat Triplets', 1, drums(k, 32, 1, { hat: 'x.x.x.x.xxx.x.x.x.x.x.x.xxxxx.x.', rim: '........x...............x.......' }, 0.5, 33));
    add('trap', 'Drums', 'Half-Time Clap', 1, drums(k, 16, 1, { kick: 'x.........x.....', clap: '........x.......', ride: '......x.......x.' }, 0.5, 34));
    add('trap', 'Bass', '808 Slides', 4, bass(g, 'bass808', [[0, 6], [8, 2], [11, 5]], { oct: -2 }));
    add('trap', 'Bass', '808 Bounce', 4, bass(g, 'bass808', [[0, 3], [3, 3], [10, 2], [12, 4, 12]], { oct: -2, seed: 45 }));
    add('trap', 'Bass', 'Long 808', 4, bass(g, 'bass808', [[0, 16]], { oct: -2, seed: 46 }));
    add('trap', 'Chords', 'Dark Pad', 4, chords(g, 'pad', R.whole, { center: 63, vel: 0.6 }));
    add('trap', 'Chords', 'Choir Strings', 4, chords(g, 'strings', R.halves, { center: 66, vel: 0.5 }));
    add('trap', 'Chords', 'Piano Keys', 4, chords(g, 'piano', [[0, 6], [6, 6], [12, 4]], { center: 66, seed: 34 }));
    add('trap', 'Melody', 'Bell Melody', 4, melody(g, 'bells', [[[0, 3], [3, 3], [6, 2], [8, 4], [12, 4]]], { seed: 74, vel: 0.55 }));
    add('trap', 'Melody', 'Dark Arp', 4, arp(g, 'pad', [0, 1, 2, 1], 2, { center: 70, vel: 0.45 }));
    add('trap', 'Melody', 'Flute Line', 4, melody(g, 'flute', [[[0, 4], [4, 2], [6, 2], [8, 8]], [[0, 2], [2, 2], [4, 4], [10, 6]]], { seed: 75 }));
    add('trap', 'FX', 'Reverse Cymbal', 2, fxEv('revcym', 2, 60));
    add('trap', 'FX', 'Impact', 2, fxEv('impact', 2, 36));
    add('trap', 'FX', 'Riser', 4, fxEv('riser', 4, 60));
  }
  // 4. Lo-Fi
  { const g = { root: 53, scale: 'Major', prog: [1, 4, 0, 5] }, k = 'boombap', sw = 0.62; GENRES.lofi.key = { root: g.root, scale: g.scale };
    add('lofi', 'Drums', 'Lazy Beat', 2, drums(k, 16, 2, { kick: 'x.......x.x.....x.......x.......', snare: '....x.......x.......x.......x..o', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 41));
    add('lofi', 'Drums', 'Jazzy Ride', 2, drums(k, 16, 2, { kick: 'x......x..x.....x.........x.....', rim: '....x.......x.......x.......x...', ride: 'x..xx..xx..xx..xx..xx..xx..xx..x' }, sw, 42));
    add('lofi', 'Drums', 'Shaker Tops', 1, drums(k, 16, 1, { shaker: 'x.xox.xox.xox.xo', hat: '..x...x...x...x.' }, sw, 43));
    add('lofi', 'Drums', 'Soft Kick & Rim', 1, drums(k, 16, 1, { kick: 'x.......x.......', rim: '....x.......x...' }, sw, 44));
    add('lofi', 'Bass', 'Mellow Bass', 4, bass(g, 'ebass', [[0, 6], [8, 4], [12, 3, 7]], { vel: 0.75 }));
    add('lofi', 'Bass', 'Jazz Walk', 4, bass(g, 'ebass', [[0, 4], [4, 4, 4], [8, 4, 7], [12, 4, 9]], { seed: 47, vel: 0.75 }));
    add('lofi', 'Bass', 'Sub Pulse', 4, bass(g, 'synthbass', [[0, 8], [10, 4]], { seed: 48, vel: 0.7 }));
    add('lofi', 'Chords', 'Rhodes 7ths', 4, chords(g, 'epiano', [[0, 7], [7, 9, 0.8]], { type: '7th', center: 62, strum: 0.03 }));
    add('lofi', 'Chords', 'Felt Piano', 4, chords(g, 'piano', R.charleston, { type: '7th', center: 62, vel: 0.55, strum: 0.02, seed: 35 }));
    add('lofi', 'Chords', 'Nylon Guitar', 4, chords(g, 'guitar', [[0, 8], [8, 8]], { type: '7th', center: 60, strum: 0.05, vel: 0.6, seed: 36 }));
    add('lofi', 'Melody', 'Sax Phrase', 4, melody(g, 'sax', [[[0, 3], [3, 3], [6, 6]], [[2, 2], [4, 4], [8, 8]]], { seed: 76, vel: 0.6, range: [2, 10] }));
    add('lofi', 'Melody', 'Rhodes Lick', 4, melody(g, 'epiano', [[[0, 2], [3, 2], [6, 2], [8, 2], [11, 5]]], { seed: 77, vel: 0.6 }));
    add('lofi', 'Melody', 'Flute Dream', 4, melody(g, 'flute', [[[0, 8], [8, 4], [12, 4]]], { seed: 78, vel: 0.6 }));
    add('lofi', 'FX', 'Vinyl Crackle', 4, fxEv('vinyl', 4, 53));
    add('lofi', 'FX', 'Tape Sweep', 2, fxEv('sweep', 2, 53));
    add('lofi', 'FX', 'Downlifter', 2, fxEv('downlifter', 2, 53));
  }
  // 5. Pop
  { const g = { root: 60, scale: 'Major', prog: [0, 4, 5, 3] }, k = 'acoustic', sw = 0.5; GENRES.pop.key = { root: g.root, scale: g.scale };
    add('pop', 'Drums', 'Pop Beat', 2, drums(k, 16, 2, { kick: 'x.......x.x.....x.......x.......', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 51));
    add('pop', 'Drums', 'Clap Groove', 2, drums(k, 16, 2, { kick: 'x..x..x...x.....x..x..x...x..x..', clap: '....x.......x.......x.......x...', hat: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', shaker: '..x...x...x...x...x...x...x...x.' }, sw, 52));
    add('pop', 'Drums', 'Shaker & Tamb', 1, drums(k, 16, 1, { shaker: 'xoxoxoxoxoxoxoxo', ride: '....x.......x...' }, sw, 53));
    add('pop', 'Drums', 'Big Fill', 1, drums(k, 16, 1, { kick: 'x.......x.......', snare: '....x...xxxx', tom1: '............xx..', tom3: '..............xx', crash: 'x...............' }, sw, 54));
    add('pop', 'Bass', 'Eighth Bass', 4, bass(g, 'ebass', R.pulse8, { vel: 0.75 }));
    add('pop', 'Bass', 'Bounce Bass', 4, bass(g, 'ebass', [[0, 3], [3, 3], [6, 2, 12], [10, 3], [14, 2, 7]], { seed: 49 }));
    add('pop', 'Bass', 'Synth Bass', 4, bass(g, 'synthbass', [[0, 2], [4, 2], [6, 2], [10, 2], [12, 4]], { seed: 50, oct: -1 }));
    add('pop', 'Chords', 'Piano Ballad', 4, chords(g, 'piano', R.pulse8.map(([s, l], i) => [s, l, i % 2 ? 0.75 : 1]), { center: 64 }));
    add('pop', 'Chords', 'Acoustic Strum', 4, chords(g, 'guitar', [[0, 3], [3, 3, 0.8], [6, 2, 0.7], [8, 2], [10, 3, 0.8], [14, 2, 0.7]], { center: 60, strum: 0.04, seed: 37 }));
    add('pop', 'Chords', 'Lush Strings', 4, chords(g, 'strings', R.whole, { center: 67, vel: 0.55, seed: 38 }));
    add('pop', 'Melody', 'Lead Hook', 4, melody(g, 'lead', [[[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]]], { seed: 79, vel: 0.55 }));
    add('pop', 'Melody', 'Piano Melody', 4, melody(g, 'piano', [[[0, 4], [4, 2], [6, 2], [8, 8]]], { seed: 80 }));
    add('pop', 'Melody', 'Bell Sparkle', 4, arp(g, 'bells', [0, 1, 2, 3, 4, 3, 2, 1], 2, { center: 79, vel: 0.4 }));
    add('pop', 'FX', 'Riser', 4, fxEv('riser', 4, 60));
    add('pop', 'FX', 'Reverse Cymbal', 2, fxEv('revcym', 2, 60));
    add('pop', 'FX', 'Impact', 2, fxEv('impact', 2, 48));
  }
  // 6. Techno
  { const g = { root: 57, scale: 'Minor', prog: [0, 0, 5, 6] }, k = 'house', sw = 0.5; GENRES.techno.key = { root: g.root, scale: g.scale };
    add('techno', 'Drums', 'Warehouse Kick', 1, drums(k, 16, 1, { kick: 'x...x...x...x...', hat: '..x...x...x...x.', rim: '...x..x....x..x.' }, sw, 61));
    add('techno', 'Drums', 'Driving Groove', 2, drums(k, 16, 2, { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', ohat: '..x...x...x...x.', ride: 'x.x.x.x.x.x.x.x.' }, sw, 62));
    add('techno', 'Drums', 'Percussion', 1, drums(k, 16, 1, { tom1: '...x.....x....x.', tom2: '.x.....x....x...', shaker: 'xxxxxxxxxxxxxxxx' }, sw, 63));
    add('techno', 'Drums', 'Rumble Kick', 1, drums(k, 16, 1, { kick: 'x...x...x...x...', tom3: '..o...o...o...o.' }, sw, 64));
    add('techno', 'Bass', 'Rolling 16ths', 4, bass(g, 'synthbass', [[1, 1], [2, 1], [3, 1], [5, 1], [6, 1], [7, 1], [9, 1], [10, 1], [11, 1], [13, 1], [14, 1], [15, 1]], { oct: -1, vel: 0.7 }));
    add('techno', 'Bass', 'Acid Line', 4, bass(g, 'synthbass', [[0, 1], [2, 1, 12], [3, 1], [6, 2, 3], [8, 1], [10, 1, 12], [11, 1, 7], [14, 2]], { oct: -1, seed: 51 }));
    add('techno', 'Bass', 'Sub Drone', 4, bass(g, 'bass808', [[2, 2], [6, 2], [10, 2], [14, 2]], { oct: -1, seed: 52 }));
    add('techno', 'Chords', 'Dub Stabs', 4, chords(g, 'pad', [[3, 2], [10, 2]], { type: '7th', center: 60, vel: 0.65 }));
    add('techno', 'Chords', 'Dark Strings', 4, chords(g, 'strings', R.whole, { center: 60, vel: 0.5, seed: 39 }));
    add('techno', 'Chords', 'Synth Stabs', 4, chords(g, 'lead', [[0, 1], [3, 1], [6, 1], [10, 1]], { center: 64, vel: 0.45, seed: 40 }));
    add('techno', 'Melody', 'Hypnotic Arp', 4, arp(g, 'lead', [0, 2, 1, 3, 2, 4], 1, { center: 69, vel: 0.4, gate: 0.6 }));
    add('techno', 'Melody', 'Metal Seq', 4, arp(g, 'marimba', [0, 0, 2, 0, 1, 0, 3, 0], 2, { center: 64, vel: 0.6 }));
    add('techno', 'Melody', 'Bell Pings', 4, arp(g, 'bells', [0, 2, 4], 4, { center: 81, vel: 0.35 }));
    add('techno', 'FX', 'Noise Build', 4, fxEv('noise', 4, 57));
    add('techno', 'FX', 'Sweep', 2, fxEv('sweep', 2, 57));
    add('techno', 'FX', 'Impact', 2, fxEv('impact', 2, 45));
  }
  // 7. Drum & Bass
  { const g = { root: 52, scale: 'Minor', prog: [0, 5, 2, 6] }, k = 'acoustic', sw = 0.5; GENRES.dnb.key = { root: g.root, scale: g.scale };
    add('dnb', 'Drums', 'Two-Step Break', 2, drums(k, 16, 2, { kick: 'x.........x.....x.........x.....', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 71));
    add('dnb', 'Drums', 'Amen-Style Break', 2, drums(k, 16, 2, { kick: 'x.x.......xx....x.x.......x.....', snare: '....x..o.o..x..o....x..o.o..x.o.', ride: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 72));
    add('dnb', 'Drums', 'Shaker Rolls', 1, drums(k, 16, 1, { shaker: 'xxxxxxxxxxxxxxxx', hat: 'x...x...x...x...' }, sw, 73));
    add('dnb', 'Drums', 'Half-Time Roller', 2, drums(k, 16, 2, { kick: 'x.................x.......x.....', snare: '........x...............x.......', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 74));
    add('dnb', 'Bass', 'Reese Bass', 4, bass(g, 'synthbass', [[0, 10], [10, 6]], { oct: -1 }));
    add('dnb', 'Bass', 'Sub Roller', 4, bass(g, 'bass808', [[0, 6], [6, 4], [10, 6]], { oct: -1, seed: 53 }));
    add('dnb', 'Bass', 'Liquid Bass', 4, bass(g, 'ebass', [[0, 4], [6, 2], [8, 4, 7], [14, 2]], { oct: -1, seed: 54 }));
    add('dnb', 'Chords', 'Liquid Pad', 4, chords(g, 'pad', R.whole, { type: '7th', center: 62, vel: 0.6 }));
    add('dnb', 'Chords', 'Atmos Strings', 4, chords(g, 'strings', R.halves, { center: 65, vel: 0.5, seed: 41 }));
    add('dnb', 'Chords', 'Rhodes Chords', 4, chords(g, 'epiano', [[0, 6], [6, 10]], { type: '7th', center: 63, seed: 42 }));
    add('dnb', 'Melody', 'Lead Riff', 4, melody(g, 'lead', [[[0, 2], [2, 2], [4, 2], [8, 4], [12, 4]]], { seed: 81, vel: 0.5 }));
    add('dnb', 'Melody', 'Bell Arp', 4, arp(g, 'bells', [0, 1, 2, 3], 2, { center: 76, vel: 0.4 }));
    add('dnb', 'Melody', 'Flute Air', 4, melody(g, 'flute', [[[0, 8], [8, 8]]], { seed: 82, vel: 0.55 }));
    add('dnb', 'FX', 'Riser', 4, fxEv('riser', 4, 52));
    add('dnb', 'FX', 'Reverse Cymbal', 2, fxEv('revcym', 2, 52));
    add('dnb', 'FX', 'Impact', 2, fxEv('impact', 2, 40));
  }
  // 8. Afrobeats
  { const g = { root: 55, scale: 'Major', prog: [5, 3, 0, 4] }, k = 'acoustic', sw = 0.54; GENRES.afro.key = { root: g.root, scale: g.scale };
    add('afro', 'Drums', 'Afro Groove', 2, drums(k, 16, 2, { kick: 'x..x..x...x..x..x..x..x...x..x..', rim: '...x..x....x..x....x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', shaker: 'oxoxoxoxoxoxoxoxoxoxoxoxoxoxoxox' }, sw, 81));
    add('afro', 'Drums', 'Log Drum Bounce', 2, drums(k, 16, 2, { kick: 'x.....x...x.....x.....x...x.....', clap: '....x.......x.......x.......x...', tom2: '..x.....x.x...x...x.....x...x.x.', shaker: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, sw, 82));
    add('afro', 'Drums', 'Percussion', 1, drums(k, 16, 1, { tom1: 'x..x..x...x.x...', rim: '..x..x...x...x..', shaker: 'oxoxoxoxoxoxoxox' }, sw, 83));
    add('afro', 'Drums', 'Kick & Clap', 1, drums(k, 16, 1, { kick: 'x..x..x...x.....', clap: '....x.......x...' }, sw, 84));
    add('afro', 'Bass', 'Afro Bass', 4, bass(g, 'ebass', [[0, 3], [3, 3], [6, 2, 7], [10, 3], [13, 3, 12]]));
    add('afro', 'Bass', 'Bouncy Synth', 4, bass(g, 'synthbass', [[0, 2], [3, 2], [6, 2], [8, 2], [11, 2, 7], [14, 2]], { oct: -1, seed: 55 }));
    add('afro', 'Bass', 'Log Drum 808', 4, bass(g, 'bass808', [[0, 3], [6, 2], [10, 4]], { seed: 56 }));
    add('afro', 'Chords', 'Highlife Guitar', 4, chords(g, 'guitar', [[0, 2], [3, 2, 0.8], [6, 2], [10, 2, 0.8], [12, 2]], { center: 64, strum: 0.02 }));
    add('afro', 'Chords', 'Warm Keys', 4, chords(g, 'epiano', R.charleston, { type: '7th', center: 63, seed: 43 }));
    add('afro', 'Chords', 'Marimba Chords', 4, chords(g, 'marimba', [[0, 2], [4, 2], [6, 2], [10, 2], [12, 2]], { center: 67, vel: 0.6, seed: 44 }));
    add('afro', 'Melody', 'Marimba Hook', 4, melody(g, 'marimba', [[[0, 2], [2, 2], [4, 2], [7, 2], [10, 2], [12, 4]]], { seed: 83, vel: 0.7 }));
    add('afro', 'Melody', 'Sax Line', 4, melody(g, 'sax', [[[0, 4], [6, 2], [8, 6]], [[0, 2], [2, 2], [4, 4], [10, 6]]], { seed: 84, vel: 0.6 }));
    add('afro', 'Melody', 'Flute Melody', 4, melody(g, 'flute', [[[0, 3], [3, 3], [6, 4], [12, 4]]], { seed: 85, vel: 0.6 }));
    add('afro', 'FX', 'Riser', 2, fxEv('riser', 2, 55));
    add('afro', 'FX', 'Sweep', 2, fxEv('sweep', 2, 55));
    add('afro', 'FX', 'Impact', 2, fxEv('impact', 2, 43));
  }
  // 9. Rock
  { const g = { root: 52, scale: 'Minor', prog: [0, 5, 2, 6] }, k = 'acoustic', sw = 0.5; GENRES.rock.key = { root: g.root, scale: g.scale };
    add('rock', 'Drums', 'Rock Beat', 2, drums(k, 16, 2, { kick: 'x.......x.x.....x.......x.x.....', snare: '....X.......X.......X.......X...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', crash: 'x...............................' }, sw, 91));
    add('rock', 'Drums', 'Driving Ride', 2, drums(k, 16, 2, { kick: 'x...x...x...x...x...x...x.x.x...', snare: '....X.......X.......X.......X...', ride: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' }, sw, 92));
    add('rock', 'Drums', 'Tom Groove', 1, drums(k, 16, 1, { kick: 'x.......x.......', tom3: 'x.x.x.x.x.x.x.x.', tom2: '....x.......x...' }, sw, 93));
    add('rock', 'Drums', 'Big Fill', 1, drums(k, 16, 1, { snare: 'x.x.x.x.', tom1: '........xx', tom2: '..........xx', tom3: '............xxxx', kick: 'x...............' }, sw, 94));
    add('rock', 'Bass', 'Driving Eighths', 4, bass(g, 'ebass', R.pulse8, { oct: -1 }));
    add('rock', 'Bass', 'Root-Fifth', 4, bass(g, 'ebass', [[0, 4], [4, 2, 7], [6, 2], [8, 4, 12], [12, 4, 7]], { oct: -1, seed: 57 }));
    add('rock', 'Bass', 'Heavy Synth', 4, bass(g, 'synthbass', [[0, 6], [8, 2], [10, 2], [12, 4]], { oct: -1, seed: 58 }));
    add('rock', 'Chords', 'Power Chords', 4, chords(g, 'guitar', R.pulse8, { type: 'power', center: 52, strum: 0.01 }));
    add('rock', 'Chords', 'Open Strum', 4, chords(g, 'guitar', [[0, 6], [6, 4, 0.8], [10, 6, 0.9]], { center: 60, strum: 0.045, seed: 45 }));
    add('rock', 'Chords', 'Brass Hits', 4, chords(g, 'brass', [[0, 4], [6, 2], [8, 8]], { center: 62, vel: 0.6, seed: 46 }));
    add('rock', 'Melody', 'Lead Solo', 4, melody(g, 'lead', [[[0, 2], [2, 2], [4, 4], [8, 2], [10, 6]], [[0, 4], [4, 4], [8, 8]]], { seed: 86, vel: 0.55 }));
    add('rock', 'Melody', 'Guitar Riff', 4, melody(g, 'guitar', [[[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 4]]], { seed: 87, base: 3, range: [0, 9] }));
    add('rock', 'Melody', 'Brass Line', 4, melody(g, 'brass', [[[0, 6], [6, 2], [8, 8]]], { seed: 88, vel: 0.6 }));
    add('rock', 'FX', 'Reverse Cymbal', 2, fxEv('revcym', 2, 52));
    add('rock', 'FX', 'Impact', 2, fxEv('impact', 2, 40));
    add('rock', 'FX', 'Riser', 4, fxEv('riser', 4, 52));
  }
  // 10. Ambient
  { const g = { root: 62, scale: 'Major', prog: [0, 4, 5, 3] }, k = 'acoustic', sw = 0.5; GENRES.ambient.key = { root: g.root, scale: g.scale };
    add('ambient', 'Drums', 'Soft Pulse', 2, drums(k, 16, 2, { kick: 'x...............x.......x.......', rim: '........x...............x.......', shaker: '..x...x...x...x...x...x...x...x.' }, sw, 101));
    add('ambient', 'Drums', 'Shimmer Ride', 1, drums(k, 16, 1, { ride: 'x...x...x...x...', shaker: 'o.o.o.o.o.o.o.o.' }, sw, 102));
    add('ambient', 'Drums', 'Heartbeat', 1, drums(k, 16, 1, { kick: 'x..x............' }, sw, 103));
    add('ambient', 'Drums', 'Brush Groove', 2, drums(k, 16, 2, { snare: '....o.......o.......o.......o...', shaker: 'oxoxoxoxoxoxoxoxoxoxoxoxoxoxoxox', kick: 'x.........x.....x.........x.....' }, sw, 104));
    add('ambient', 'Bass', 'Sub Drone', 4, bass(g, 'synthbass', [[0, 16]], { oct: -2, vel: 0.6 }));
    add('ambient', 'Bass', 'Soft Pulse Bass', 4, bass(g, 'ebass', [[0, 6], [8, 6]], { oct: -2, vel: 0.6, seed: 59 }));
    add('ambient', 'Bass', 'Deep 808', 4, bass(g, 'bass808', [[0, 16]], { oct: -2, vel: 0.55, seed: 60 }));
    add('ambient', 'Chords', 'Cloud Pad', 4, chords(g, 'pad', R.whole, { type: '7th', center: 64, vel: 0.6 }));
    add('ambient', 'Chords', 'Slow Strings', 4, chords(g, 'strings', R.whole, { center: 67, vel: 0.5, seed: 47 }));
    add('ambient', 'Chords', 'Dreamy Keys', 4, chords(g, 'epiano', R.halves, { type: '7th', center: 64, vel: 0.5, strum: 0.08, seed: 48 }));
    add('ambient', 'Melody', 'Glass Arp', 4, arp(g, 'bells', [0, 2, 1, 3, 2, 4, 3, 5], 2, { center: 79, vel: 0.35, type: '7th' }));
    add('ambient', 'Melody', 'Marimba Drift', 4, arp(g, 'marimba', [0, 1, 2, 3], 4, { center: 74, vel: 0.5 }));
    add('ambient', 'Melody', 'Flute Breath', 4, melody(g, 'flute', [[[0, 8], [8, 8]], [[0, 12], [12, 4]]], { seed: 89, vel: 0.5 }));
    add('ambient', 'FX', 'Drone', 4, fxEv('drone', 4, 62));
    add('ambient', 'FX', 'Reverse Swell', 2, fxEv('revcym', 2, 62));
    add('ambient', 'FX', 'Air Sweep', 4, fxEv('sweep', 4, 62));
  }

  const byId = new Map(list.map((l) => [l.id, l]));
  return { CATS, GENRES, list, byId };
})();
