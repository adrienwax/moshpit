// Checkpoint 1, A-3: the job process. An Electron utilityProcess (Node only, no window) that runs the
// long jobs: probe, conform proxy and master, the D7 re-check, cut detection, the source hash. A crash
// here (a bad file taking down a parser, an OOM) ends this process only: main starts a new one and the
// worker fails the calls that were in flight with JOB_PROCESS_CRASHED.
//
// Main sends a MessagePort per render worker, and there is one worker at a time: a new port means the
// last worker died. Its port is closed and its calls aborted (integration audit: each respawn used to
// leave a live handler behind, and an orphaned master conform could keep encoding into the same
// cache path the new worker's resumed conform writes).
import type { MessagePortMain } from 'electron';
import { serveJobs } from '../../engine/src/jobs/runner';

let current: { port: MessagePortMain; serve: ReturnType<typeof serveJobs> } | null = null;

process.parentPort.on('message', (e) => {
  const port = e.ports[0];
  if (!port) return;
  if (current) { current.serve.abortAll(); current.port.close(); }
  const serve = serveJobs((m) => port.postMessage(m));
  current = { port, serve };
  port.on('message', (ev) => serve(ev.data));
  port.start();
});
