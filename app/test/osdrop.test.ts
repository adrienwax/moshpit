// Bug hunt: a video dropped from a drive root opened "D:" (the current folder on D) instead of "D:\".
import { describe, expect, it } from 'vitest';
import { folderOf } from '../src/lib/osDrop';

describe('a dropped file\u2019s folder', () => {
  it('keeps a drive root\u2019s backslash', () => {
    expect(folderOf('D:\\clip.mp4')).toBe('D:\\');
    expect(folderOf('D:\\a\\b\\clip.mp4')).toBe('D:\\a\\b');
  });
});
