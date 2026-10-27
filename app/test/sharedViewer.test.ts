import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedViewerViewport } from '../../shared/ui/ViewerViewport';
import { DEFAULT_VIEW, viewerGeometry, type ViewTransform } from '../../shared/ui/viewer';
import * as adapterGeometry from '../src/lib/viewer';
import { ViewerViewport } from '../src/components/ViewerViewport';

// Controlled hook harness checks the component's event contract, not browser layout.
// Actual ResizeObserver/pointer capture/CSS still require consumer browser review.
const hooks = vi.hoisted(() => ({ at: 0, slots: [] as any[], effects: [] as (() => void | (() => void))[], sticky: vi.fn() }));
vi.mock('react', () => ({
  useRef: (initial: unknown) => hooks.slots[hooks.at++] ??= { current: initial },
  useState: (initial: unknown) => {
    const at = hooks.at++;
    if (!(at in hooks.slots)) hooks.slots[at] = initial;
    return [hooks.slots[at], (value: unknown) => { hooks.slots[at] = value; }];
  },
  useEffect: (fn: () => void | (() => void)) => { hooks.effects.push(fn); },
}));
vi.mock('../src/state/store', () => ({ useSticky: hooks.sticky }));

class Surface {
  listeners = new Map<string, (event: any) => void>();
  capture = new Set<number>();
  constructor(public control: boolean | string = false) {}
  closest(selector: string) { return this.control === true || (typeof this.control === 'string' && selector.split(', ').includes(this.control)) ? this : null; }
  addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, fn); }
  removeEventListener(type: string, fn: (event: any) => void) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  setPointerCapture(id: number) { this.capture.add(id); }
  hasPointerCapture(id: number) { return this.capture.has(id); }
  releasePointerCapture(id: number) { this.capture.delete(id); }
}
const cleanups: (() => void)[] = [];
const disconnected = vi.fn();
let resize: (entries: any[]) => void;
beforeEach(() => {
  hooks.at = 0; hooks.slots = []; hooks.effects = []; hooks.sticky.mockReset(); disconnected.mockClear();
  vi.stubGlobal('Element', Surface);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: typeof resize) { resize = callback; }
    observe() {} disconnect() { disconnected(); }
  });
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

