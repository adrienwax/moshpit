import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExampleProject } from '../src/lib/exampleProjects';
vi.mock('../src/host', () => ({ host: {} }));
vi.mock('../src/state/lifecycle', () => ({ desktop: () => true, openExample: vi.fn(), useLife: () => false }));
vi.mock('../src/state/project', () => ({ projectStore: {} }));
vi.mock('../src/state/ui', () => ({ setWs: vi.fn() }));
vi.mock('../src/state/previews', () => ({ previewMediaUrl: (p: string) => `moshpit://app/media/${encodeURIComponent(p)}` }));
vi.mock('../src/components/RawPreview', () => ({ CellThumb: () => null }));
import { ExampleBrowser } from '../src/ws/home/ExamplesPane';
const row: ExampleProject={id:'carry',title:'Texture carry',group:'pixelord',file:'C:/pack/demo.mosh',preview:'C:/pack/preview.mp4',seconds:12,hint:'Change the clean reset.',collection:'bundled'};
const render=(rows: ExampleProject[], extra={}) => renderToStaticMarkup(createElement(ExampleBrowser,{rows,canOpen:true,onOpen:vi.fn(),...extra}));
describe('example browse presentation', () => {
  it('offers native playback, looping and copy opening without autoplay or exposing paths', () => {
    const html=render([row]);
    expect(html).toContain('controls=""');
    expect(html).toContain('loop=""');
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain('moshpit://app/media/C%3A%2Fpack%2Fpreview.mp4');
    expect(html).toContain('Open a copy');
    expect(html).toContain('Original stays unchanged');
    expect(html).toContain('Change the clean reset.');
    expect(html).not.toContain('C:/pack/demo.mosh');
  });
  it('keeps unavailable projects inspectable and prevents opening, with a clear reason', () => {
    const html=render([{...row,unavailable:'Project media is missing.'}]);
    expect(html).toContain('Project media is missing.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open a copy/);
    expect(html).toContain('Preview: Texture carry');
  });
  it('does not hide the entry if the index is empty, or hide valid projects for a warning', () => {
    expect(render([])).toContain('Browse projects');
    expect(render([])).toContain('No examples available');
    const html=render([row],{warning:'Local examples could not be read.'});
    expect(html).toContain('Local examples could not be read.');
    expect(html).toContain('Open a copy');
  });
  it('only puts the selected list item in the tab sequence and disables opening while busy', () => {
    const html=render([row,{...row,id:'other',title:'Other project'}],{busy:true});
    expect(html).toContain('aria-pressed="true" tabindex="0"');
    expect(html).toContain('aria-pressed="false" tabindex="-1"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open a copy/);
    expect(html).toContain('Opening project');
  });
});
