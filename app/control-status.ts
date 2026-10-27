/** Local host readiness only; neither bridge presence nor listening proves a device is attached. */
export type ControlHostStatus = 'unknown' | 'disabled' | 'starting' | 'listening' | 'unavailable';
export interface ControlStatusBridge {
  hostStatus?(): Promise<unknown>;
  onHostStatus?(fn: (status: unknown) => void): () => void;
}
export const parseControlHostStatus = (value: unknown): ControlHostStatus =>
  value === 'disabled' || value === 'starting' || value === 'listening' || value === 'unavailable' ? value : 'unknown';

export const CONTROL_HOST_LABELS: Record<ControlHostStatus, { short: string; detail: string; ready: boolean }> = {
  unknown: { short: 'CT unknown', detail: 'CT server status unknown; device status unknown', ready: false },
  disabled: { short: 'CT off', detail: 'CT server disabled for this session', ready: false },
  starting: { short: 'CT starting', detail: 'CT server starting; device status unknown', ready: false },
  listening: { short: 'CT listening', detail: 'CT server listening locally; device status unknown', ready: true },
  unavailable: { short: 'CT unavailable', detail: 'CT server unavailable; device status unknown', ready: false },
};

/** Subscribe before the initial read; a delayed snapshot must not overwrite a newer event. */
export function observeControlHostStatus(bridge: ControlStatusBridge | undefined, report: (status: ControlHostStatus) => void) {
  let active = true, eventSeen = false;
  report(bridge ? 'unknown' : 'unavailable');
  const unsubscribe = bridge?.onHostStatus?.(value => {
    eventSeen = true;
    if (active) report(parseControlHostStatus(value));
  });
  if (bridge?.hostStatus) {
    void Promise.resolve().then(() => bridge.hostStatus!()).then(value => {
      if (active && !eventSeen) report(parseControlHostStatus(value));
    }, () => { if (active && !eventSeen) report('unknown'); });
  }
  return () => { active = false; unsubscribe?.(); };
}

/** Readiness follows the actual optional host startup result, including failure. */
export async function trackControlHostStartup<T>(start: () => Promise<T | null>, report: (status: ControlHostStatus) => void): Promise<T | null> {
  report('starting');
  try { const server = await start(); report(server ? 'listening' : 'disabled'); return server; }
  catch (error) { report('unavailable'); throw error; }
}
