// The light tour's one card (3.2). First run: offer the steps on Home, or skip.
// Then, once started: the next unseen step of the core loop, in its own workspace, until dismissed.
import { useEffect, useState, type CSSProperties } from 'react';
import { useSettings, useUi } from '../state/ui';
import { TOUR, markSeen, skipTour, startTour, stepFor } from '../state/tour';

export function TourLayer() {
  const ws = useUi((s) => s.ws);
  const tour = useSettings((s) => s.tour);
  const offer = !tour.offered && ws === 'home';
  const step = stepFor(tour, ws);
  const at = useInside(offer ? '.hsys' : step?.over); // Home's machine readout: no controls there
  if (offer) {
    return (
      <aside className="tourcard offer" style={at} role="dialog" aria-label="Get started">
        <b>Find your way around</b>
        <p>Take a short tour of the workspaces. To try a ready-made sequence, Starter Mosh is always available in Home and IN.</p>
        <div className="tourbtns">
          <button className="pop" onClick={() => startTour()}>Show me around</button>
          <button className="ghostbtn" onClick={() => skipTour()}>Skip, don't show again</button>
        </div>
      </aside>
    );
  }
  if (!step) return null;
  const n = TOUR.indexOf(step) + 1;
  return (
    <aside className="tourcard" style={at} role="note" aria-label="Tour step">
      <span className="tourn">{n} / {TOUR.length}</span>
      <b>{step.title}</b>
      <p>{step.text}</p>
      <div className="tourbtns">
        <button className="ghostbtn" onClick={() => markSeen(step.id)}>Got it</button>
        <button className="linkbtn" onClick={() => skipTour()}>Skip the tour</button>
      </div>
    </aside>
  );
}

/** Bug hunt #9: the bottom-right corner holds controls in IN and MOSH. Sit inside `sel` (a picture,
 *  no controls in it), top-right; not on screen (yet): the CSS corner. Re-queried every 250 ms, since
 *  the picture can mount after the card, be replaced, or move as panes resize. */
function useInside(sel: string | undefined): CSSProperties | undefined {
  const [at, setAt] = useState<{ top: number; right: number }>();
  useEffect(() => {
    const place = () => {
      const r = sel ? document.querySelector(sel)?.getBoundingClientRect() : undefined;
      const next = r && r.width > 0 ? { top: Math.round(r.top + 12), right: Math.round(window.innerWidth - r.right + 12) } : undefined;
      setAt((p) => (p?.top === next?.top && p?.right === next?.right ? p : next));
    };
    place();
    const t = setInterval(place, 250); // ponytail: a poll, not observers; one rect read per tick
    return () => clearInterval(t);
  }, [sel]);
  return at && { ...at, bottom: 'auto' };
}
