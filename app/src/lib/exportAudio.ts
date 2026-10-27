import type { ProjectDoc, SourceProbe } from '@moshpit/core';
import { blockFrames } from './timeline';

type Presence = 'present' | 'absent' | 'unknown';
function presence(probe: SourceProbe | undefined): Presence {
  // A missing/partial probe is not evidence of a silent source. This is saved metadata,
  // not a live availability check or a measurement of audible samples.
  if (!probe || !probe.codec || !Number.isFinite(probe.durationSec) || !(probe.width > 0) || !(probe.height > 0)) return 'unknown';
  if (probe.audio === undefined) return 'absent';
  return probe.audio && probe.audio.sampleRate > 0 && probe.audio.channels > 0 ? 'present' : 'unknown';
}

/** Source presence for the timeline range being exported; refs/library-only sources do not supply audio. */
export function exportAudioSummary(doc: ProjectDoc): { label: string; detail: string } {
  const sources = new Map(doc.resources.sources.map(s => [s.id, s]));
  const [start, end] = doc.exportConfig.range ?? [0, Infinity];
  let at = 0, clips = 0, present = 0, absent = 0, unknown = 0, unmuted = 0;
  try {
    for (const block of doc.timeline.blocks) {
      const frames = blockFrames(block), next = at + frames;
      if (!Number.isFinite(frames) || frames < 0) throw new Error('Unknown block span');
      if (frames > 0 && at <= end && next > start) {
        clips++;
        const state = presence(sources.get(block.sourceId)?.probe);
        if (state === 'present') { present++; if (!block.audio?.mute) unmuted++; }
        else if (state === 'absent') absent++;
        else unknown++;
      }
      at = next;
    }
  } catch {
    return { label: 'Source audio unknown', detail: 'The export range could not be resolved. Audio availability has not been confirmed.' };
  }
  if (!clips) return { label: 'No clips in range', detail: 'Add clips to the timeline or choose a range containing clips.' };
  if (unknown) return { label: present ? 'Some audio unknown' : 'Source audio unknown', detail: 'Some clips in this export range have missing or incomplete audio metadata. Presence does not confirm audible sound.' };
  if (!present) return { label: 'No source audio', detail: 'Saved probes report no audio track for these clips. Audio On writes a silent track; Off omits it.' };
  if (!unmuted) return { label: 'Source audio · muted', detail: 'All clips with audio in this export range are muted. Audio On still writes a track.' };
  return { label: absent ? 'Mixed source audio' : 'Source audio present', detail: 'Saved probes report audio tracks in this export range. Muted clips and clips without audio contribute timed silence; presence does not confirm audible sound.' };
}
