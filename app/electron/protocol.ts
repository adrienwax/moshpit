// Checkpoint 1, A-1: the app is served from moshpit://, a privileged custom scheme, not file://.
//
//   moshpit://app/renderer/…  the UI bundle (app/dist/renderer)
//   moshpit://app/worker.html the render worker's page, generated here
//   moshpit://app/media/<path> a video the UI plays (the quick preview), only from the preview folder
//
// One origin for all three: same-origin fetches and media need no CORS headers.
//
// Why: file:// pages are one opaque origin that can read any file by URL, and Chromium will not make
// them cross-origin isolated. Here every response is a choice main makes, documents carry COOP + COEP
// (so SharedArrayBuffer is available), and nothing outside app/dist or the preview folder is served.
import { protocol } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const SCHEME = 'moshpit';
export const APP_ORIGIN = `${SCHEME}://app`;

/** Before app ready: a standard, secure scheme with fetch, streaming (media ranges) and CORS. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.map': 'application/json',
};
// Every response: same-origin documents isolated (SharedArrayBuffer), subresources loadable by them.
const ISOLATE = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' };

/** `child` resolved inside `root`, or null for anything that escapes it (.., another drive). */
export function inside(root: string, child: string): string | null {
  const r = path.resolve(root), c = path.resolve(r, child);
  const rel = path.relative(r, c);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? c : null;
}

/** The URL the UI plays a preview file at. Mirrors `mediaUrl` in src/shell/QuickRender.tsx. */
export const mediaUrl = (file: string) => `${APP_ORIGIN}/media/${encodeURIComponent(file)}`;

/** `bytes=a-b` against a file size: [start, end] inclusive, or null when absent or unsatisfiable. */
export function parseRange(h: string | null, size: number): [number, number] | null {
  const m = h && /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
  const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  return start <= end && start < size ? [start, end] : null;
}

async function serveFile(file: string, req: Request): Promise<Response> {
  let size: number;
  try { const st = await fs.stat(file); if (!st.isFile()) throw 0; size = st.size; } catch { return new Response('not found', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  const r = parseRange(range, size);
  if (range && !r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, ...ISOLATE } });
  const [start, end] = r ?? [0, size - 1];
  const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream) : null;
  const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(size ? end - start + 1 : 0), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...ISOLATE };
  if (r) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: r ? 206 : 200, headers });
}

/** After app ready. `dist` is app/dist; `previewDir` is asked per request (Settings can move it). */
export function handleScheme(dist: string, previewDir: () => string): void {
  // The worker's page: Node-integrated, so it requires its bundle by absolute path (a relative
  // require has no file location to resolve against on a custom scheme).
  const workerPage = `<!doctype html><meta charset="utf-8"><title>moshpit render worker</title><script>require(${JSON.stringify(path.join(dist, 'worker.cjs'))})</script>`;
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
    if (u.host !== 'app') return new Response('not found', { status: 404 });
    if (u.pathname.startsWith('/media/')) {
      const want = decodeURIComponent(u.pathname.slice('/media/'.length));
      const f = path.isAbsolute(want) ? inside(previewDir(), path.relative(previewDir(), want)) : null;
      if (!f) return new Response('forbidden', { status: 403 });
      return serveFile(f, req);
    }
    if (u.pathname === '/worker.html') return new Response(workerPage, { headers: { 'Content-Type': MIME['.html'], ...ISOLATE } });
    const f = u.pathname.startsWith('/renderer/') && inside(path.join(dist, 'renderer'), decodeURIComponent(u.pathname.slice('/renderer/'.length)));
    return f ? serveFile(f, req) : new Response('not found', { status: 404 });
  });
}

/** The renderer page's own URL, from build output. */
export const rendererUrl = () => `${APP_ORIGIN}/renderer/index.html`;
export const workerUrl = (query: Record<string, string>) => `${APP_ORIGIN}/worker.html?${new URLSearchParams(query)}`;
export const isAppUrl = (url: string) => url.startsWith(APP_ORIGIN + '/');
