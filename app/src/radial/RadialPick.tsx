// The standard multi-choice control: a field button that opens the radial at the pointer (or
// at the button, from the keyboard). Presets, codecs, snap units, waveforms, sort orders and
// short enum params all use it, so every pick in the app is the same gesture.
import type { ReactNode } from 'react';
import { centreOf, radialChoose, type PickOption } from './Radial';

export function RadialPick<T>({
  title,
  value,
  options,
  onChange,
  className = 'sel2 radfield',
  label,
  hint,
}: {
  title: string;
  value: T;
  options: PickOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  /** Button content; defaults to the current option's label. */
  label?: ReactNode;
  hint?: string;
}) {
  const flat = (os: PickOption<T>[]): PickOption<T>[] => os.flatMap((o) => (o.children ? flat(o.children) : [o]));
  const current = flat(options).find((o) => o.value === value);
  return (
    <button
      className={className}
      aria-haspopup="menu"
      title={hint ?? `${title} — radial chooser`}
      onClick={async (e) => {
        e.stopPropagation();
        // detail 0 = keyboard activation: open on the button, not at (0,0).
        const at = e.detail === 0 ? centreOf(e.currentTarget) : { x: e.clientX, y: e.clientY };
        const v = await radialChoose(at, title, options, value);
        if (v !== undefined) onChange(v);
      }}
    >
      {label ?? current?.label ?? String(value)} ▾
    </button>
  );
}
