/** Renderer-only contracts: no runtime, IO, normalization or evaluation. */
export interface PortDescriptor {
  key: string; label: string; type: string; subtype?: string;
  cardinality?: string; disconnected?: string; help?: string; available?: boolean;
}
export interface ParamDescriptor {
  key: string; label: string; type: string; help?: string; default: unknown; initial?: unknown;
  min?: number; max?: number; step?: number; options?: readonly string[]; unit?: string;
  onNode?: boolean; ctOrder?: number; modulatable?: boolean;
}
export interface DefinitionDescriptor {
  kind: string; defVersion: number; label: string; blurb: string; category: string; family?: string;
  inputs: readonly PortDescriptor[]; outputs: readonly PortDescriptor[]; params: readonly ParamDescriptor[];
  impl: { preview: string; export: string }; freezable: boolean;
  /** Manual library placement, independent from saved compatibility/runtime availability. */
  creationEligible: boolean;
}
export interface RegistrySnapshot {
  schemaVersion: 1; sourceCommit: string; sectionVersions: Record<string, number>;
  definitions: readonly DefinitionDescriptor[];
}
export interface NodeLike {
  id: string; kind: string; defVersion: number; label?: string; bypass?: boolean; position?: { x: number; y: number };
  params: Record<string, unknown>; bindings?: Record<string, unknown>; body?: ContainerLike;
}
export interface MacroLike {
  key: string; label: string; help: string; min: number; max: number; default: number;
  target: { node: string; param: string }; map?: { from: number; to: number; curve?: string };
}
export interface ContainerLike {
  graph: { nodes: readonly NodeLike[]; edges: readonly unknown[] };
  ports: { in: readonly PortDescriptor[]; out: readonly PortDescriptor[] }; macros: readonly MacroLike[];
}
export type Availability = { available: true; value: unknown } | { available: false; reason: string };
export interface ParameterPresentation {
  spec: ParamDescriptor; hasStored: boolean; storedValue: unknown; base: Availability; effective: Availability;
  compatibilityDefault: unknown; hasInitial: boolean; initial: unknown; reset: Availability;
  resetSource: 'initial' | 'compatibility-default' | 'authored-macro'; driver: unknown;
  supported: boolean; diagnostics: string[]; authoredMacroDefault?: unknown;
}
export interface NodePresentation {
  id: string; kind: string; label: string; definition?: DefinitionDescriptor;
  status: 'supported' | 'legacy' | 'future' | 'unknown'; readOnly: boolean; diagnostics: string[];
  inputs: readonly PortDescriptor[]; outputs: readonly PortDescriptor[]; parameters: ParameterPresentation[];
  rawParams: Record<string, unknown>; unknownParams: Record<string, unknown>;
  bypassed: boolean; isContainer: boolean; containerSummary?: { count: number; labels: string[] };
}
export interface ResolveOptions { body?: ContainerLike; effectiveValues?: Record<string, Availability> }
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const unavailable = (reason: string): Availability => ({ available: false, reason });
const available = (value: unknown): Availability => ({ available: true, value });
const supportedTypes = new Set(['float', 'int', 'bool', 'enum', 'beats']);
function valid(spec: ParamDescriptor, value: unknown): boolean {
  if (spec.type === 'bool') return typeof value === 'boolean';
  if (spec.type === 'enum') return typeof value === 'string' && !!spec.options?.includes(value);
  if (!supportedTypes.has(spec.type) || typeof value !== 'number' || !Number.isFinite(value)) return false;
  return (spec.type !== 'int' || Number.isInteger(value)) && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);
}
function parameter(spec: ParamDescriptor, node: NodeLike, opts: ResolveOptions, authoredReset?: Availability): ParameterPresentation {
  const hasStored = own(node.params, spec.key), storedValue = node.params[spec.key];
  const supported = supportedTypes.has(spec.type), hasInitial = own(spec, 'initial');
  const rawBase = hasStored ? storedValue : spec.default;
  const base = !supported ? unavailable('Unsupported parameter type') : valid(spec, rawBase) ? available(rawBase) : unavailable(hasStored ? 'Invalid stored value' : 'Invalid compatibility default');
  const driver = node.bindings?.[spec.key];
  const driven = driver !== undefined && (driver === null || typeof driver !== 'object' || Object.keys(driver).length > 0);
  const supplied = opts.effectiveValues && own(opts.effectiveValues, spec.key) ? opts.effectiveValues[spec.key] : undefined;
  const effective = !base.available ? base : supplied ? (supplied.available && !valid(spec, supplied.value) ? unavailable('Invalid supplied effective value') : supplied) : driven ? unavailable('Binding requires evaluation context') : base;
  const resetValue = hasInitial ? spec.initial : spec.default;
  const reset = authoredReset ?? (supported && valid(spec, resetValue) ? available(resetValue) : unavailable('Reset value unavailable'));
  return { spec, hasStored, storedValue, base, effective, compatibilityDefault: spec.default, hasInitial, initial: spec.initial, reset,
    resetSource: authoredReset ? 'authored-macro' : hasInitial ? 'initial' : 'compatibility-default', driver, supported,
    diagnostics: base.available ? [] : [base.reason] };
}
function authoredMacro(node: NodeLike, m: MacroLike): Availability {
  if (![m.min, m.max, m.default].every(Number.isFinite) || m.max < m.min) return unavailable('Malformed macro range');
  const inner = node.body?.graph.nodes.find(n => n.id === m.target.node);
  if (!inner) return unavailable('Macro target node unavailable');
  const v = inner.params[m.target.param];
  if (typeof v !== 'number') return available(m.default); // canonical authoredAt fallback
  if (!Number.isFinite(v)) return unavailable('Invalid authored target');
  if (m.map && ![m.map.from, m.map.to].every(Number.isFinite)) return unavailable('Invalid macro map');
  const t = m.map ? (m.map.to === m.map.from ? 0 : (v - m.map.from) / (m.map.to - m.map.from)) : (v - m.min) / (m.max - m.min || 1);
  return available(m.min + Math.min(1, Math.max(0, t)) * (m.max - m.min));
}
/** Exact version only. Legacy/future definitions are not interpreted using current metadata. */
export function resolveNodePresentation(registry: RegistrySnapshot, node: NodeLike, opts: ResolveOptions = {}): NodePresentation {
  const matches = registry.definitions.filter(d => d.kind === node.kind);
  const definition = matches.find(d => d.defVersion === node.defVersion);
  const status = definition ? 'supported' : !matches.length ? 'unknown' : node.defVersion < Math.max(...matches.map(d => d.defVersion)) ? 'legacy' : 'future';
  const diagnostics: string[] = definition ? [] : ['Unsupported ' + status + ' definition ' + node.kind + '@' + node.defVersion];
  let inputs: readonly PortDescriptor[] = definition?.inputs ?? [], outputs: readonly PortDescriptor[] = definition?.outputs ?? [];
  let parameters = definition?.params.map(p => parameter(p, node, opts)) ?? [];
  const isContainer = node.kind === 'group.container';
  const body = isContainer ? node.body : opts.body;
  if (isContainer || node.kind === 'group.in' || node.kind === 'group.out') {
    if (!body || !Array.isArray(body.ports?.in) || !Array.isArray(body.ports?.out) || !Array.isArray(body.graph?.nodes) || !Array.isArray(body.macros) || !body.graph.nodes.every(n => n && typeof n.id === 'string' && typeof n.kind === 'string' && n.params && typeof n.params === 'object') || ![...body.ports.in, ...body.ports.out].every(p => p && typeof p.key === 'string' && typeof p.label === 'string' && typeof p.type === 'string') || !body.macros.every(m => m && typeof m.key === 'string' && m.target && typeof m.target.node === 'string' && typeof m.target.param === 'string')) {
      diagnostics.push('Container interface unavailable or malformed');
    } else {
      for (const dir of ['in', 'out'] as const) if (new Set(body.ports[dir].map(p => p.key)).size !== body.ports[dir].length) diagnostics.push('Duplicate saved ' + dir + ' port key'); const ports = (list: readonly PortDescriptor[]) => list.map(p => ({ ...p, cardinality: 'required-one' }));
      inputs = isContainer ? ports(body.ports.in) : node.kind === 'group.out' ? ports(body.ports.out) : [];
      outputs = isContainer ? ports(body.ports.out) : node.kind === 'group.in' ? ports(body.ports.in) : [];
      if (body.graph.nodes.some(n => n.kind === 'group.container')) diagnostics.push('Nested containers are unsupported');
      if (isContainer && definition) parameters = body.macros.map((m, i) => {
        const reset = authoredMacro(node, m);
        const spec: ParamDescriptor = { key: m.key, label: m.label, help: m.help, type: 'float', default: reset.available ? reset.value : m.default,
          min: m.min, max: m.max, step: (m.max - m.min) / 100, onNode: true, ...(i < 6 ? { ctOrder: i + 1 } : {}) };
        const result = parameter(spec, node, opts, reset);
        result.authoredMacroDefault = m.default; if (!reset.available) diagnostics.push(m.key + ': ' + reset.reason);
        return result;
      });
    }
  }
  const keys = new Set(parameters.map(p => p.spec.key));
  const inner = isContainer && Array.isArray(body?.graph?.nodes) ? body.graph.nodes
    .filter(n => n && typeof n.kind === 'string' && n.kind !== 'group.in' && n.kind !== 'group.out')
    .slice().sort((a, b) => (Number.isFinite(a.position?.x) ? a.position!.x : 0) - (Number.isFinite(b.position?.x) ? b.position!.x : 0)) : undefined;
  return { id: node.id, kind: node.kind, label: node.label ?? definition?.label ?? node.kind, definition, status,
    readOnly: !definition || diagnostics.length > 0, diagnostics, inputs, outputs, parameters,
    rawParams: node.params, unknownParams: Object.fromEntries(Object.entries(node.params).filter(([k]) => !keys.has(k))),
    bypassed: node.bypass === true, isContainer,
    ...(inner ? { containerSummary: { count: inner.length, labels: inner.map(n => n.label ?? registry.definitions.find(d => d.kind === n.kind && d.defVersion === n.defVersion)?.label ?? n.kind) } } : {}) };
}
/** Receipt asserts tested facts, never infers cross-revision IO compatibility. */
export interface CompatibilityReceipt {
  registrySourceCommit: string; ioSourceCommit: string; sectionVersions: Record<string, number>;
  definitions: readonly { kind: string; defVersion: number }[]; fixtureEvidence: readonly string[];
}
export function compatibilityProblems(registry: RegistrySnapshot, receipt: CompatibilityReceipt): string[] {
  const issues: string[] = [];
  if (registry.sourceCommit !== receipt.registrySourceCommit) issues.push('Registry source pin differs');
  if (!receipt.ioSourceCommit || !receipt.fixtureEvidence.length) issues.push('IO compatibility has no tested evidence');
  const sorted = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  if (sorted(registry.sectionVersions) !== sorted(receipt.sectionVersions)) issues.push('Project section versions differ');
  const defs = (d: readonly { kind: string; defVersion: number }[]) => JSON.stringify(d.map(x => x.kind + '@' + x.defVersion).sort());
  if (defs(registry.definitions) !== defs(receipt.definitions)) issues.push('Definition version sets differ');
  return issues;
}


