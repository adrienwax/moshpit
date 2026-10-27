// Colour-token lint (design system A0.5, shared/ui/DESIGN-SYSTEM.md §1).
//   node scripts/check-colour-tokens.mjs            check; exits 1 on a violation
//   node scripts/check-colour-tokens.mjs --update   rewrite the baseline after removing literals
// Rules:
//   1. Colour literals (hex, rgb(), hsl()) belong in shared/ui/tokens.css. Elsewhere a file may not
//      hold more than its baselined count: the legacy layers are migrated down, never up.
//   2. Crimson is caution only: a red-family literal may appear in tokens.css only on a caution
//      primitive (--p-crimson, --p-red), a scope red channel (--scope-r, --scope-panel-r) or a named
//      legacy identity red (--legacy-coral-a*: the old coral, kept verbatim, not caution). Elsewhere
//      red-family literals are baselined separately, so a new one cannot hide behind a removed literal.
//   3. RED_FILE_OK files may hold red-family literals: they cannot consume CSS tokens (canvas art).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = 'shared/ui/tokens.css';
const BASELINE = 'scripts/colour-literal-baseline.json';
const SCAN = ['app/src', 'shared/ui'];
const RED_OK = /--(p-crimson|p-red|scope-r|scope-panel-r|legacy-coral-a\d+)\s*:/;
const RED_FILE_OK = {
  'app/src/engine/mockEngine.ts': 'mock-engine canvas palette: fillStyle strings with appended alpha, no CSS context',
};
const LITERAL = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(css|tsx?)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** [r, g, b] 0–255 from a literal, or null when it is not a concrete colour (e.g. rgb(var(--x))). */
function rgbOf(lit) {
  if (lit[0] === '#') {
    let h = lit.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const n = lit.match(/[\d.]+%?/g);
  if (!n || n.length < 3 || /var\(/.test(lit)) return null;
  if (lit.startsWith('hsl')) {
    const [h, s, l] = [parseFloat(n[0]), parseFloat(n[1]) / 100, parseFloat(n[2]) / 100];
    const k = (x) => (x + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((x) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(x) - 3, 9 - k(x), 1)))));
  }
  return n.slice(0, 3).map((v) => (v.endsWith('%') ? 2.55 * parseFloat(v) : parseFloat(v)));
}

// ponytail: hue window 335°–15° with saturation ≥ 0.35 is the red family. It keeps Moshpit's coral
// identity (#f08a63, 17°) out and catches salmon #ee9380 (10°); widen it if a near-red slips past.
export function isRedFamily(lit) {
  const c = rgbOf(lit);
  if (!c) return false;
  const [r, g, b] = c.map((v) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.35 || l < 0.2 || l > 0.9) return false;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 335 || h < 15;
}

export function scan() {
  const counts = {}, tokenViolations = [];
  for (const f of SCAN.flatMap(files).sort()) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    let all = 0, red = 0;
    lines.forEach((line, i) => {
      for (const [lit] of line.matchAll(LITERAL)) {
        if (!rgbOf(lit) && !lit.startsWith('#')) continue; // rgb(var(--x) / .5) and the like are token uses
        all++;
        if (!isRedFamily(lit)) continue;
        if (RED_FILE_OK[f]) continue;
        red++;
        if (f === TOKENS && !RED_OK.test(line)) tokenViolations.push(`${f}:${i + 1}: red-family ${lit} outside a caution primitive`);
      }
    });
    if (f !== TOKENS && all) counts[f] = { all, red };
  }
  return { counts, tokenViolations };
}

