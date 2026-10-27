// Generates engine/src/nodes/presets.ts from Moshpit 1's PRESETS (src/ops.ts, cfd5d8c).
// The output is an artifact: change this generator and rerun it, never edit the output by hand.
//   node scripts/port-presets.mjs [path-to-moshpit-1]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const m1 = process.argv[2];
if (!m1 || !path.isAbsolute(m1)) throw new Error('Provide the absolute path to the Moshpit 1 source checkout.');
const out = path.join(root, 'out', 'presets-m1.cjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
// ops.ts imports only types (ParamSpec, Lfo), which esbuild elides.
await esbuild.build({ entryPoints: [path.join(m1, 'src', 'ops.ts')], bundle: false, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
const { PRESETS } = createRequire(import.meta.url)(out);

// Moshpit 1 op → v3 node kind, and its param labels → v3 keys (EFFECTS-LOG E2).
const W = { 'win from': 'winFrom', 'win len': 'winLen' };
const MAP = {
  hold: ['mosh.hold', { at: 'at', span: 'span', times: 'times', ...W }],
  stride: ['mosh.stride', { every: 'every', offset: 'offset', invert: 'invert', ...W }],
  reverse: ['mosh.reverse', { chunk: 'chunk', ...W }],
  pingpong: ['mosh.pingpong', { laps: 'laps', pause: 'pause', 'double ends': 'doubleEnds', ...W }],
  strideSlip: ['mosh.stride-slip', { every: 'every', offset: 'offset', ...W }],
  speed: ['mosh.speed', { rate: 'rate', ...W }],
  speedRamp: ['mosh.speed-ramp', { 'rate in': 'rateIn', 'rate out': 'rateOut', ...W }],
  saturation: ['fx.saturation', { amount: 'amount' }],
  contrast: ['fx.contrast', { amount: 'amount' }],
  brightness: ['fx.brightness', { level: 'level' }],
  hueRotate: ['fx.hue-rotate', { degrees: 'degrees' }],
  invert: ['fx.invert', { amount: 'amount' }],
  sepia: ['fx.sepia', { amount: 'amount' }],
  posterize: ['fx.posterize', { levels: 'levels' }],
  channelIsolation: ['fx.channel-isolation', { 'keep r': 'keepR', 'keep g': 'keepG', 'keep b': 'keepB' }],
  planeDesyncSpatial: ['fx.plane-desync', { channel: 'channel', dx: 'dx', dy: 'dy' }],
  chromaDrift: ['fx.chroma-drift', { 'cb shift': 'cb', 'cr shift': 'cr' }],
  mirror: ['fx.mirror', { vertical: 'vertical', flip: 'flip' }],
  transform: ['fx.transform', { turn: 'turn', rotate: 'rotate', scale: 'scale', 'offset x': 'offsetX', 'offset y': 'offsetY', 'crop x': 'cropX', 'crop y': 'cropY' }],
  rowDisplacement: ['fx.row-displacement', { band: 'band', amount: 'amount', curve: 'curve', speed: 'speed' }],
  pixelStretch: ['fx.pixel-stretch', { mode: 'mode', origin: 'origin', reach: 'reach', speed: 'speed' }],
  resolutionCrush: ['fx.resolution-crush', { factor: 'factor', smooth: 'smooth' }],
  softBlur: ['fx.soft-blur', { radius: 'radius' }],
  noise: ['fx.salt-pepper', { density: 'density' }],
  planeDesyncTemporal: ['fx.plane-desync-temporal', { 'past r': 'pastR', 'past g': 'pastG', 'past b': 'pastB', 'frames back': 'back' }],
  fieldDesync: ['fx.field-desync', { parity: 'parity', 'frames back': 'back' }],
  feedbackTrail: ['fx.feedback-trail', { amount: 'amount', 'frames back': 'back' }],
  chromaTrail: ['fx.chroma-trail', { amount: 'amount', 'frames back': 'back', spread: 'spread' }],
  driftTrail: ['fx.drift-trail', { amount: 'amount', 'frames back': 'back', 'drift x': 'driftX', 'drift y': 'driftY' }],
  breathTrail: ['fx.breath-trail', { amount: 'amount', 'frames back': 'back', period: 'period', floor: 'floor' }],
  echoTaps: ['fx.echo-taps', { amount: 'amount', taps: 'taps', spacing: 'spacing', decay: 'decay' }],
};
// Value conversions where v3 changed a param's type (EFFECTS-LOG E2).
const BOOLS = new Set(['invert', 'doubleEnds', 'keepR', 'keepG', 'keepB', 'vertical', 'flip', 'smooth', 'pastR', 'pastG', 'pastB', 'parity']);
const ENUMS = { channel: ['r', 'g', 'b'], curve: ['linear', 'sine', 'random', 'stepped'], mode: ['horizontal', 'vertical', 'wave'] };
// Image ops lost Moshpit 1's per-op window and ease (EFFECTS-LOG E1): those keys are dropped, and logged.
const DROPPED = new Set(['win from', 'win len', 'ease in', 'ease out']);
// These two names promised a tail window that the image-op port does not implement.
// Preserve their numeric starting points, but name their actual whole-block behaviour.
const ADAPTED_NAMES = {
  'fx.saturation': { 'Fade the tail': 'Faded colour' },
  'fx.contrast': { 'Crush the tail': 'Hard contrast' },
};

const presets = {}, dropped = [], unmapped = [];
for (const [m1op, list] of Object.entries(PRESETS)) {
  const m = MAP[m1op];
  if (!m) { unmapped.push(m1op); continue; }
  const [kind, keys] = m;
  presets[kind] = list.map((p) => {
    const params = {};
    for (const [label, v] of Object.entries(p.params)) {
      const key = keys[label];
      if (!key) { if (DROPPED.has(label)) dropped.push(`${kind} "${p.name}": ${label}`); else unmapped.push(`${kind}.${label}`); continue; }
      params[key] = BOOLS.has(key) ? v >= 0.5 : ENUMS[key] ? ENUMS[key][Math.max(0, Math.min(ENUMS[key].length - 1, Math.round(v)))] : v;
    }
    return { name: ADAPTED_NAMES[kind]?.[p.name] ?? p.name, params };
  });
}
if (unmapped.length) throw new Error(`unmapped: ${unmapped.join(', ')}`);
const count = Object.values(presets).reduce((n, l) => n + l.length, 0);
const ts = `// GENERATED by scripts/port-presets.mjs from Moshpit 1 src/ops.ts PRESETS (cfd5d8c). Do not edit:
// change the generator and rerun it. ${count} presets over ${Object.keys(presets).length} node kinds.
// Values are Moshpit 1's, re-keyed for v3; they were tuned for the CPU/CSS renders, so treat them as
// starting points to re-tune on the shaders (audit W6). Dropped per-op window/ease keys on image
// ops: ${dropped.length} (EFFECTS-LOG E1).
// Two tail-only names are adapted to whole-block behaviour; see docs/final-sprint/V1-PRESET-PARITY.md.

export interface Preset { name: string; params: Record<string, number | boolean | string> }

export const PRESETS: Record<string, Preset[]> = ${JSON.stringify(presets, null, 2)};
`;
fs.writeFileSync(path.join(root, 'engine', 'src', 'nodes', 'presets.ts'), ts);
console.log(`wrote ${count} presets for ${Object.keys(presets).length} kinds; dropped ${dropped.length} window/ease keys on image ops`);
