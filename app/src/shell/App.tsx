import { useEffect } from 'react';
import { SharedAppShell } from '../../../shared/ui/AppShell';
import { APP_LABEL } from '../../version';
import { TopBar } from './TopBar';
import { StatusStrip } from './StatusStrip';
import { QolLayer, toastError } from '../qol/qol';
import { NotificationHistory } from '../qol/NotificationHistory';
import { engine } from '../engine';
import { droppedPaths, isOsDrop, openDropped } from '../lib/osDrop';
import { blocksProjectHistoryTarget, blocksShortcutTarget } from '../lib/keyboard';
import { TourLayer } from './TourLayer';
import { RadialLayer } from '../radial/Radial';
import { setWs, uiStore, useSettings, useUi, WS_KEYS } from '../state/ui';
import { stepHistory, useProject } from '../state/project';
import { usePlayback } from '../components/SliceTrack';
import { timelineFrames } from '../lib/timeline';
import { newProject, openProject, save, useDirty } from '../state/lifecycle';
import { MoshWs } from '../ws/mosh/MoshWs';
import { NodeWs } from '../ws/node/NodeWs';
import { BrowseWs } from '../ws/browse/BrowseWs';
import { HomeWs } from '../ws/home/HomeWs';
import { QuickPreview } from './QuickRender';
import { HistoryDrawer } from '../ws/mosh/ComposePanes';
import { RenderWs } from '../ws/render/RenderWs';
import { SettingsWs } from '../ws/settings/SettingsWs';

export function App() {
  const ws = useUi((s) => s.ws);
  const theme = useSettings((s) => s.theme);
  const scale = useSettings((s) => s.uiScale);
  const total = useProject((d) => timelineFrames(d.timeline.blocks));
  const fps = useProject((d) => d.settings.fps);
  usePlayback(total, fps);
  const name = useProject((d) => d.name);
  const dirty = useDirty();
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} — ${APP_LABEL}`;
  }, [name, dirty]);

  // Engine-originated errors (worker crash, decode failure mid-play) surface as toasts.
  useEffect(() => engine.onError((e) => toastError(e)), []);
  // Folders and video files dropped from the OS anywhere in the window open in Source (a drop zone
  // that handles one itself, Favourites, prevents the default first).
  useEffect(() => {
    const over = (e: DragEvent) => { if (isOsDrop(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } };
    const drop = (e: DragEvent) => { if (!isOsDrop(e) || e.defaultPrevented) return; e.preventDefault(); void openDropped(droppedPaths(e)); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => (window.removeEventListener('dragover', over), window.removeEventListener('drop', drop));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(scale);
    // The shell is one viewport tall at any UI scale (tokens.css: .app height).
    document.documentElement.style.setProperty('--ui-zoom', String(scale));
  }, [scale]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('[role="alertdialog"]')) return;
      const protectedTarget = blocksShortcutTarget(e.target);
      // Alt+0–3: Home · Source · Compose · Render. Alt+G: Open Graph on the selected block (and back).
      // `code` so it works whatever Alt+key types on this layout.
      if (!protectedTarget && e.altKey && !e.ctrlKey && /^Digit[0-3]$/.test(e.code)) {
        e.preventDefault();
        setWs(WS_KEYS[e.code.slice(5)]);
        return;
      }
      if (!protectedTarget && e.altKey && !e.ctrlKey && e.code === 'KeyG') {
        e.preventDefault();
        setWs(uiStore.get().ws === 'node' ? 'mosh' : 'node');
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === 's' || k === 'o' || k === 'n')) {
        e.preventDefault();
        if (k === 's') void save(e.shiftKey);
        else if (k === 'o') void openProject();
        else void newProject();
        return;
      }
      // Ordinary buttons retain focus after a click but do not own edit history.
      // Text/value editors keep their local undo; Space still belongs to buttons.
      if (mod && !e.altKey && (k === 'z' || k === 'y')) {
        if (blocksProjectHistoryTarget(e.target)) return;
        e.preventDefault();
        stepHistory(k === 'z' && !e.shiftKey);
        return;
      }
      if (protectedTarget) return;
      if (e.key === ' ' && uiStore.get().ws !== 'settings') {
        e.preventDefault();
        uiStore.set((s) => ({ ...s, playing: !s.playing }));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  return (
    <SharedAppShell className="app" contentClassName="wsview" header={<TopBar />} toolbar={<StatusStrip />}
      overlays={<><RadialLayer /><QolLayer /><TourLayer /><QuickPreview /><HistoryDrawer /><NotificationHistory /></>}>
        {ws === 'home' && <HomeWs />}
        {ws === 'mosh' && <MoshWs />}
        {ws === 'node' && <NodeWs />}
        {ws === 'browse' && <BrowseWs />}
        {ws === 'render' && <RenderWs />}
        {ws === 'settings' && <SettingsWs />}
    </SharedAppShell>
  );
}
