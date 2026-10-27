import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SharedAppShell } from '../../shared/ui/AppShell';
import { NotificationHistory } from '../src/qol/NotificationHistory';
import { installGlobalErrorHandlers, QolLayer, toast, toastError } from '../src/qol/qol';
import { notifications } from '../src/qol/notifications';
import '../src/styles/prototype.css';
import '../src/styles/app.css';
import '../src/styles/tokens.css';
import '../../shared/ui/tokens.css';
import '../src/styles/design.css';

function Fixture() {
  const [workspace, setWorkspace] = useState('IN');
  return <SharedAppShell className="app" contentClassName="wsview" header={<div style={{ padding: 10 }}>
    <strong>Moshpit · Notification history check</strong>{' '}
    <button onClick={() => setWorkspace(workspace === 'IN' ? 'MOSH' : 'IN')}>Change workspace</button>
    <button onClick={() => toastError({ code: 'WORKER_CRASHED', context: { reason: 'crashed', sourceId: 'test-card', frame: 125 } })}>Engine error</button>
    <button onClick={() => toast('Saved project', { kind: 'ok' })}>Save notice</button>
  </div>} overlays={<><QolLayer /><NotificationHistory /></>}>
    <div id="workspace" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 12 }}>
      <div style={{ flex: 1, background: 'var(--surface-bg)', display: 'grid', placeItems: 'center' }}>{workspace} · Reserved viewer area</div>
      <div style={{ height: 70, background: 'var(--surface-2)', display: 'grid', placeItems: 'center' }}>Timeline · must remain above notification dock</div>
    </div>
  </SharedAppShell>;
}
installGlobalErrorHandlers();
Object.assign(window, { qa: { state: () => notifications.get() } });
createRoot(document.getElementById('root')!).render(<Fixture />);