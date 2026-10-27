import { describe, expect, it } from 'vitest';
import { demoProject } from '../src/engine/mockProject';
import { exportAudioSummary } from '../src/lib/exportAudio';
import { blockFrames } from '../src/lib/timeline';

function fixture() {
  const d = structuredClone(demoProject());
  d.timeline.blocks = [d.timeline.blocks[0], d.timeline.blocks.at(-1)!];
  d.timeline.blocks[1].sourceId = d.resources.sources[1].id;
  return d;
}
describe('export audio metadata summary', () => {
  it('reports absence only from known probes for referenced timeline sources', () => {
    const d = fixture();
    for (const s of d.resources.sources) delete s.probe.audio;
    d.resources.sources.push(structuredClone(demoProject().resources.sources[0])); // unused audible library entry
    d.resources.sources.at(-1)!.id = 'unused' as never;
    expect(exportAudioSummary(d).label).toBe('No source audio');
    expect(exportAudioSummary(d).detail).toContain('silent track');
  });
  it('does not confuse missing sources or partial probes with absent audio', () => {
    const d = fixture();
    d.resources.sources = [];
    expect(exportAudioSummary(d).label).toBe('Source audio unknown');
    d.resources.sources = structuredClone(demoProject().resources.sources);
    d.resources.sources[1].probe = {} as never;
    expect(exportAudioSummary(d).label).toBe('Some audio unknown');
  });
  it('distinguishes presence, mixed sources and all audio muted, without claiming audibility', () => {
    const d = fixture();
    expect(exportAudioSummary(d).label).toBe('Source audio present');
    delete d.resources.sources[1].probe.audio;
    expect(exportAudioSummary(d).label).toBe('Mixed source audio');
    d.timeline.blocks[0].audio.mute = true;
    expect(exportAudioSummary(d).label).toBe('Source audio · muted');
  });
  it('uses inclusive export bounds and actual repeated block lengths', () => {
    const d = fixture();
    d.timeline.blocks[0].repeat = 3;
    delete d.resources.sources[1].probe.audio;
    const boundary = blockFrames(d.timeline.blocks[0]);
    d.exportConfig.range = [boundary, boundary];
    expect(exportAudioSummary(d).label).toBe('No source audio');
    d.exportConfig.range = [boundary - 1, boundary];
    expect(exportAudioSummary(d).label).toBe('Mixed source audio');
  });
  it('keeps empty ranges and empty timelines distinct from known absence', () => {
    const d = fixture();
    d.exportConfig.range = [100000, 100001];
    expect(exportAudioSummary(d).label).toBe('No clips in range');
    d.timeline.blocks = [];
    expect(exportAudioSummary(d).label).toBe('No clips in range');
  });
  it('does not change export settings or infer presence from secondary visual references', () => {
    const d = fixture();
    d.timeline.blocks = [d.timeline.blocks[0]];
    delete d.resources.sources[0].probe.audio;
    d.timeline.blocks[0].refs = [d.resources.sources[1].id];
    const before = JSON.stringify(d);
    expect(exportAudioSummary(d).label).toBe('No source audio');
    expect(JSON.stringify(d)).toBe(before);
    d.exportConfig.audio = false;
    expect(exportAudioSummary(d).label).toBe('No source audio');
  });
});
