// Portable saved looks reuse LookFile v1. Project controls are intentionally not bundled.
import { MoshpitError, newId, type ComponentDef, type NodeInstance } from '@moshpit/core';
import { parse } from '../control/expr';
import { compileBlockGraph } from '../graph/stage2';
import { DEF_BY_KIND } from '../nodes/defs';
import { newEdge, newNode } from './build';
import { lookFile, stampLook, validateLook } from './looks';

export const LOOK_MAX_BYTES = 4 * 1024 * 1024;
export const LOOK_EXTENSION = '.moshlook.json';
export function lookProblem(why: string): never { throw new MoshpitError('RECIPE_INVALID', { why }, undefined, why); }
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);

function expressionUsesProject(n: ReturnType<typeof parse>): boolean {
  switch (n.k) {
    case 'call': return n.f === 'lfo' || n.f === 'value' || n.args.some(expressionUsesProject);
    case 'un': return expressionUsesProject(n.a);
    case 'bin': return expressionUsesProject(n.a) || expressionUsesProject(n.b);
    case 'tern': return expressionUsesProject(n.c) || expressionUsesProject(n.a) || expressionUsesProject(n.b);
    default: return false;
  }
}

/** Check recursively before one-level validation, so hidden project links are never discarded. */
function checkBindings(body: unknown, depth = 0): void {
  if (depth > 16) lookProblem('This look is nested too deeply. Unpack its inner containers first.');
  if (!record(body) || !record(body.graph) || !Array.isArray(body.graph.nodes)) lookProblem('This look has no readable node graph.');
  for (const node of body.graph.nodes) {
    if (!record(node)) lookProblem('This look contains an invalid node.');
    if (node.bindings !== undefined && !record(node.bindings)) lookProblem('This look has invalid parameter bindings.');
    for (const binding of Object.values(node.bindings ?? {})) {
      if (!record(binding)) lookProblem('This look has an invalid parameter binding.');
      if (binding.lfo || binding.value) lookProblem('This look uses a project LFO or Value. Remove those bindings in a copy, then save that copy as a look before exporting.');
      if (binding.expression) {
        if (!record(binding.expression) || typeof binding.expression.source !== 'string') lookProblem('This look has an invalid expression.');
        const tree = parse(binding.expression.source);
        if (expressionUsesProject(tree)) lookProblem('This look uses lfo() or value() from its project. Replace those expression references in a copy before exporting.');
      }
    }
    if (node.body) checkBindings(node.body, depth + 1);
  }
}

