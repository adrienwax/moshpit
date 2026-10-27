// The localhost transport for the control hub (CONTROL-PROTOCOL.md "Transport"): a WebSocket on
// 127.0.0.1 only, path /control, port 6193 by default (ephemeral if taken), announced by an
// endpoint file {v, port, path, token, protocol} — the discovery shape of the Moshpit 2.0 ↔
// waxyct deck link. The server is optional: Moshpit runs fully without it. Runs in Electron main.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { ControlHub, PROTOCOL, VERSION, type ControlHost, type Session } from './hub';

export const DEFAULT_PORT = 6193;
export const PATH = '/control';

export interface ControlServer {
  port: number;
  token: string;
  hub: ControlHub;
  close(): Promise<void>;
}

function listen(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port, path: PATH, maxPayload: 64 * 1024 });
    wss.once('error', reject);
    wss.once('listening', () => resolve(wss));
  });
}

export async function startControlServer(host: ControlHost, opts: { endpointFile?: string; port?: number; throttleMs?: number } = {}): Promise<ControlServer> {
  const token = crypto.randomBytes(24).toString('hex');
  const hub = new ControlHub(host, token, opts.throttleMs);
  let wss: WebSocketServer;
  try { wss = await listen(opts.port ?? DEFAULT_PORT); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; wss = await listen(0); }
  wss.on('connection', (ws) => {
    const s: Session = { send: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); }, close: () => ws.close(), authed: false, subs: new Set() };
    hub.open(s);
    ws.on('message', (d) => hub.handle(s, String(d)));
    ws.on('close', () => hub.closed(s));
  });
  const port = (wss.address() as { port: number }).port;
  if (opts.endpointFile) {
    const tmp = `${opts.endpointFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, port, path: PATH, token, protocol: PROTOCOL }), { mode: 0o600 });
    fs.renameSync(tmp, opts.endpointFile);
  }
  return {
    port, token, hub,
    close: () => new Promise((r) => { hub.dispose(); if (opts.endpointFile) fs.rmSync(opts.endpointFile, { force: true }); for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}
