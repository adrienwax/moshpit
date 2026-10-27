// Phase 2.5: search by intent. "glitchy melting rainbow smear" should find effects whose explanations
// say smear, melt, colour, chroma — not only ones whose NAME has those words. Offline and local:
// a small lexicon maps the words people use for a look onto the words the atlas uses, a light stem
// lets "melting" meet "melt", and fields are weighted (name > look > Does / Use when > the rest).
// ponytail: a hand lexicon, not embeddings; a local embedding index is the upgrade if this misses.

/** Intent word (stemmed) → the atlas's words for it. */
const LEXICON: Record<string, string[]> = {
  melt: ['smear', 'liquefy', 'melt', 'bleed', 'pour', 'drip'],
  liquid: ['liquefy', 'melt', 'smear', 'pour'],
  drip: ['pour', 'smear', 'drift', 'melt'],
  smear: ['smear', 'bleed', 'melt', 'drift'],
  bleed: ['bleed', 'smear', 'chroma', 'colour'],
  bloom: ['bloom', 'swell', 'pour', 'hold'],
  glitch: ['mosh', 'corrupt', 'broken', 'damage', 'fault', 'bitstream'],
  mosh: ['mosh', 'bitstream', 'smear', 'p-frame'],
  broken: ['broken', 'fault', 'damage', 'corrupt', 'dropout'],
  corrupt: ['corrupt', 'damage', 'fault', 'broken'],
  rainbow: ['colour', 'chroma', 'hue', 'channel', 'red', 'green', 'blue'],
  colour: ['colour', 'chroma', 'hue', 'channel', 'saturation'],
  color: ['colour', 'chroma', 'hue', 'channel', 'saturation'],
  psychedel: ['hue', 'colour', 'rainbow', 'chroma', 'feedback', 'tunnel'],
  trippy: ['hue', 'feedback', 'tunnel', 'mirror', 'rainbow'],
  trail: ['trail', 'echo', 'ghost', 'feedback', 'lag'],
  ghost: ['ghost', 'echo', 'trail', 'past frame'],
  echo: ['echo', 'ghost', 'trail', 'delay', 'taps'],
  stutter: ['stutter', 'repeat', 'stride', 'jump', 'step', 'lurch'],
  choppy: ['stride', 'stutter', 'step', 'jump', 'lurch'],
  repeat: ['repeat', 'hold', 'stride', 'loop'],
  loop: ['ping-pong', 'loop', 'repeat', 'lap'],
  freez: ['hold', 'freeze', 'repeat'],
  hold: ['hold', 'repeat'],
  stop: ['hold', 'halt', 'freeze'],
  slow: ['speed', 'slow', 'rate', 'ramp', 'halt'],
  fast: ['speed', 'rate', 'faster'],
  speed: ['speed', 'rate', 'ramp'],
  backward: ['reverse', 'backwards', 'wrong way', 'ping-pong'],
  revers: ['reverse', 'backwards', 'wrong way'],
  rewind: ['reverse', 'backwards'],
  tape: ['tape', 'vhs', 'analog', 'tracking'],
  vhs: ['vhs', 'tape', 'analog', 'tracking'],
  analog: ['analog', 'tape', 'vhs', 'interlace'],
  retro: ['vhs', 'tape', 'analog', 'sepia', 'posterize'],
  old: ['sepia', 'aged', 'archival', 'tape', 'worn'],
  vintage: ['sepia', 'aged', 'archival', 'tape'],
  film: ['sepia', 'negative', 'archival', 'worn'],
  pixel: ['pixel', 'block', 'resolution', 'crush', 'chunky'],
  blocky: ['block', 'crush', 'resolution', 'chunky', 'compression', 'macroblock'],
  low: ['low', 'resolution', 'crush', 'posterize'],
  compress: ['compression', 'codec', 'band', 'posterize', 'crush'],
  band: ['band', 'posterize', 'quantise', 'levels'],
  tear: ['tear', 'shear', 'row', 'tracking', 'slice'],
  rip: ['tear', 'shear', 'slice'],
  shake: ['wobble', 'row', 'wave', 'shear'],
  wobbl: ['wobble', 'wave', 'row', 'shear'],
  wave: ['wave', 'row', 'wobble'],
  noise: ['noise', 'salt', 'pepper', 'dropout', 'grain', 'crackle'],
  static: ['noise', 'salt', 'pepper', 'dropout', 'crackle'],
  grain: ['noise', 'grain', 'salt'],
  dirt: ['noise', 'dropout', 'worn'],
  dream: ['soft', 'blur', 'trail', 'dreamy', 'melt'],
  soft: ['soft', 'blur', 'gentle'],
  blur: ['blur', 'soft'],
  hazy: ['blur', 'soft', 'washed', 'faded'],
  tunnel: ['tunnel', 'feedback', 'zoom', 'recursive', 'vortex'],
  infinit: ['tunnel', 'recursive', 'feedback'],
  vortex: ['vortex', 'tunnel', 'feedback', 'spiral'],
  spiral: ['spiral', 'tunnel', 'feedback', 'turn'],
  kaleidoscop: ['mirror', 'symmetric', 'kaleidoscope'],
  symmetr: ['mirror', 'symmetric'],
  mirror: ['mirror', 'reflect', 'symmetric'],
  split: ['split', 'channel', 'misregister', 'fringe'],
  fring: ['fringe', 'channel', 'misregister'],
  shift: ['shift', 'offset', 'channel', 'chroma'],
  streak: ['streak', 'stretch', 'pixel sort', 'drag', 'smear'],
  sort: ['pixel sort', 'stretch', 'streak'],
  stretch: ['stretch', 'streak'],
  zoom: ['zoom', 'scale', 'transform', 'tunnel'],
  rotat: ['rotate', 'turn', 'transform', 'spin'],
  spin: ['spin', 'rotate', 'hue', 'turn'],
  flash: ['flash', 'invert', 'hit', 'brightness'],
  negativ: ['negative', 'invert'],
  dark: ['darker', 'brightness', 'contrast'],
  bright: ['brightness', 'brighter', 'contrast'],
  punch: ['contrast', 'saturation', 'punch'],
  wash: ['washed', 'faded', 'contrast', 'saturation'],
  grey: ['grey', 'saturation', 'sepia'],
  warm: ['warm', 'sepia'],
  beat: ['beat', 'stride', 'switch', 'ping-pong', 'chop', 'drop'],
  drop: ['drop', 'beat', 'chop', 'speed ramp'],
  swap: ['switch', 'swap', 'branch'],
  blend: ['mix', 'blend', 'overlay'],
  overlay: ['mix', 'overlay', 'blend', 'difference'],
  interlac: ['interlace', 'field', 'comb', 'rows'],
  scan: ['row', 'scanner', 'field', 'interlace'],
};

