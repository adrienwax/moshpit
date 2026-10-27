// L6: identity is a UUID at every tier — definition, instance, parameter — and labels are
// presentation only. Branded strings keep a NodeId from being passed where a BlockId is wanted.

type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type BlockId = Brand<string, 'BlockId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type SourceId = Brand<string, 'SourceId'>;
export type ConformId = Brand<string, 'ConformId'>;
export type LfoId = Brand<string, 'LfoId'>;
export type ValueId = Brand<string, 'ValueId'>;
export type FreezeId = Brand<string, 'FreezeId'>;
export type ChapterId = Brand<string, 'ChapterId'>;
export type MarkId = Brand<string, 'MarkId'>;
/** An array element's own identity, so inserting an element never moves a binding (L6). */
export type ElementId = Brand<string, 'ElementId'>;
/** 3.2 Phase 3: a container definition in the project's components library. */
export type ComponentId = Brand<string, 'ComponentId'>;

/**
 * A node kind's stable key (`fx.rgb-split`). Identifies the *definition*; the definition's
 * meaning over time is its `defVersion` (L31), never a new key.
 */
export type NodeKind = Brand<string, 'NodeKind'>;
/**
 * A parameter's immutable key inside its definition (`amount`). Together with the instance's
 * NodeId it is the parameter's identity; the label shown in the UI can change freely.
 */
export type ParamKey = Brand<string, 'ParamKey'>;
/** A port's immutable key inside its definition (`in`, `mask`, `out`). */
export type PortKey = Brand<string, 'PortKey'>;

let idSource: () => string = () => globalThis.crypto.randomUUID();

/** Mint a new identity. Tests swap the source for a counter so snapshots are stable. */
export function newId<T extends string>(): T {
  return idSource() as T;
}

export function setIdSource(fn: () => string): void {
  idSource = fn;
}

export function resetIdSource(): void {
  idSource = () => globalThis.crypto.randomUUID();
}

export const kind = (s: string) => s as NodeKind;
export const pkey = (s: string) => s as ParamKey;
export const port = (s: string) => s as PortKey;
