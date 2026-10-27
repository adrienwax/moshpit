import snapshot from './registry.json';
import type { RegistrySnapshot } from './registry';
export * from './registry';
/** Immutable-by-contract generated metadata; consumers never write to this object. */
export const MOSHPIT_REGISTRY = snapshot as RegistrySnapshot;
