// L20: locked-AST expression fields. A parameter can be driven by a formula — `sin(beat*2)`,
// `clamp(lfo(1), 0, 1)`, `x * (0.5 + 0.5*noise(frame))` — through a math parser, never eval().
// Pure and capability-free: a formula reads only the names below and calls only the functions
// below. It is compiled once to a flat program run on a preallocated stack, so the per-frame path
// allocates nothing (L21). Seeded noise keeps it deterministic (L11).
//
// Names: x (the value so far: base, then LFO), base, frame, time (s), beat, fps, bpm, pi, e.
// Calls: lfo(n) (project LFO n, 1-based, 0..1), value(n) (project Value n, 0..1), noise(a[, b])
// (seeded 0..1), and the math below.
// Operators: + - * / % ^, unary -, comparisons (< <= > >= == !=) giving 0/1, `c ? a : b`.

import { MoshpitError } from '@moshpit/core';

const FNS: Record<string, [number, number]> = { // name → [min args, max args]
  sin: [1, 1], cos: [1, 1], tan: [1, 1], abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], fract: [1, 1], sqrt: [1, 1],
  exp: [1, 1], log: [1, 1], sign: [1, 1], min: [2, 2], max: [2, 2], pow: [2, 2], step: [2, 2], mod: [2, 2],
  clamp: [3, 3], mix: [3, 3], smoothstep: [3, 3], map: [5, 5], lfo: [1, 1], noise: [1, 2], value: [1, 1],
};
const VARS = ['x', 'base', 'frame', 'time', 'beat', 'fps', 'bpm'] as const;
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Node = { k: 'num'; v: number } | { k: 'var'; i: number } | { k: 'un'; op: string; a: Node } | { k: 'bin'; op: string; a: Node; b: Node } | { k: 'tern'; c: Node; a: Node; b: Node } | { k: 'call'; f: string; args: Node[] };

const bad = (source: string, at: number, why: string): never => { throw new MoshpitError('EXPRESSION_INVALID', { source, at, why }, undefined, `That expression could not be read at character ${at + 1}: ${why}.`); };

export function parse(source: string): Node {
  if (source.length > 512) bad(source, 512, 'too long (512 characters at most)');
  const toks: { t: string; v: string; at: number }[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i));
    if (num) { toks.push({ t: 'num', v: num[0], at: i }); i += num[0].length; continue; }
    const id = /^[a-z_][a-z0-9_]*/i.exec(source.slice(i));
    if (id) { toks.push({ t: 'id', v: id[0].toLowerCase(), at: i }); i += id[0].length; continue; }
    const op = /^(<=|>=|==|!=|[-+*/%^(),?:<>])/.exec(source.slice(i));
    if (op) { toks.push({ t: 'op', v: op[0], at: i }); i += op[0].length; continue; }
    bad(source, i, `unexpected '${c}'`);
  }
  let p = 0;
  const peek = () => toks[p], eat = (v: string) => { const t = toks[p]; if (!t || t.v !== v) bad(source, t?.at ?? source.length, `expected '${v}'`); p++; };
  const BP: Record<string, number> = { '?': 1, '==': 2, '!=': 2, '<': 3, '<=': 3, '>': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, '^': 7 };
  const prefix = (): Node => {
    const t = toks[p++];
    if (!t) return bad(source, source.length, 'the expression ends too early');
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.v === '-') return { k: 'un', op: '-', a: expr(6) };
    if (t.v === '+') return expr(6);
    if (t.v === '(') { const e = expr(0); eat(')'); return e; }
    if (t.t === 'id') {
      if (peek()?.v === '(') {
        // Own properties only: 'constructor' and friends live on the prototype and must not resolve.
        if (!Object.hasOwn(FNS, t.v)) bad(source, t.at, `'${t.v}' is not an allowed function`);
        p++;
        const args: Node[] = [];
        if (peek()?.v !== ')') for (;;) { args.push(expr(0)); if (peek()?.v === ',') { p++; continue; } break; }
        eat(')');
        const [lo, hi] = FNS[t.v];
        if (args.length < lo || args.length > hi) bad(source, t.at, `${t.v}() takes ${lo === hi ? lo : `${lo}–${hi}`} argument${hi > 1 ? 's' : ''}`);
        return { k: 'call', f: t.v, args };
      }
      if (Object.hasOwn(CONSTS, t.v)) return { k: 'num', v: CONSTS[t.v] };
      const i = (VARS as readonly string[]).indexOf(t.v);
      if (i < 0) bad(source, t.at, `'${t.v}' is not a name formulas can read`);
      return { k: 'var', i };
    }
    return bad(source, t.at, `unexpected '${t.v}'`);
  };
  const expr = (min: number): Node => {
    let left = prefix();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !Object.hasOwn(BP, t.v) || BP[t.v] <= min && !(t.v === '^' && BP[t.v] === min)) break;
      p++;
      if (t.v === '?') { const a = expr(0); eat(':'); const b = expr(0); left = { k: 'tern', c: left, a, b }; continue; }
      left = { k: 'bin', op: t.v, a: left, b: expr(t.v === '^' ? BP[t.v] - 1 : BP[t.v]) };
    }
    return left;
  };
  const tree = expr(0);
  if (p < toks.length) bad(source, toks[p].at, `unexpected '${toks[p].v}'`);
  return tree;
}

