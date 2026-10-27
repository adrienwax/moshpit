// L11: seeded randomness and fingerprints, ported from the spike. No Math.random anywhere in the
// engine; every random value is f(projectSeed, nodeInstance, param, frame, userSeed).
//
// Hot-path rule (L21, measured in the spike): a non-Smi double that crosses a non-inlined call
// boundary is boxed into a fresh HeapNumber. Per-frame helpers therefore write into a typed-array
// slot and return Smi 0 when given one.

export function mix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function seeded(projectSeed: number, instanceHash: number, paramHash: number, frame: number, userSeed: number, out?: Float32Array): number {
  let h = mix32(projectSeed ^ 0x9e3779b9);
  h = mix32(h ^ instanceHash); h = mix32(h ^ paramHash); h = mix32(h ^ frame); h = mix32(h ^ userSeed);
  if (out) { out[0] = h / 4294967296; return 0; }
  return h / 4294967296;
}

/** cyrb53 over 32-bit words: the per-frame fingerprint. Writes into out[idx] when given (no boxing). */
export function hash53(words: Uint32Array, out?: Float64Array, idx = 0): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < words.length; i++) {
    const c = words[i];
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  if (out) { out[idx] = h; return 0; }
  return h;
}

/** A 30-bit hash of a string: small enough to stay a Smi when passed per frame. */
export function hash30(s: string): number {
  const b = new TextEncoder().encode(s);
  const w = new Uint32Array(Math.ceil(b.length / 4));
  new Uint8Array(w.buffer).set(b);
  return hash53(w) % 0x40000000;
}

/** Canonical JSON: keys sorted at every level, so a hash of a value never depends on insertion order. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`).join(',')}}`;
}
