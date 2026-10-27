// Node registry seed: every engine definition, as the worker's nodeDefs() returns them (it replaces
// this at boot under the real engine; the mock and the tests use it as is). What a user may place
// is filtered where nodes are offered (isPlaceable), not here, so defOf() knows Source and Output.
import type { NodeDef } from '@moshpit/engine';
import { NODE_DEFS, canWire } from '@moshpit/engine';

export const CATALOG: NodeDef[] = [...NODE_DEFS];

/** Socket-level type check (L19), shared by connect and the radial's socket-drag filter. */
export const compatible = (from: string, to: string) => canWire(from as never, to as never).ok;
