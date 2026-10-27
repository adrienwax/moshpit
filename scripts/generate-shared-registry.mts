import fs from 'node:fs';
import { createHash } from 'node:crypto';
/** Build/test-time only. Regenerate via UPDATE_SHARED_REGISTRY=1 managed registry tests. */
import { NODE_DEFS, isPlaceable } from '../engine/src/nodes/defs';
import { CURRENT_VERSIONS } from '../core/src/project';
import type { RegistrySnapshot } from '../shared/graph/registry';
export function generateSharedRegistry(): RegistrySnapshot {
  return JSON.parse(JSON.stringify({ schemaVersion: 1,
    sourceCommit: 'b4817ee48e946da617492da3bf23b0290c62ab4f', sectionVersions: CURRENT_VERSIONS,
    definitions: NODE_DEFS.map(d => ({ kind: d.kind, defVersion: d.defVersion, label: d.label,
      blurb: d.blurb, category: d.category, family: d.family, inputs: d.inputs, outputs: d.outputs,
      params: d.params, impl: d.impl, freezable: d.freezable, creationEligible: isPlaceable(d) })) }));
}

/** Source hashes identify inputs; this is not a seal of the consumer's executable toolchain. */
export function generateRegistryManifest(registry = generateSharedRegistry()) {
  const paths = ['core/src/nodedef.ts', 'core/src/project.ts', 'core/src/ids.ts', 'engine/src/nodes/defs.ts',
    'engine/src/nodes/ops/spec.ts', 'engine/src/nodes/ops/stateless.ts', 'engine/src/nodes/ops/temporal.ts',
    'engine/src/nodes/ops/bitstream.ts', 'engine/src/project/io.ts'];
  const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  return { schemaVersion: 1, sourceCommit: registry.sourceCommit,
    registrySha256: sha256(JSON.stringify(registry, null, 2) + '\n'),
    sectionVersions: registry.sectionVersions,
    definitions: registry.definitions.map(d => ({ kind: d.kind, defVersion: d.defVersion, creationEligible: d.creationEligible })),
    canonicalInputs: Object.fromEntries(paths.map(p => [p, sha256(fs.readFileSync(p))])),
    ioCompatibility: { status: 'requires-consumer-fixture-receipt', expectedSourceCommit: registry.sourceCommit,
      note: 'Section versions and source hashes alone do not prove cross-revision IO or raw-byte export compatibility.' },
    toolchain: 'Consumer must separately seal and verify every executed bootstrap/build input before execution.' };
}