// ── compiled form: a flat program over a preallocated stack ──
const OPC: Record<string, number> = { '+': 10, '-': 11, '*': 12, '/': 13, '%': 14, '^': 15, '<': 16, '<=': 17, '>': 18, '>=': 19, '==': 20, '!=': 21 };
const FNC: Record<string, number> = Object.fromEntries(Object.keys(FNS).map((f, i) => [f, 40 + i]));
const NUM = 1, VAR = 2, NEG = 3, TERN = 4;

export interface Expr {
  source: string;
  /** Opcodes and operands, interleaved. */
  code: Float64Array;
  stack: Float64Array;
  /** Highest lfo(n) the formula reads, so the caller knows which LFOs to evaluate. */
  lfos: number[];
}

export function compileExpr(source: string): Expr {
  const code: number[] = [], lfos = new Set<number>();
  let depth = 0, max = 0;
  const push = (n = 1) => { depth += n; if (depth > max) max = depth; };
  const emit = (n: Node): void => {
    switch (n.k) {
      case 'num': code.push(NUM, n.v); push(); return;
      case 'var': code.push(VAR, n.i); push(); return;
      case 'un': emit(n.a); code.push(NEG); return;
      case 'bin': emit(n.a); emit(n.b); code.push(OPC[n.op]); depth--; return;
      case 'tern': emit(n.c); emit(n.a); emit(n.b); code.push(TERN); depth -= 2; return;
      case 'call':
        if (n.f === 'lfo' && n.args[0].k === 'num') lfos.add(n.args[0].v);
        for (const a of n.args) emit(a);
        code.push(FNC[n.f], n.args.length); depth -= n.args.length - 1; return;
    }
  };
  emit(parse(source));
  return { source, code: Float64Array.from(code), stack: new Float64Array(Math.max(4, max)), lfos: [...lfos] };
}

export interface ExprEnv {
  /** x, base, frame, time, beat, fps, bpm — in VARS order. */
  vars: Float64Array;
  /** lfo(n) → 0..1 at this frame. */
  lfo: (n: number) => number;
  /** noise(a, b) → seeded 0..1. */
  noise: (a: number, b: number) => number;
  /** value(n) → project Value n, 0..1 (Phase 1.5). */
  value?: (n: number) => number;
}

/** Evaluate without allocating. Non-finite results become 0 so a formula can never poison a param. */
export function evalExpr(e: Expr, env: ExprEnv): number {
  const c = e.code, s = e.stack, v = env.vars;
  let sp = 0;
  for (let i = 0; i < c.length;) {
    const op = c[i++];
    if (op === NUM) s[sp++] = c[i++];
    else if (op === VAR) s[sp++] = v[c[i++]];
    else if (op === NEG) s[sp - 1] = -s[sp - 1];
    else if (op === TERN) { sp -= 2; s[sp - 1] = s[sp - 1] !== 0 ? s[sp] : s[sp + 1]; }
    else if (op < 40) {
      const b = s[--sp], a = s[sp - 1];
      s[sp - 1] = op === 10 ? a + b : op === 11 ? a - b : op === 12 ? a * b : op === 13 ? a / b : op === 14 ? a - b * Math.floor(a / b)
        : op === 15 ? Math.pow(a, b) : op === 16 ? +(a < b) : op === 17 ? +(a <= b) : op === 18 ? +(a > b) : op === 19 ? +(a >= b) : op === 20 ? +(a === b) : +(a !== b);
    } else {
      const n = c[i++], f = op - 40;
      sp -= n;
      const a = s[sp], b = s[sp + 1], d = s[sp + 2];
      let r: number;
      switch (f) {
        case 0: r = Math.sin(a); break; case 1: r = Math.cos(a); break; case 2: r = Math.tan(a); break; case 3: r = Math.abs(a); break;
        case 4: r = Math.floor(a); break; case 5: r = Math.ceil(a); break; case 6: r = Math.round(a); break; case 7: r = a - Math.floor(a); break;
        case 8: r = Math.sqrt(a); break; case 9: r = Math.exp(a); break; case 10: r = Math.log(a); break; case 11: r = Math.sign(a); break;
        case 12: r = Math.min(a, b); break; case 13: r = Math.max(a, b); break; case 14: r = Math.pow(a, b); break; case 15: r = b < a ? 0 : 1; break;
        case 16: r = a - b * Math.floor(a / b); break; case 17: r = Math.min(Math.max(a, b), d); break; case 18: r = a + (b - a) * d; break;
        case 19: { const t = Math.min(1, Math.max(0, (d - a) / (b - a))); r = t * t * (3 - 2 * t); break; }
        case 20: { const lo = s[sp + 3], hi = s[sp + 4]; r = lo + ((a - b) / (d - b)) * (hi - lo); break; }
        case 21: r = env.lfo(a); break;
        case 23: r = env.value ? env.value(a) : 0; break;
        default: r = env.noise(a, n > 1 ? b : 0);
      }
      s[sp++] = r;
    }
  }
  const out = s[0];
  return Number.isFinite(out) ? out : 0;
}
