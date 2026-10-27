// The HUD icon set (icon-design-language.md): 24u grid, 2u stroke, square caps, currentColor, so an
// icon takes its colour from the text it sits in. Glyphs are defined locally in this module.
const files = import.meta.glob('../icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const svg: Record<string, string> = {};
for (const [p, s] of Object.entries(files)) svg[p.slice(p.lastIndexOf('/') + 1, -4)] = s;

export type IconName = 'time' | 'frames' | 'range' | 'rate' | 'duplicate' | 'audio' | 'mute' | 'gpu' | 'vram' | 'cache' | 'ct-link' | 'sync-lock' | 'proxy' | 'exact' | 'shuttle-fwd' | 'shuttle-rev' | 'add' | 'back' | 'delete' | 'effect' | 'folder' | 'forward' | 'freeze' | 'home' | 'import' | 'lfo' | 'loop' | 'mark-in' | 'mark-out' | 'mosh' | 'node' | 'pause' | 'play' | 'record' | 'redo' | 'render' | 'save' | 'settings' | 'slice' | 'source' | 'stop' | 'undo';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  // At 16px and below a busy glyph swaps to its drawn small variant (freeze-16, settings-16).
  const s = (size <= 16 && svg[`${name}-16`]) || svg[name] || '';
  return <span className="ico" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: s }} />;
}
