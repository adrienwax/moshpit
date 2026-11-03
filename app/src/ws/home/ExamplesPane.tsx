import { useEffect, useState } from 'react';
import { host } from '../../host';
import { exampleIndexWarning, filterExamples, parseExamples, type ExampleProject } from '../../lib/exampleProjects';
import { desktop, openExample, useLife } from '../../state/lifecycle';
import { projectStore } from '../../state/project';
import { setWs } from '../../state/ui';
import { previewMediaUrl } from '../../state/previews';
import { CellThumb } from '../../components/RawPreview';

const category = (row: ExampleProject) => row.group === 'pixelord' ? 'Pixelord inspired' : 'Recipe mix';

function ExampleDetail({ row, canOpen, busy, onOpen }: { row: ExampleProject; canOpen: boolean; busy: boolean; onOpen: (row: ExampleProject) => void }) {
  const [previewError, setPreviewError] = useState(false);
  return <div className="example-detail">
    <div className="example-monitor">
      {row.preview && !previewError ? <video src={previewMediaUrl(row.preview)} controls loop preload="metadata" tabIndex={0}
        aria-label={`Preview: ${row.title}`} onError={() => setPreviewError(true)} /> :
        <p role="status">{previewError ? 'Preview unavailable.' : 'No recorded preview.'}</p>}
    </div>
    <div className="example-detail-bar"><h4>{row.title}</h4><span>{Math.round(row.seconds)}s · {category(row)}</span></div>
    <p className="example-hint">{row.hint}</p>
    {row.unavailable && <p className="example-warning" role="status">{row.unavailable}</p>}
    <div className="example-open-bar"><button className="ghostbtn" disabled={!canOpen || busy || !!row.unavailable} onClick={() => onOpen(row)}>Open a copy</button>
      <span>{!canOpen ? 'Open in the desktop app' : busy ? 'Opening project…' : 'Original stays unchanged'}</span></div>
  </div>;
}

/** The view is independent of loading so missing collections never erase the browse entry. */
export function ExampleBrowser({ rows, warning = '', canOpen, busy = false, onOpen }: {
  rows: ExampleProject[]; warning?: string; canOpen: boolean; busy?: boolean; onOpen: (row: ExampleProject) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visible = filterExamples(rows, query, filter);
  const selected = visible.find(row => row.id === selectedId) ?? visible[0];
  return <>
    <div className="home-example-bar"><h3>Browse projects</h3><input id="example-search" type="search" aria-label="Search example projects"
      placeholder="Search projects or techniques" value={query} onChange={e => setQuery(e.target.value)} /></div>
    <div className="example-filters" role="group" aria-label="Example category">
      {([['all', 'All'], ['pixelord', 'Pixelord inspired'], ['mix', 'Recipe mixes']] as const).map(([id, label]) =>
        <button key={id} className="ghostbtn" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      <span aria-live="polite">{visible.length} projects</span>
    </div>
    {warning && <p className="example-warning" role="status">{warning}</p>}
    {!visible.length ? <div className="example-empty" role="status">{rows.length ? <><p>No matching projects.</p><button className="ghostbtn" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></> :
      <p>No examples available. Use Open… in Home to open a saved project.</p>}</div> :
      <div className="example-desk">
        <div className="example-list" role="group" aria-label="Projects">
          {visible.map((row, index) => <button key={row.id} className="example-row" aria-pressed={selected?.id === row.id}
            tabIndex={selected?.id === row.id ? 0 : -1} onClick={() => setSelectedId(row.id)}
            onKeyDown={e => {
              const offset = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
              if (!offset && e.key !== 'Home' && e.key !== 'End') return;
              e.preventDefault();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + offset));
              setSelectedId(visible[next].id);
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.example-row')[next]?.focus();
            }}>
            <div className="hthumb">{row.preview && <CellThumb path={row.preview} durationSec={row.seconds} />}</div>
            <span className="example-row-text"><b>{row.title}</b><span>{Math.round(row.seconds)}s · {row.collection === 'bundled' ? 'Included' : 'Local'}</span>
              {row.unavailable && <span className="example-warning">Unavailable</span>}</span>
          </button>)}
        </div>
        {selected && <ExampleDetail key={selected.id} row={selected} canOpen={canOpen} busy={busy} onOpen={onOpen} />}
      </div>}
  </>;
}

export function ExamplesPane() {
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const busy = useLife(s => s.busy);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void host.readConfig('examples').then(raw => {
      const rows = parseExamples(raw);
      if (live) { setExamples(rows); setWarning(exampleIndexWarning(raw)); }
    }).catch(() => { if (live) setError('Examples could not be loaded.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [attempt]);
  const open = async (row: ExampleProject) => {
    if (busy || row.unavailable || !desktop()) return;
    const previous = projectStore.get().doc;
    await openExample(row.file);
    if (projectStore.get().doc !== previous) setWs('mosh');
  };
  return <section className="home-examples" aria-label="Browse example projects">
    {loading ? <p role="status">Loading projects…</p> : error ? <><h3>Browse projects</h3><p role="status">{error}</p><button className="ghostbtn" onClick={() => setAttempt(x => x + 1)}>Retry</button></> :
      <ExampleBrowser rows={examples} warning={warning} canOpen={desktop()} busy={!!busy} onOpen={row => void open(row)} />}
  </section>;
}
