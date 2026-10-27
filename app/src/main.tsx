import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles/prototype.css';
import './styles/app.css';
import './styles/tokens.css';
// Design system (shared/ui/DESIGN-SYSTEM.md): Inter for chrome, JetBrains Mono for every machine
// value, both bundled (OFL) so an offline app never falls back. The tokens, then design.css, load last.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../../shared/ui/tokens.css';
import './styles/design.css';
import './styles/focused-workspaces.css';
import { App } from './shell/App';
import './lib/perf'; // Phase 0.1a: window.__moshpitPerf, the main-thread probe
import { loadLayouts } from './layout/model';
import { loadSettings, seedTestClips } from './state/ui';
import { TEST_CLIPS_DIR } from './lib/testClips';
import { engine, loadRegistry } from './engine';
import { installControlBridge } from './state/control';
import { installControlHostStatus } from './state/controlStatus';
import { bootLifecycle } from './state/lifecycle';
import { initializeProjectDefaults } from './state/project';
import { installGlobalErrorHandlers, toast, toastError } from './qol/qol';

installGlobalErrorHandlers();
// Config + registry first so the first paint uses the saved layout and theme.
const bootResults = await Promise.allSettled([loadLayouts(), loadSettings(), loadRegistry()]);
for (const result of bootResults) if (result.status === 'rejected') toastError(result.reason);
const layoutNotice = bootResults[0].status === 'fulfilled' ? bootResults[0].value : undefined;
initializeProjectDefaults();
installControlHostStatus(window.moshpitControl);
installControlBridge();
// The test clips favourite, if the folder is on this machine (the engine answers for the disk).
if (TEST_CLIPS_DIR) void engine.listDir(TEST_CLIPS_DIR).then(() => seedTestClips(true), () => seedTestClips(false));
createRoot(document.getElementById('root')!).render(<App />);
if (layoutNotice) toast(layoutNotice);
// After first paint, so a recovery prompt has the app behind it.
void bootLifecycle().catch(toastError);