/** Strict boundary around the older tolerant reader: never silently drop broken wires/macros. */
export function parsePortableLook(text: string): ComponentDef {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > LOOK_MAX_BYTES) lookProblem('Look files must be no larger than 4 MB.');
  let raw: any;
  try { raw = JSON.parse(text); } catch { return lookProblem('This file is not valid JSON. Choose a Moshpit .moshlook.json file.'); }
  if (!record(raw) || raw.schema !== 'moshpit.look' || raw.version !== 1 || !record(raw.look)) lookProblem('This is not a supported Moshpit look v1 file. Older macro-only recipes need to be recreated as saved looks.');
  const body = raw.look.body;
  for (const key of ['name', 'look', 'does']) if (raw.look[key] !== undefined && typeof raw.look[key] !== 'string') lookProblem('This look has invalid descriptive text.');
  checkBindings(body);
  if (!record(body.ports) || !Array.isArray(body.ports.in) || !Array.isArray(body.ports.out) || !Array.isArray(body.graph.edges) || !Array.isArray(body.macros)) lookProblem('This look has invalid ports, wires or macros.');
  if (body.graph.nodes.length > 1024 || body.graph.edges.length > 4096) lookProblem('This look is too large (1024 nodes and 4096 wires maximum).');
  const nodes = body.graph.nodes as NodeInstance[];
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) lookProblem('This look has duplicate node identities. Re-save it from its original project.');
  const reserved = new Set(['__proto__', 'prototype', 'constructor']);
  for (const node of nodes) {
    const def = DEF_BY_KIND.get(node.kind);
    if (!def || node.defVersion !== def.defVersion) lookProblem(`This look uses an unavailable or older node (${node.kind}). Update or migrate it in its original project first.`);
    if (node.params !== undefined && !record(node.params)) lookProblem('This look has invalid parameter values.');
    if (node.label !== undefined && typeof node.label !== 'string') lookProblem('This look has an invalid node label.');
    if (node.bypass !== undefined && typeof node.bypass !== 'boolean') lookProblem('This look has an invalid bypass state.');
    if (node.position !== undefined && (!record(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))) lookProblem('This look has an invalid node position.');
    for (const p of def.params) {
      const v = node.params?.[p.key];
      if (v === undefined) continue;
      if (['float', 'int', 'beats'].includes(p.type) && (typeof v !== 'number' || !Number.isFinite(v))) lookProblem(`This look has an invalid number for ${p.label}.`);
      if (p.type === 'bool' && typeof v !== 'boolean') lookProblem(`This look has an invalid switch for ${p.label}.`);
      if (p.type === 'enum' && typeof v !== 'string') lookProblem(`This look has an invalid choice for ${p.label}.`);
    }
    for (const [key, binding] of Object.entries(node.bindings ?? {})) {
      if (!def.params.some(p => p.key === key) || reserved.has(key)) lookProblem('This look binds a missing parameter.');
      if (binding.expression && !['replace', 'add', 'multiply'].includes(binding.expression.op)) lookProblem('This look has an invalid expression operation.');
    }
  }
  if (new Set(body.graph.edges.map((e: any) => e?.id)).size !== body.graph.edges.length || body.graph.edges.some((e: any) => typeof e?.id !== 'string' || typeof e.from?.port !== 'string' || typeof e.to?.port !== 'string')) lookProblem('This look has invalid or duplicate wire identities.');
  for (const node of nodes) if (node.inputOrder !== undefined) {
    if (!record(node.inputOrder)) lookProblem('This look has an invalid input order.');
    for (const [port, order] of Object.entries(node.inputOrder)) if (!Array.isArray(order) || new Set(order).size !== order.length || order.some(id => !body.graph.edges.some((e: any) => e.id === id && e.to.node === node.id && e.to.port === port))) lookProblem('This look has an input order pointing at missing wires.');
  }
  for (const dir of ['in', 'out']) for (const p of body.ports[dir]) if (!record(p) || typeof p.key !== 'string' || typeof p.type !== 'string' || typeof p.label !== 'string') lookProblem('This look has an invalid port.');
  if (body.macros.some((m: any) => !record(m) || typeof m.key !== 'string' || reserved.has(m.key)) || new Set(body.macros.map((m: any) => m.key)).size !== body.macros.length) lookProblem('This look has invalid or duplicate macro keys.');
  const look = validateLook(raw);
  if (look.body.graph.edges.length !== body.graph.edges.length || look.body.macros.length !== body.macros.length) lookProblem('This look contains broken wires or macros. Repair them in its original project first.');
  for (const macro of look.body.macros) {
    const target = nodes.find(n => n.id === macro.target.node);
    const param = target && DEF_BY_KIND.get(target.kind)?.params.find(p => p.key === macro.target.param);
    if (!param || !['int', 'float'].includes(param.type)) lookProblem('This look has a macro pointing at a missing or non-numeric parameter.');
    if (macro.help !== undefined && typeof macro.help !== 'string') lookProblem('This look has invalid macro help text.');
    if (macro.map && (!Number.isFinite(macro.map.from) || !Number.isFinite(macro.map.to) || !['linear', 'ease-in', 'ease-out', 'smooth'].includes(macro.map.curve))) lookProblem('This look has an invalid macro range mapping.');
  }
  const ins = look.body.ports.in, outs = look.body.ports.out;
  if (ins.length !== 1 || outs.length !== 1 || !['VideoFrame', 'EncodedVideoStream'].includes(ins[0].type) || !['VideoFrame', 'EncodedVideoStream'].includes(outs[0].type) || (ins[0].type === 'VideoFrame' && outs[0].type === 'EncodedVideoStream')) lookProblem('Portable looks need one video input and one video output. Save a complete effect chain as a look.');
  const box = stampLook(look, { x: 0, y: 0 }), src = newNode('source.clip'), dec = newNode('decode.webcodecs'), out = newNode('output.sink');
  const before = ins[0].type === 'VideoFrame' ? [src, dec] : [src];
  const after = outs[0].type === 'EncodedVideoStream' ? [dec, out] : [out];
  const chain = [...before, box, ...after];
  const graph = { nodes: chain, edges: chain.slice(1).map((n, i) => newEdge(chain[i].id, n.id, chain[i] === box ? outs[0].key : 'out', n === box ? ins[0].key : 'in')) };
  const plan = compileBlockGraph(newId(), graph);
  if (!plan.ok) lookProblem(`This look cannot compile: ${plan.errors[0]?.humanMessage ?? 'check its wiring in the original project'}`);
  return look;
}

export function serializePortableLook(look: ComponentDef): string {
  const text = JSON.stringify(lookFile(look), null, 2) + '\n';
  // Use exactly the same boundary on export as import; never export a misleading partial look.
  parsePortableLook(text);
  return text;
}
