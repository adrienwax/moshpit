// Builds the small test sources in fixtures/. Deterministic inputs (lavfi generators), so any
// machine with a full ffmpeg rebuilds the same clips. They are deliberately NOT in the moshable
// form: High profile with B-frames, a 25 fps clip with mono 44.1 kHz audio, so the conform has
// real work to do in every test.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'fixtures');
const ff = process.env.MOSHPIT_FFMPEG || 'ffmpeg';
fs.mkdirSync(dir, { recursive: true });

const clips = {
  // 10 s, 30 fps, High profile with B-frames and x264 scene-cut keyframes, stereo 48k sine.
  'src-a.mp4': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=10',
    '-ac', '2', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '3', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  // 8 s, 25 fps, a different picture entirely, mono 44.1k: conform must retime and resample.
  'src-b.mp4': ['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=f=660:sample_rate=44100:d=8',
    '-t', '8', '-vf', 'hue=h=t*40', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '2', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest'],
  // 6 s, 30 fps, no audio, a moving pattern with lots of motion: the clip that bleeds best.
  'src-c.mp4': ['-f', 'lavfi', '-i', 'life=s=640x360:r=30:mold=10:ratio=0.1:death_color=#c83232:life_color=#00ff00,scale=640:360', '-t', '6',
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p'],
  // 9 s, three hard cuts' worth of scenes (cuts at 3 s and 6 s = frames 90 and 180): scene detection.
  'src-cuts.mp4': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=3',
    '-filter_complex', '[1]trim=duration=3,setpts=PTS-STARTPTS[m];[0][m][2]concat=n=3:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p'],
  // Raw-preview fixtures (engine/src/preview): one per container/codec family, 3 s, keyframe every 30.
  ...previewClips(),
};

function previewClips() {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3'];
  return {
    'pv-h264.mkv': [...src, '-c:v', 'libx264', '-profile:v', 'high', '-bf', '3', '-g', '30', '-pix_fmt', 'yuv420p'],
    'pv-vp9.webm': [...src, '-c:v', 'libvpx-vp9', '-g', '30', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '400k'],
    'pv-hevc.mp4': [...src, '-c:v', 'libx265', '-x265-params', 'keyint=30:min-keyint=30:bframes=3:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'],
    'pv-av1.mp4': [...src, '-c:v', 'libsvtav1', '-g', '30', '-preset', '12', '-pix_fmt', 'yuv420p'],
    'pv-prores.mov': [...src, '-c:v', 'prores_ks', '-profile:v', '0'],
    'pv-mpeg2.mpg': [...src, '-c:v', 'mpeg2video', '-g', '30', '-q:v', '4'],
    'pv-mjpeg.avi': [...src, '-c:v', 'mjpeg', '-q:v', '4'],
    // Stored 320×180, displayed 180×320: a phone held upright.
    // A display-matrix tag over the MKV's own stream (an encode would bake the rotation into pixels).
    'pv-rot90.mp4': ['-display_rotation', '90', '-i', path.join(dir, 'pv-h264.mkv'), '-c', 'copy'],
  };
}

for (const [name, args] of Object.entries(clips)) {
  const out = path.join(dir, name);
  if (fs.existsSync(out) && !process.argv.includes('--force')) { console.log(`have ${name}`); continue; }
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-fflags', '+bitexact', '-map_metadata', '-1', out], { stdio: 'inherit' });
  console.log(`made ${name} (${fs.statSync(out).size} B)`);
}
