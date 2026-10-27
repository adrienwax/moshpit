import { ipcRenderer } from 'electron';
import { runGate } from './gate';
import { runSlice } from './slice';
import { runService } from './service';
import { runColour } from './colour';
import { runScale } from './scale';
import { runEffects } from './effects';
import { runLong } from './long';
import { runAudio } from './audio';
import { runPreview } from './preview';
import { runPreviewAudit } from './preview-audit';

const mode = new URLSearchParams(location.search).get('mode') ?? 'gate';

(async () => {
  const r: Record<string, unknown> = { tag: mode };
  try {
    if (mode === 'gate') Object.assign(r, await runGate());
    else if (mode === 'slice') Object.assign(r, await runSlice());
    else if (mode === 'service') Object.assign(r, await runService());
    else if (mode === 'colour') Object.assign(r, await runColour());
    else if (mode === 'scale') Object.assign(r, await runScale());
    else if (mode === 'effects') Object.assign(r, await runEffects());
    else if (mode === 'long') Object.assign(r, await runLong());
    else if (mode === 'audio') Object.assign(r, await runAudio());
    else if (mode === 'preview') Object.assign(r, await runPreview());
    else if (mode === 'preview-audit') Object.assign(r, await runPreviewAudit());
    else throw new Error(`unknown mode ${mode}`);
  } catch (e) {
    r.fatal = (e as Error)?.stack ?? String(e);
  }
  ipcRenderer.send('done', r);
})();