function render(value: ViewTransform = DEFAULT_VIEW, onChange = vi.fn(), children: any = 'paused video') {
  hooks.at = 0; hooks.effects = [];
  const tree = SharedViewerViewport({ id: 'main', width: 1920, height: 1080, value, onChange, children, className: 'consumer' });
  const toolbar = tree.props.children[0];
  return { tree, viewport: tree.props.children[1], controls: toolbar.props.children[1].props.children, onChange };
}
function mountEffects(viewport: any) {
  const surface = new Surface(); viewport.props.ref.current = surface;
  for (const effect of hooks.effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return surface;
}

describe('shared viewer geometry and Moshpit adapter', () => {
  it('reexports the same canonical geometry and preserves existing fit/fill/pan behavior', () => {
    expect(adapterGeometry.viewerGeometry).toBe(viewerGeometry);
    expect(adapterGeometry.DEFAULT_VIEW).toBe(DEFAULT_VIEW);
    expect(viewerGeometry(400, 600, 1920, 1080, DEFAULT_VIEW)).toMatchObject({ width: 400, height: 225, x: 0, y: 0 });
    expect(viewerGeometry(1200, 300, 1920, 1080, { ...DEFAULT_VIEW, mode: 'fill' })).toMatchObject({ width: 1200, height: 675 });
    expect(viewerGeometry(800, 700, 1920, 1080, { mode: 'custom', zoom: .5, x: 500, y: -500 })).toMatchObject({ width: 960, height: 540, x: 80, y: 0 });
  });
  it('keeps invalid saved dimensions/transforms finite and bounds custom zoom', () => {
    for (const mode of ['fit', 'fill', 'custom'] as const) {
      const geometry = viewerGeometry(NaN, -5, Infinity, 0, { mode, zoom: NaN, x: Infinity, y: NaN });
      expect(Object.values(geometry).every(Number.isFinite)).toBe(true);
      expect(geometry.x).toBe(0); expect(geometry.y).toBe(0);
    }
    expect(viewerGeometry(800, 600, 1920, 1080, { ...DEFAULT_VIEW, mode: 'custom', zoom: 99 }).zoom).toBe(8);
    expect(viewerGeometry(800, 600, 1920, 1080, { ...DEFAULT_VIEW, mode: 'custom', zoom: -1 }).zoom).toBe(.05);
  });
  it('keeps sticky state owned by the Moshpit adapter and forwards media unchanged', () => {
    const value: ViewTransform = { mode: 'custom', zoom: 2, x: 4, y: 5 }, onChange = vi.fn();
    const child = { type: 'video', props: { paused: true } } as any;
    hooks.sticky.mockReturnValue([value, onChange]);
    const tree = ViewerViewport({ id: 'program', width: 640, height: 360, children: child, toolbar: 'target' });
    expect(hooks.sticky).toHaveBeenCalledWith('viewer.program', DEFAULT_VIEW);
    expect(tree.type).toBe(SharedViewerViewport);
    expect(tree.props).toMatchObject({ id: 'program', width: 640, height: 360, value, onChange, children: child, toolbar: 'target' });
  });
});

describe('shared controlled viewer interaction', () => {
  it('measures its container and preserves child identity without media playback', () => {
    const child = { type: 'video', props: { paused: true, play: vi.fn() } } as any;
    const first = render(DEFAULT_VIEW, vi.fn(), child); mountEffects(first.viewport);
    resize([{ contentRect: { width: 800, height: 600 } }]);
    const next = render(DEFAULT_VIEW, first.onChange, child);
    expect(next.viewport.props.children.props.style).toMatchObject({ width: 800, height: 450 });
    expect(next.viewport.props.children.props.children).toBe(child);
    expect(child.props.play).not.toHaveBeenCalled(); expect(first.onChange).not.toHaveBeenCalled();
    expect(next.tree.props.className).toBe('es-viewer consumer');
  });
  it('emits Fit/Fill/100% and zoom changes, without mutating controlled input', () => {
    const value: ViewTransform = { mode: 'custom', zoom: 2, x: 30, y: 20 };
    const { controls, onChange } = render(value);
    controls[0].props.onClick(); controls[1].props.onClick(); controls[2].props.onClick();
    expect(onChange.mock.calls.slice(0, 3)).toEqual([[DEFAULT_VIEW], [{ ...DEFAULT_VIEW, mode: 'fill' }], [{ ...DEFAULT_VIEW, mode: 'custom' }]]);
    controls[3].props.onClick(); expect(onChange).toHaveBeenLastCalledWith({ ...value, zoom: 1.6 });
    controls[5].props.onClick(); expect(onChange).toHaveBeenLastCalledWith({ ...value, zoom: 2.5 });
    expect(value).toEqual({ mode: 'custom', zoom: 2, x: 30, y: 20 });
  });
  it('intercepts only Ctrl/meta wheel, reads current controlled value, and removes listeners', () => {
    const first = render({ ...DEFAULT_VIEW, mode: 'custom' }); const surface = mountEffects(first.viewport);
    const wheel = surface.listeners.get('wheel')!;
    const preventDefault = vi.fn(); wheel({ deltaY: -1, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); expect(first.onChange).not.toHaveBeenCalled();
    wheel({ deltaY: -1, ctrlKey: true, preventDefault }); expect(first.onChange.mock.calls[0][0].zoom).toBeCloseTo(1.1);
    render({ ...DEFAULT_VIEW, mode: 'custom', zoom: 4 }, first.onChange);
    wheel({ deltaY: 1, metaKey: true, preventDefault }); expect(first.onChange.mock.calls[1][0].zoom).toBeCloseTo(4 / 1.1);
    for (const cleanup of cleanups.splice(0)) cleanup();
    expect(surface.listeners.size).toBe(0); expect(disconnected).toHaveBeenCalledOnce();
  });
  it('pans only the captured primary pointer, then stops on release/cancel', () => {
    const { viewport, onChange } = render({ ...DEFAULT_VIEW, mode: 'custom', zoom: 2 });
    const surface = new Surface();
    const event = { button: 0, pointerId: 7, clientX: 10, clientY: 20, target: surface, currentTarget: surface };
    viewport.props.onPointerDown(event); expect(surface.capture.has(7)).toBe(true);
    viewport.props.onPointerMove({ ...event, pointerId: 8, clientX: 80 }); expect(onChange).not.toHaveBeenCalled();
    viewport.props.onPointerMove({ ...event, clientX: 45, clientY: 30 });
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'custom', zoom: 2, x: 35, y: 10 });
    viewport.props.onPointerUp(event); expect(surface.capture.size).toBe(0);
    viewport.props.onPointerMove({ ...event, clientX: 50 }); expect(onChange).toHaveBeenCalledOnce();
    viewport.props.onPointerDown(event); viewport.props.onPointerCancel();
    viewport.props.onPointerMove({ ...event, clientX: 55 }); expect(onChange).toHaveBeenCalledOnce();
  });
  it('leaves embedded controls alone and resets only background double-clicks', () => {
    const { viewport, onChange } = render(); const surface = new Surface();
    viewport.props.onPointerDown({ button: 2, target: surface, currentTarget: surface, pointerId: 1 });
    for (const selector of ['button', 'video[controls]', 'audio[controls]', '[data-viewer-no-pan]']) {
      const control = new Surface(selector);
      viewport.props.onPointerDown({ button: 0, target: control, currentTarget: surface, pointerId: 1 });
      viewport.props.onDoubleClick({ target: control });
    }
    expect(surface.capture.size).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    viewport.props.onDoubleClick({ target: surface }); expect(onChange).toHaveBeenLastCalledWith(DEFAULT_VIEW);
    viewport.props.onPointerDown({ button: 0, target: new Surface('video'), currentTarget: surface, pointerId: 1 });
    expect(surface.capture.has(1)).toBe(true);
  });
});
