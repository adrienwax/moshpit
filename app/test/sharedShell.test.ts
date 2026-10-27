import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SharedAppShell, SharedPane } from '../../shared/ui/AppShell';
import { resizeKeyDelta, SharedResizeHandle } from '../../shared/ui/ResizeHandle';

describe('shared application shell boundary', () => {
  it('keeps header, toolbar, main and overlays as direct siblings without sidebars', () => {
    const html = renderToStaticMarkup(h(SharedAppShell, {
      className: 'app', contentClassName: 'wsview',
      header: h('header', null, 'top'), toolbar: h('div', { className: 'statusstrip' }, 'status'),
      overlays: h('div', { className: 'overlay' }, 'dialog'), children: 'workspace',
    }));
    expect(html).toBe('<div class="app es-shell"><header>top</header><div class="statusstrip">status</div><main class="wsview es-shell__content">workspace</main><div class="overlay">dialog</div></div>');
  });

  it('places navigation and inspector alongside content inside one bounded body', () => {
    const html = renderToStaticMarkup(h(SharedAppShell, {
      header: h('header', null, 'top'), navigation: 'places', inspector: 'details',
      bodyClassName: 'hub-body', children: 'canvas',
    }));
    expect(html).toContain('<div class="hub-body es-shell__body"><aside class="es-shell__navigation">places</aside><main class="es-shell__content">canvas</main><aside class="es-shell__inspector">details</aside></div>');
    expect(html.match(/<main /g)).toHaveLength(1);
  });

  it('treats conditional false sidebar slots as absent', () => {
    const html = renderToStaticMarkup(h(SharedAppShell, { header: 'top', navigation: false, inspector: false, children: 'canvas' }));
    expect(html).not.toContain('es-shell__body');
    expect(html).not.toContain('<aside');
  });

  it('preserves pane header/drop attributes and body as direct section children', () => {
    const html = renderToStaticMarkup(h(SharedPane, {
      title: 'Preview', className: 'card', bodyClassName: 'pbody', style: { flex: '2 1 0px' },
      beforeHeader: h('div', { className: 'tip' }, 'help'),
      header: h('div', { className: 'hd', 'data-drop': 'target' }, 'tabs'), children: 'video',
    }));
    expect(html).toBe('<section class="card es-pane" style="flex:2 1 0px" aria-label="Preview"><div class="tip">help</div><div class="hd" data-drop="target">tabs</div><div class="pbody es-pane__body">video</div></section>');
  });

  it('does not mount hidden pane contents but retains its caller-owned header', () => {
    let mounted = false;
    const Body = () => { mounted = true; return 'body'; };
    const html = renderToStaticMarkup(h(SharedPane, { title: 'Metadata', header: h('div', { className: 'hd' }, 'header'), collapsed: true, children: h(Body) }));
    expect(mounted).toBe(false);
    expect(html).toContain('header');
    expect(html).not.toContain('es-pane__body');
  });
});

describe('shared local resize controls', () => {
  it('exposes a keyboard-focusable named separator without extra sibling wrappers', () => {
    const html = renderToStaticMarkup(h(SharedResizeHandle, {
      orientation: 'vertical', label: 'Resize columns', className: 'vsplit', onResizeStart: () => () => {},
    }));
    expect(html).toContain('class="vsplit es-resize"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Resize columns"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html.match(/<div/g)).toHaveLength(1);
  });

  it('maps each divider axis to 10px steps and Shift to precise 1px steps', () => {
    expect(resizeKeyDelta('ArrowLeft', 'vertical')).toEqual([-10, 0]);
    expect(resizeKeyDelta('ArrowRight', 'vertical', true)).toEqual([1, 0]);
    expect(resizeKeyDelta('ArrowUp', 'horizontal')).toEqual([0, -10]);
    expect(resizeKeyDelta('ArrowDown', 'horizontal', true)).toEqual([0, 1]);
    expect(resizeKeyDelta('ArrowDown', 'vertical')).toBeNull();
    expect(resizeKeyDelta('ArrowRight', 'horizontal')).toBeNull();
    expect(resizeKeyDelta(' ', 'vertical')).toBeNull();
  });
});
