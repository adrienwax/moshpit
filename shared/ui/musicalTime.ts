// L23: musical time is the default unit. A `beats` param stores beats; the UI snaps it to
// these divisions and can show it in seconds (♪⇄s) at the project BPM.
export const MUSDIV = [
  { lab: '1/16', beats: 0.25 },
  { lab: '1/8', beats: 0.5 },
  { lab: '1/4', beats: 1 },
  { lab: '1/2', beats: 2 },
  { lab: '1 bar', beats: 4 },
  { lab: '2 bars', beats: 8 },
  { lab: '4 bars', beats: 16 },
  { lab: '8 bars', beats: 32 },
] as const;

export const beatsToSec = (beats: number, bpm: number) => (beats * 60) / bpm;

export function fmtBeats(beats: number, bpm: number, seconds: boolean): string {
  if (seconds) return beatsToSec(beats, bpm).toFixed(2) + ' s';
  const d = MUSDIV.find((m) => m.beats === beats);
  if (d) return d.lab;
  return beats >= 4 ? `${+(beats / 4).toFixed(2)} bars` : `${beats} beats`;
}

