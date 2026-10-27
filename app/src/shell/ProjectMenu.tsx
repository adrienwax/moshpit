import { useState } from 'react';
import { useProject } from '../state/project';
import { desktop, newProject, openProject, recents, save, useDirty, useLife } from '../state/lifecycle';
import { runConformCheck, useConforms } from '../state/conforms';
import { toastError } from '../qol/qol';
import { CommandMenu } from './CommandMenu';

const base = (file: string) => file.split(/[\\/]/).pop() ?? file;

export function ProjectIdentity() {
  const name = useProject(d => d.name);
  const file = useLife(s => s.file);
  const busy = useLife(s => s.busy);
  const dirty = useDirty();
  return <div className="project-identity" title={file ?? 'Project not saved yet'} aria-label="Current project">
    <strong>{file ? base(file) : name}</strong>
    <span className={dirty ? 'unsaved' : ''}>{busy ? busy + '…' : dirty ? '● Unsaved' : file ? 'Saved' : 'Not saved'}</span>
  </div>;
}

export function ProjectMenu() {
  const file = useLife(s => s.file);
  const busy = useLife(s => s.busy);
  const [recent, setRecent] = useState<string[]>([]);
  const onDesk = desktop();
  return <CommandMenu label="File" onOpen={() => { void recents().then(setRecent).catch(toastError); }}>
    <button data-command disabled={!!busy} onClick={() => void newProject()}>New project <kbd>Ctrl+N</kbd></button>
    <button data-command disabled={!onDesk || !!busy} onClick={() => void openProject()}>Open… <kbd>Ctrl+O</kbd></button>
    <button data-command disabled={!onDesk || !!busy} onClick={() => void save()}>Save <kbd>Ctrl+S</kbd></button>
    <button data-command disabled={!onDesk || !!busy} onClick={() => void save(true)}>Save as… <kbd>Ctrl+Shift+S</kbd></button>
    <h6>Recent projects</h6>
    {recent.length ? recent.map(f => <button data-command key={f} disabled={!onDesk || !!busy} aria-current={f === file ? 'true' : undefined} title={f} onClick={() => void openProject(f)}>{base(f)}</button>) : <p>{onDesk ? 'No recent projects' : 'Open and save need the desktop app'}</p>}
    <hr /><button data-command onClick={() => void runConformCheck()}>Re-check conformed clips</button>
  </CommandMenu>;
}

/** Progress of a running conform re-check, with cancel. */
export function ConformPill() {
  const running = useConforms(s => s.running);
  if (!running) return null;
  return <span className="pill" title="Re-checking conformed clips against their pinned conforms (D7)">
    <span className="lamp gold" />≈ checking {running.done}/{running.total}
    <button className="pillx" title="Stop checking" onClick={() => running.task.cancel()}>✕</button>
  </span>;
}
