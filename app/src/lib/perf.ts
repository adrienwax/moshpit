// Phase 0.1a: the main-thread probe. While running, it records every frame interval (rAF) and every
// long task (the browser's own >50 ms report), so "the UI never freezes" is a number, not a feel.
// Off by default; the perf e2e starts and stops it around one interaction.
//   window.__moshpitPerf.start()  …interact…  window.__moshpitPerf.stop() → PerfSummary

export interface PerfSummary {
  ms: number;
  frames: number;
  /** Frame interval percentiles, ms (16.7 at 60 Hz). */
  p50: number;
  p95: number;
  maxFrame: number;
  /** Intervals over 34 ms: at least one frame missed. */
  janks: number;
  longTasks: number;
  longTaskMs: number;
  maxLongTask: number;
}

let running = false;
let t0 = 0, last = 0, raf = 0;
let frames: number[] = [];
let longs: number[] = [];

try {
  new PerformanceObserver((list) => {
    if (running) for (const e of list.getEntries()) longs.push(e.duration);
  }).observe({ type: 'longtask', buffered: false });
} catch {
  /* no long-task timing here (a non-Chromium dev browser): frames still measure */
}

function tick(t: number) {
  if (!running) return;
  if (last) frames.push(t - last);
  last = t;
  raf = requestAnimationFrame(tick);
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

export const perf = {
  start() {
    frames = [];
    longs = [];
    last = 0;
    t0 = performance.now();
    running = true;
    raf = requestAnimationFrame(tick);
  },
  stop(): PerfSummary {
    running = false;
    cancelAnimationFrame(raf);
    return {
      ms: r1(performance.now() - t0),
      frames: frames.length,
      p50: r1(pct(frames, 0.5)),
      p95: r1(pct(frames, 0.95)),
      maxFrame: r1(Math.max(0, ...frames)),
      janks: frames.filter((f) => f > 34).length,
      longTasks: longs.length,
      longTaskMs: r1(longs.reduce((a, b) => a + b, 0)),
      maxLongTask: r1(Math.max(0, ...longs)),
    };
  },
};

if (typeof window !== 'undefined') Object.assign(window, { __moshpitPerf: perf });
