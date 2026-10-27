/** One decoded frame in flight. Clock updates replace only pending work, never the frame
 * currently decoding; otherwise a 30 fps clock can starve a 25 ms decoder indefinitely. */
export function createPlaybackPump<T extends { image: { close(): void } }>(read: (time: number) => Promise<T | null>, show: (frame: T) => void, fail: (error: unknown) => void, initialDirection = 1) {
  let live = true, busy = false, pending: number | undefined, previous: number | undefined, epoch = 0, direction = Math.sign(initialDirection);
  const drain = async () => {
    if (!live || busy || pending === undefined) return;
    const time = pending, generation = epoch;
    pending = undefined; busy = true;
    try {
      const frame = await read(time);
      if (frame) {
        try { if (live && generation === epoch) show(frame); } finally { frame.image.close(); }
      }
    } catch (error) { if (live && generation === epoch) fail(error); }
    finally { busy = false; if (live && pending !== undefined) void drain(); }
  };
  return {
    request(time: number) {
      if (!live || !Number.isFinite(time) || time === previous) return;
      const step = previous === undefined ? 0 : time - previous, nextDirection = Math.sign(step);
      // A loop, reverse or deliberate seek must not publish an obsolete in-flight frame.
      if (previous !== undefined && (Math.abs(step) > 1 || (direction && nextDirection && direction !== nextDirection))) epoch++;
      if (nextDirection) direction = nextDirection;
      previous = time; pending = time; void drain();
    },
    stop() { live = false; pending = undefined; epoch++; },
  };
}
