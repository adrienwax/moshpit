// Pure dimension/config/persistence checks: no FFmpeg, Electron, GPU or source media execution.
import { describe, expect, it } from 'vitest';
import { conformArgs } from '../src/conform/conform';
import { conformLevel } from '../src/conform/level';
import { newProject } from '../src/project/build';
import { parseProject, serializeProject } from '../src/project/io';
import { fit } from '../src/preview/source';
import type { SourceProbe } from '../src/model';

describe('portrait dimensions through project and conform configuration', () => {
  it('factory follows chosen working size and preserves it across persistence', () => {
    const d = newProject('Portrait', { working: { w:1080,h:1920 }, fps: { num:30,den:1 } });
    expect(d.exportConfig).toMatchObject({ width:1080,height:1920 });
    const reopened = parseProject(serializeProject(d)).doc;
    expect(reopened.settings.working).toEqual({ w:1080,h:1920 });
    expect(reopened.exportConfig).toEqual(d.exportConfig);
    expect(newProject('Default').exportConfig).toMatchObject({width:1920,height:1080});
  });
  it.each([false, true])('keeps full/proxy portrait dimensions and CFR30 (proxy=%s)', proxy => {
    const args = conformArgs('portrait.mp4','out.mp4',{} as SourceProbe,{fps:{num:30,den:1},width:1080,height:1920,proxyDivisor:4,crf:15},proxy);
    const filter = args[args.indexOf('-vf')+1];
    const [w,h] = proxy ? [270,480] : [1080,1920];
    expect(filter).toContain('scale='+w+':'+h+':force_original_aspect_ratio=decrease');
    expect(filter).toContain('pad='+w+':'+h+':(ow-iw)/2:(oh-ih)/2');
    expect(filter).toContain('setsar=1'); expect(filter).toContain('fps=30/1');
    expect(args[args.indexOf('-level:v')+1]).toBe('4.1');
    expect(filter).not.toContain('crop');
  });
  it('selects orientation-symmetric H264 capacity and keeps portrait preview aspect', () => {
    for(const num of [30,60]) expect(conformLevel(1080,1920,{num,den:1})).toBe(conformLevel(1920,1080,{num,den:1}));
    expect(fit({w:1080,h:1920},{w:640,h:480})).toEqual({w:270,h:480});
  });
});