// ---- semantics (R2): literal counts cannot see a token used in the wrong place ----
// Ordinary controls (IN/OUT markers, picture/motion blocks, navigation and storage dots) must never
// name a caution token, and every colour they declare, resolved through tokens.css in every theme,
// must be non-red. Rules in a caution context (danger, error, cut…) are exempt by selector.
const ORDINARY = /\.(in|out|io|mk|mkin|mkout|mkh|mot|pic|blk|mb|sb|setnav|store2?|wsswitch|ptabs|sitem|tabs)\b/;
// IN/OUT marks carry their own identity (--ident-io, owner decision): never the selection/interactive cyan.
const IO_MARK = /\.tag\.(in|out)\b|\.tbtn\.io\b|\.mk\.(in|out)\b|\.mkin\b|\.mkout\b|\.mkh\.(in|out)\b/;
const NOT_IO = /var\(--(fn-select|fn-interactive|fn-focus|coral|teal|lav|sky)\b/;
const CAUTION_CONTEXT = /danger|caution|err|fail|miss|\.del\b|cut|refus|bad|warn|rec\b|live/;
const CAUTION_TOKEN = /var\(--(fn-caution|fn-destructive|fn-error|fn-alert|fn-rec|stripe|p-crimson|p-red)\b/;
const COLOUR_PROP = /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|fill|stroke|text-decoration-color)$/;

/** Token maps per theme from tokens.css: the shared blocks, then each theme block over them. */
export function themeTokens() {
  const css = fs.readFileSync(path.join(root, TOKENS), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const base = {}, themes = { hud: {}, studio: {}, heritage: {} };
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((d) => [d[1], d[2].trim()]));
    const t = sel.match(/data-theme="(\w+)"/)?.[1];
    Object.assign(t ? themes[t] : base, decls);
  }
  return Object.fromEntries(Object.entries(themes).map(([k, v]) => [k, { ...base, ...v }]));
}
const resolve = (value, map, depth = 0) => depth > 12 ? value
  : value.replace(/var\((--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (m, n, fb) => resolve(map[n] ?? fb ?? '', map, depth + 1));

export function semantic() {
  const maps = themeTokens(), errors = [];
  for (const f of SCAN.flatMap(files).filter((x) => x.endsWith('.css') && x !== TOKENS)) {
    const css = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, sel, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const parts = sel.split(',').map((s) => s.trim()).filter((s) => ORDINARY.test(s) && !CAUTION_CONTEXT.test(s));
      if (!parts.length) continue;
      // IN = purple on dark, OUT = dark on purple (inverted): either way the rule carries --ident-io.
      const colours = [...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].filter(([, p]) => COLOUR_PROP.test(p));
      const ioPart = parts.find((x) => IO_MARK.test(x));
      if (ioPart && colours.length && !colours.some(([, , v]) => /var\(--ident-io\b/.test(v))) errors.push(`${f}: ${ioPart} declares colour without --ident-io; IN/OUT marks keep their identity (mark or inverted fill)`);
      for (const [, prop, val] of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
        if (!COLOUR_PROP.test(prop)) continue;
        if (CAUTION_TOKEN.test(val)) errors.push(`${f}: ${parts[0]} { ${prop} } names a caution token on an ordinary control: ${val.trim()}`);
        const io = parts.find((x) => IO_MARK.test(x));
        if (io && NOT_IO.test(val)) errors.push(`${f}: ${io} { ${prop} } IN/OUT marks use --ident-io, not the selection colour: ${val.trim()}`);
        for (const [theme, map] of Object.entries(maps)) {
          const red = [...resolve(val, map).matchAll(LITERAL)].map((m) => m[0]).find(isRedFamily);
          if (red) { errors.push(`${f}: ${parts[0]} { ${prop} } resolves to red-family ${red} in ${theme}; ordinary controls are never caution red`); break; }
        }
      }
    }
  }
  return errors;
}

export function check() {
  const { counts, tokenViolations } = scan();
  const base = JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8'));
  const errors = [...tokenViolations, ...semantic()];
  for (const [f, c] of Object.entries(counts)) {
    const b = base[f] ?? { all: 0, red: 0 };
    if (c.all > b.all) errors.push(`${f}: ${c.all} colour literals (baseline ${b.all}); use a token from ${TOKENS}`);
    if (c.red > b.red) errors.push(`${f}: ${c.red} red-family literals (baseline ${b.red}); crimson is --fn-caution only`);
  }
  return { errors, counts, base };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update')) {
    fs.writeFileSync(path.join(root, BASELINE), JSON.stringify(scan().counts, null, 2) + '\n');
    console.log(`baseline written: ${BASELINE}`);
  } else {
    const { errors, counts } = check();
    const total = Object.values(counts).reduce((n, c) => n + c.all, 0);
    if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
    console.log(`colour tokens ok: ${total} legacy literals in ${Object.keys(counts).length} files, none new`);
  }
}
