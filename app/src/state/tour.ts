// The light tour (3.2): six one-line steps of the core loop, each shown in its own workspace, in
// order, until it is dismissed. Remembered in settings (seen steps, skipped, done); the "?" in the
// top bar replays it. Not a guided tour: no overlay, no blocking, one small card at a time.
import { setSettings, settingsStore, type WsId } from './ui';

/** `over`: a picture area (no controls in it) the card sits inside, top-right; else the bottom-right corner. */
export interface TourStep { id: string; ws: WsId; title: string; text: string; over?: string }

export const TOUR: TourStep[] = [
  { id: 'mark', over: 'section[aria-label="Preview & slice"] .pbody', ws: 'browse', title: 'Pick and mark', text: 'Click a clip, scrub it, and press I and O to mark the part you want.' },
  { id: 'send', over: 'section[aria-label="Preview & slice"] .pbody', ws: 'browse', title: 'Send it to A or B', text: 'Send the marked part to slot A or B, or straight to the arrangement as a block.' },
  { id: 'look', over: '.program', ws: 'mosh', title: 'Add a look', text: 'Select a block and open ＋ Add effect: a look arrives as a container with its own knobs.' },
  { id: 'audition', over: '.program', ws: 'mosh', title: 'Audition first', text: 'Select a look in the browser to see it on the Program before you apply it.' },
  { id: 'preview', over: '.program', ws: 'mosh', title: 'Preview', text: 'Space plays the arrangement. Bypass on a look A/Bs it in place.' },
  { id: 'render', ws: 'render', title: 'Render', text: 'Pick a preset and Render. MP4 is for sharing, HAP for VJ playback, ProRes for editing, and PNG for image sequences.' },
];

export interface TourState { seen: string[]; skipped: boolean; offered: boolean }

/** The step to show in `ws`: the first unseen step overall, if it belongs to this workspace. */
export function stepFor(t: TourState, ws: WsId): TourStep | null {
  if (t.skipped || !t.offered) return null;
  const next = TOUR.find((s) => !t.seen.includes(s.id));
  return next && next.ws === ws ? next : null;
}

export const markSeen = (id: string) => setSettings((s) => void (s.tour = { ...s.tour, seen: [...new Set([...s.tour.seen, id])] }));
export const skipTour = () => setSettings((s) => void (s.tour = { ...s.tour, offered: true, skipped: true }));
/** Start (or replay, from "?"): every step unseen again, from the first. */
export const startTour = () => setSettings((s) => void (s.tour = { seen: [], skipped: false, offered: true }));
