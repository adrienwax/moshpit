// Workflow roles do not promise byte-identical exports across runtimes.
import { describe, expect, it } from 'vitest';
import { FORMATS, PRESETS, ROLE_TEXT, roleOf } from '../src/state/render';

describe('export format roles (C5)', () => {
  it('H.264 is the one delivery format; ProRes, HAP and PNG are masters', () => {
    expect(FORMATS.filter((f) => f.role === 'delivery').map((f) => f.id)).toEqual(['mp4-h264']);
    for (const f of FORMATS) if (f.id !== 'mp4-h264') expect(roleOf(f.id), f.id).toBe('master');
  });
  it('the tags say it plainly, and H.264 presets say delivery', () => {
    expect(ROLE_TEXT.master.tag).toBe('MASTER');
    expect(ROLE_TEXT.master.tip).toMatch(/not guaranteed/);
    expect(ROLE_TEXT.delivery.tip).toMatch(/can vary/);
    for (const p of PRESETS.filter((x) => x.format === 'mp4-h264')) expect(p.desc, p.name).toMatch(/delivery/);
  });
});
