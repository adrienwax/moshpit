// Original procedural footage for the public starter projects. No external assets/audio.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const WIDTH = 640, HEIGHT = 360, FPS = 30, FRAMES = 240;
const byte = n => Math.max(0, Math.min(255, Math.round(n)));
export function sourceFrame(style, frame) {
  if (!['ribbons', 'orbit'].includes(style) || !Number.isInteger(frame) || frame < 0 || frame >= FRAMES) throw Error('Invalid source frame');
  const data = Buffer.alloc(WIDTH * HEIGHT * 3), t = frame / FPS;
  for (let y = 0; y < HEIGHT; y++) {
    const ny = (y - HEIGHT / 2) / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const nx = (x - WIDTH / 2) / HEIGHT, i = (y * WIDTH + x) * 3;
      let r, g, b;
      if (style === 'ribbons') {
        const bend = Math.sin(ny * 7 + t * 1.1) * .16;
        const wave = Math.sin((nx + bend - t * .17) * 26);
        const fine = (Math.sin((nx + bend - t * .17) * 114) + 1) / 2;
        const glow = Math.pow(Math.max(0, wave), 3);
        r = 18 + glow * 211 + fine * 21;
        g = 29 + (1 - glow) * 86 + fine * 37;
        b = 38 + (1 - glow) * 124 + fine * 28;
        const mask = Math.abs(nx - .5 * Math.sin(t * .9)) < .09 && Math.abs(ny - .24 * Math.cos(t * .7)) < .22;
        if (mask) { r = 240 - fine * 36; g = 218 - glow * 70; b = 112 + fine * 40; }
      } else {
        const cx = .27 * Math.cos(t * .7), cy = .22 * Math.sin(t * .9);
        const dx = nx - cx, dy = ny - cy;
        const rings = (Math.sin(Math.sqrt(dx * dx + dy * dy) * 46 - t * 3.6) + 1) / 2;
        const grid = Math.max(0, Math.cos((nx + t * .13) * 39) * Math.cos((ny - t * .09) * 39));
        const bar = Math.abs(ny - .23 * Math.sin(nx * 6 - t * 1.3)) < .035;
        r = 20 + rings * 26 + grid * 65 + (bar ? 130 : 0);
        g = 27 + rings * 68 + grid * 92 + (bar ? 105 : 0);
        b = 55 + rings * 153 + grid * 26;
      }
      data[i] = byte(r); data[i + 1] = byte(g); data[i + 2] = byte(b);
    }
  }
  return data;
}

export async function writeSource(ffmpeg, style, file) {
  const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', `${FPS}`, '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-g', '120', '-bf', '0', '-map_metadata', '-1', '-movflags', '+faststart', file], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  const complete = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`Source encode failed (${code}): ${stderr}`)));
  });
  // Attach a rejection handler before streaming, so an early encoder failure is not unhandled.
  complete.catch(() => {});
  child.stdin.on('error', () => {});
  for (let frame = 0; frame < FRAMES; frame++) {
    if (child.exitCode !== null) break;
    if (!child.stdin.write(sourceFrame(style, frame))) await Promise.race([once(child.stdin, 'drain'), complete]);
  }
  child.stdin.end(); await complete;
}
