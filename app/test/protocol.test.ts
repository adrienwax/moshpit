// A-1: moshpit:// serves nothing outside its roots, and answers media range requests exactly.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { inside, parseRange, mediaUrl } from '../electron/protocol';

describe('moshpit:// (A-1)', () => {
  const root = path.resolve('D:/x/preview');
  it('resolves only inside its root', () => {
    expect(inside(root, 'a.mp4')).toBe(path.join(root, 'a.mp4'));
    expect(inside(root, 'sub/a.mp4')).toBe(path.join(root, 'sub', 'a.mp4'));
    for (const bad of ['../a.mp4', '..\a.mp4', 'sub/../../a.mp4', 'C:/Windows/win.ini', '', '.']) expect(inside(root, bad), bad).toBeNull();
    expect(inside(root, path.relative(root, 'D:/x/preview-evil/a.mp4'))).toBeNull();
  });
  it('parses byte ranges, open-ended and suffix, and refuses unsatisfiable ones', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual([0, 99]);
    expect(parseRange('bytes=10-19', 100)).toEqual([10, 19]);
    expect(parseRange('bytes=90-500', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=5-2', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
  it('a media URL round-trips a Windows path with spaces and #', () => {
    const p = 'D:\a b\#1\preview_x.mp4';
    expect(decodeURIComponent(new URL(mediaUrl(p)).pathname.slice('/media/'.length))).toBe(p);
  });
});
