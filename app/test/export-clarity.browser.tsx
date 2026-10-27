import { createRoot } from 'react-dom/client';
import { ExportForm } from '../src/ws/render/RenderPanes';
import { projectStore, getDoc, setExportConfig, undo } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import '../src/styles/prototype.css';
import '../src/styles/app.css';
import '../src/styles/tokens.css';
import '../../shared/ui/tokens.css';
import '../src/styles/design.css';
function setup(mode: string) {
  const d = structuredClone(demoProject());
  if (mode === 'silent') for (const s of d.resources.sources) delete s.probe.audio;
  if (mode === 'unknown') d.resources.sources = [];
  if (mode === 'muted') for (const b of d.timeline.blocks) b.audio.mute = true;
  projectStore.set({ doc: d, past: [], future: [] });
}
setup('silent');
Object.assign(window, { qa: { setup, state: getDoc, format: (format: any) => setExportConfig({ format }, 'Format'), undo } });
createRoot(document.getElementById('root')!).render(<main className="ws-render" style={{ padding: 12 }}><h2>Export</h2><ExportForm /></main>);
