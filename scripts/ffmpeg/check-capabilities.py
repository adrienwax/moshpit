"""Synthetic codec baseline for a future source-complete FFmpeg replacement.

This does not test Moshpit's UI, Chromium encoder or effects, and grants no licence clearance.
"""
import hashlib
import json
from pathlib import Path
import subprocess

import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--ffmpeg-dir', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, help='Optional output of scripts/make-fixtures.mjs')
options = parser.parse_args()
OUT = options.out
FFMPEG = options.ffmpeg_dir / 'ffmpeg.exe'
FFPROBE = options.ffmpeg_dir / 'ffprobe.exe'
CASES = [
    ('conform-h264', 'mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 'h264'),
    ('prores-422hq', 'mov', ['-c:v', 'prores_aw', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'], 'prores'),
    ('prores-4444', 'mov', ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'], 'prores'),
    ('hap', 'mov', ['-c:v', 'hap', '-format', 'hap', '-chunks', '4', '-compressor', 'snappy'], 'hap'),
    ('hapq', 'mov', ['-c:v', 'hap', '-format', 'hap_q', '-chunks', '4', '-compressor', 'snappy'], 'hap'),
    ('hap-alpha', 'mov', ['-c:v', 'hap', '-format', 'hap_alpha', '-chunks', '4', '-compressor', 'snappy'], 'hap'),
]


def run(exe, args):
    result = subprocess.run([str(exe)] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-2000:])
    return result.stdout.decode('utf-8', errors='replace')


def probe(path):
    return json.loads(run(FFPROBE, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(path)]))['streams'][0]


def main():
    OUT.mkdir(exist_ok=False)
    results = []
    for label, extension, codec_args, codec in CASES:
        dest = OUT / (label + '.' + extension)
        run(FFMPEG, ['-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=4',
                     '-frames:v', '4'] + codec_args + [str(dest)])
        info = probe(dest)
        assert info['codec_name'] == codec and int(info['nb_read_frames']) == 4, label
        run(FFMPEG, ['-nostdin', '-v', 'error', '-i', str(dest), '-f', 'null', '-'])
        results.append({'case': label, 'codec': codec, 'frames': 4, 'status': 'ENCODE_PROBE_DECODE_PASS', 'arguments': codec_args})
    png = OUT / 'frame-%02d.png'
    run(FFMPEG, ['-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=4', '-frames:v', '4', str(png)])
    assert len(list(OUT.glob('frame-*.png'))) == 4
    results.append({'case': 'png-sequence', 'frames': 4, 'status': 'ENCODE_PASS'})
    for encoder, extension in [('aac', 'm4a'), ('pcm_s16le', 'wav')]:
        dest = OUT / ('audio.' + extension)
        run(FFMPEG, ['-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                     '-t', '0.1', '-c:a', encoder, str(dest)])
        assert probe(dest)['codec_name'] == encoder
        run(FFMPEG, ['-nostdin', '-v', 'error', '-i', str(dest), '-f', 'null', '-'])
        results.append({'case': encoder, 'status': 'ENCODE_PROBE_DECODE_PASS'})
    hdr = OUT / 'hdr-pq.mp4'
    run(FFMPEG, ['-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=4',
                 '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
                 '-frames:v', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-profile:v', 'high10',
                 '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', str(hdr)])
    assert probe(hdr)['color_transfer'] == 'smpte2084'
    sdr = OUT / 'hdr-to-sdr.mp4'
    tone = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
    run(FFMPEG, ['-nostdin', '-n', '-v', 'error', '-i', str(hdr), '-vf', tone, '-c:v', 'libx264', str(sdr)])
    info = probe(sdr)
    assert info['color_transfer'] == 'bt709' and int(info['nb_read_frames']) == 4
    results.append({'case': 'HDR-PQ-to-SDR', 'frames': 4, 'status': 'TONEMAP_PASS', 'limit': 'Synthetic tagged input, not visual colour acceptance'})
    if options.fixtures:
        for name in ['pv-h264.mkv', 'pv-hevc.mp4', 'pv-vp9.webm', 'pv-av1.mp4', 'pv-prores.mov', 'pv-mpeg2.mpg', 'pv-mjpeg.avi', 'pv-rot90.mp4']:
            source = options.fixtures / name
            assert source.is_file(), source
            info = probe(source)
            assert int(info['nb_read_frames']) > 0, name
            run(FFMPEG, ['-nostdin', '-v', 'error', '-i', str(source), '-f', 'null', '-'])
            results.append({'case': name, 'status': 'IMPORT_PROBE_DECODE_PASS', 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
    filters = run(FFMPEG, ['-hide_banner', '-filters'])
    required = ['anullsrc', 'atrim', 'aresample', 'aformat', 'asetpts', 'asetrate', 'atempo', 'apad', 'concat', 'scale', 'fps', 'format', 'zscale', 'tonemap']
    available = {line.split()[1] for line in filters.splitlines() if len(line.split()) >= 2}
    assert set(required) <= available, set(required) - available
    assert 'libdav1d' in run(FFMPEG, ['-hide_banner', '-decoders'])
    assert 'h264_metadata' in run(FFMPEG, ['-hide_banner', '-bsfs']).split()
    report = {'status': 'COMPONENT_BASELINE_PASS_NOT_APP_OR_LICENCE_CLEARANCE', 'cases': results,
              'requiredFiltersPresent': required, 'bitstreamFilterPresent': 'h264_metadata',
              'ffmpegSha256': hashlib.sha256(FFMPEG.read_bytes()).hexdigest(),
              'ffprobeSha256': hashlib.sha256(FFPROBE.read_bytes()).hexdigest(),
              'sourceReferences': ['engine/src/runtime/export.ts', 'engine/src/runtime/audio.ts', 'engine/src/conform/conform.ts'],
              'limits': ['No owner footage', 'No Moshpit UI or WebCodecs test', 'No import-format or effect parity claim', 'No licence clearance']}
    (OUT / 'RESULTS.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'passedCases': len(results), 'filters': len(required), 'status': report['status']}))


if __name__ == '__main__':
    main()
