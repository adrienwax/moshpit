import { openStarterMosh } from '../lib/starterMosh';
import { createStore, useStore } from '../state/store';
import { toastError } from '../qol/qol';
import { Icon } from './Icon';

// Shared across the two entry points and workspace unmounts. Project preservation and
// folder/import errors remain owned by openStarterMosh.
const preparing = createStore(false);
export async function startStarterMosh(): Promise<boolean> {
  if (preparing.get()) return false;
  preparing.set(true);
  try { return await openStarterMosh(); }
  catch (error) { toastError(error); return false; }
  finally { preparing.set(false); }
}

export function StarterMoshButton({ home = false }: { home?: boolean }) {
  const busy = useStore(preparing, (value) => value);
  return (
    <button className={home ? 'hact starter-mosh' : 'ghostbtn starter-mosh'} disabled={busy} aria-busy={busy}
      onClick={() => void startStarterMosh()}
      title="Create a picture → motion → picture sequence from three clips in this folder, or choose a folder. Your working size and frame rate are kept; unsaved work is checked before replacing the project.">
      <Icon name="mosh" size={home ? 20 : 16} />
      {home ? <span><b>{busy ? 'Preparing Starter Mosh…' : 'Starter Mosh'}</b><i>Three clips. A ready-to-play sequence.</i></span> : <span>{busy ? 'Preparing…' : 'Starter Mosh'}</span>}
    </button>
  );
}