/** A light English stem: enough for melting→melt, trails→trail, glitchy→glitch, colours→colour. */
export function stem(w: string): string {
  w = w.toLowerCase().replace(/[^a-z-]/g, '');
  for (const suf of ['ingly', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 'y', 's']) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return suf === 'ies' ? w.slice(0, -3) + 'y' : w.slice(0, -suf.length);
  }
  return w;
}

const STOP = new Set(['a', 'an', 'the', 'it', 'make', 'want', 'like', 'look', 'and', 'or', 'of', 'to', 'my', 'me', 'i', 'some', 'more', 'with', 'into', 'on', 'that', 'this', 'so', 'is', 'be', 'should', 'picture', 'image', 'video', 'effect', 'thing']);

/** The terms a query searches for: each word (weight 1) and its lexicon words (weight 0.6). */
export function expand(q: string): { term: string; w: number; from: string }[] {
  const out = new Map<string, { term: string; w: number; from: string }>();
  for (const raw of q.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (STOP.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 2) continue;
    const put = (term: string, w: number) => { const k = term; if (!out.has(k) || out.get(k)!.w < w) out.set(k, { term, w, from: raw }); };
    put(s, 1);
    const key = Object.keys(LEXICON).find((k) => s.startsWith(k) || k.startsWith(s) && s.length >= 4);
    for (const t of key ? LEXICON[key] : []) put(stem(t) || t, 0.6);
  }
  return [...out.values()];
}

/** Fields of an entry, most telling first. */
export interface Fields { name: string; look: string; does: string; rest: string }
const WEIGHT: Record<keyof Fields, number> = { name: 3, look: 2, does: 1.5, rest: 1 };

/** How well an entry answers the query (0 = not at all). Entries that answer more of its words rank first. */
export function score(f: Fields, terms: ReturnType<typeof expand>): number {
  if (!terms.length) return 0;
  const text = Object.fromEntries((Object.keys(f) as (keyof Fields)[]).map((k) => [k, ` ${f[k].toLowerCase().replace(/[^a-z\s-]/g, ' ')} `])) as unknown as Fields;
  let total = 0;
  const touched = new Set<string>();
  for (const t of terms) {
    const re = new RegExp(`[\\s-]${t.term.replace(/[-]/g, '\\-')}`);
    let best = 0;
    for (const k of Object.keys(WEIGHT) as (keyof Fields)[]) if (re.test(text[k])) best = Math.max(best, WEIGHT[k]);
    if (best) { total += best * t.w; touched.add(t.from); }
  }
  // An intent with several words: entries that answer more of them rank first.
  const words = new Set(terms.map((t) => t.from));
  return total * (touched.size / words.size);
}
