"""Generate ten distinct calm 12-second 1080p30 fixtures; never read old video pixels.

Derived from the owner's test-footage/make_test_footage.py filter ideas. All time
functions below are newly evaluated for 360 frames, without padding or looping an
old clip. Run with --output <new-folder> [--only 02 07 10]. Existing clips are refused.
FFmpeg/FFprobe are resolved on PATH (or explicit --ffmpeg/--ffprobe).
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

D, FPS = 12, 30
FONT = "fontfile='C\\:/Windows/Fonts/arialbd.ttf'"
NAMES = [
    '01-fast-pan-testpattern', '02-bouncing-boxes-highcontrast', '03-rotating-grid-zoom',
    '04-moving-text-blocks', '05-scene-cut-fractal-to-testpattern', '06-chroma-spiral-fields',
    '07-fractal-zoom-camera-drift', '08-life-handheld', '09-cellauto-scroll-texture',
    '10-textured-surface-dolly-in',
]
# Names deliberately match the original set so existing selections remain recognisable.
# Their former fast/bouncing/handheld names are historical; these are the calm variants.
FILTERS = [
    "testsrc2=s=2400x1350:r=30:d=12,setpts=4*PTS,fps=30,crop=1920:1080:x='240+120*sin(t*0.08)':y=135",
    "color=c=0x101018:s=1920x1080:r=30:d=12[bg];"
    "color=c=white:s=300x300:r=30[w];color=c=0xb55f64:s=250x250:r=30[r];color=c=0x72b7bb:s=320x200:r=30[c];color=c=0xc9b477:s=180x180:r=30[y];"
    "[bg][w]overlay=x='350+120*sin(t*0.12)':y='220+70*cos(t*0.1)':shortest=1[a];"
    "[a][r]overlay=x='1050+90*sin(t*0.1)':y='150+45*cos(t*0.08)'[b];"
    "[b][c]overlay=x='550+100*cos(t*0.1)':y='720+30*sin(t*0.12)'[d];"
    "[d][y]overlay=x='1450+70*sin(t*0.09)':y='650+70*cos(t*0.1)'",
    "color=c=0x101018:s=2400x1350:r=30:d=12,drawgrid=w=120:h=120:t=6:c=0xaaaaaa,"
    "drawbox=x=1080:y=555:w=240:h=240:c=0xbf9167:t=fill,rotate=a='t*0.018':c=0x101018:ow=2400:oh=1350,"
    "zoompan=z='1.25+0.025*sin(2*PI*on/720)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps=30",
    "color=c=0x101018:s=1920x1080:r=30:d=12,"
    "drawtext=%s:text='MOSH':fontsize=250:fontcolor=0xd9d8ce:x='160+40*sin(t*0.12)':y=170," % FONT +
    "drawtext=%s:text='DATA':fontsize=180:fontcolor=0xb55f64:x='1080+50*sin(t*0.09)':y=410," % FONT +
    "drawtext=%s:text='P-FRAME':fontsize=130:fontcolor=0xc9b477:x='400+55*cos(t*0.1)':y=770" % FONT,
    "mandelbrot=s=1920x1080:r=30:maxiter=256:end_pts=180:start_scale=1.5:end_scale=1.3:outer=normalized_iteration_count,trim=duration=6[a];"
    "testsrc2=s=1920x1080:r=30:d=2,setpts=4*PTS,fps=30,trim=duration=6[b];[a][b]concat=n=2:v=1",
    "gradients=s=1920x1080:r=30:d=12:n=8:type=spiral:speed=0.006:seed=123:"
    "c0=0xb55f64:c1=0x86a788:c2=0x667faa:c3=0xa47d9e:c4=0xc9b477:c5=0x72b7bb:c6=0xbf9167:c7=0x85698f,hue=h='t*2.5'",
    "mandelbrot=s=2400x1350:r=30:maxiter=512:end_pts=360:start_scale=1.5:end_scale=1.15:outer=normalized_iteration_count,"
    "crop=1920:1080:x='240+35*sin(t*0.09)':y='135+22*cos(t*0.07)'",
    "life=s=480x270:r=5:mold=10:ratio=0.1:seed=123:death_color=#202060:life_color=#b7b094:mold_color=#996688,"
    "scale=2112:1188:flags=neighbor,crop=1920:1080:x='96+30*sin(t*0.09)':y='54+20*cos(t*0.08)',fps=30",
    "cellauto=s=704x396:r=8:rule=30:scroll=1:full=1:random_fill_ratio=0.5:random_seed=123,"
    "scale=2112:1188:flags=neighbor,format=rgb24,colorchannelmixer=rr=0.4:gg=0.65:bb=0.7,"
    "crop=1920:1080:x='96+30*sin(t*0.08)':y=54,fps=30",
    None,
]

def run(args):
    subprocess.run(args, check=True, timeout=600)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--only', nargs='*', default=[])
    p.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    p.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    args = p.parse_args()
    if not args.ffmpeg or not args.ffprobe:
        p.error('FFmpeg and FFprobe must be on PATH or supplied explicitly')
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / 'manifest.json'
    records = json.loads(manifest.read_text()) if manifest.exists() else []
    for name, graph in zip(NAMES, FILTERS):
        if args.only and name[:2] not in args.only:
            continue
        out = args.output / (name + '.mp4')
        if out.exists():
            raise RuntimeError('Refusing to overwrite ' + str(out))
        base = [args.ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', '-n', '-filter_threads', '2', '-filter_complex_threads', '2']
        texture = args.output / '_calm-texture.png'
        if graph is None:
            run(base + ['-f', 'lavfi', '-i', 'mandelbrot=s=2400x1350:maxiter=512:start_scale=0.5:outer=normalized_iteration_count', '-vf', 'hue=h=150:s=0.7', '-frames:v', '1', str(texture)])
            graph = "zoompan=z='1.08+0.045*on/360':x='iw/2-iw/zoom/2+25*sin(on/600)':y='ih/2-ih/zoom/2+15*cos(on/700)':d=1:s=1920x1080:fps=30"
            inp = ['-framerate', '30', '-loop', '1', '-i', str(texture), '-vf', graph]
        else:
            inp = ['-f', 'lavfi', '-i', graph]
        try:
            run(base + inp + ['-t', str(D), '-r', str(FPS), '-frames:v', str(D * FPS), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '2', '-an', '-movflags', '+faststart', str(out)])
        finally:
            if texture.exists():
                texture.unlink()
        probe = json.loads(subprocess.check_output([args.ffprobe, '-v', 'error', '-show_entries', 'format=duration:stream=width,height,avg_frame_rate,nb_frames', '-of', 'json', str(out)], universal_newlines=True))
        if abs(float(probe['format']['duration']) - D) > 0.05 or probe['streams'][0].get('nb_frames') != '360':
            raise RuntimeError('Unexpected duration/frame count: ' + str(probe))
        records.append({'file': out.name, 'sha256': hashlib.sha256(out.read_bytes()).hexdigest(), 'probe': probe, 'filter': graph, 'provenance': 'Synthetic FFmpeg filters; adapted from original test-footage/make_test_footage.py, no original MP4 pixels used'})
        manifest.write_text(json.dumps(records, indent=2) + '\n')
        print('verified', out.name, '12s / 360 frames', flush=True)

if __name__ == '__main__':
    main()
