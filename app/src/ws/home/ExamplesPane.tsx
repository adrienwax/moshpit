import { useEffect, useState } from 'react';
import { host } from '../../host';
import { parseExamples, type ExampleProject } from '../../lib/exampleProjects';
import { desktop, openExample, useLife } from '../../state/lifecycle';
import { projectStore } from '../../state/project';
import { setWs } from '../../state/ui';
import { CellThumb } from '../../components/RawPreview';

export function ExamplesPane() {
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const busy = useLife(s => s.busy);
  useEffect(() => {
    let live = true;
    void host.readConfig('examples').then(raw => {
      const rows = parseExamples(raw); if (live) setExamples(rows);
    }).catch(() => { if (live) setError('Example index unavailable'); });
    return () => { live = false; };
  }, []);
  if (!examples.length && !error) return null;
  const open = async (row: ExampleProject) => {
    const previous = projectStore.get().doc;
    await openExample(row.file);
    if (projectStore.get().doc !== previous) setWs('mosh');
  };
  return <section className="home-examples" aria-label="Example projects">
    <div className="home-example-bar"><h3>Example projects</h3>
      <div role="group" aria-label="Example category">{[['all', 'All'], ['pixelord', 'Pixelord inspired'], ['mix', 'Recipe mixes']].map(([id, label]) =>
        <button key={id} className="ghostbtn" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
    </div>
    {error ? <p role="status">{error}</p> : <div className="home-example-grid">
      {examples.filter(x => filter === 'all' || x.group === filter).map(row =>
        <button key={row.id} className="hcard" disabled={!desktop() || !!busy} onClick={() => void open(row)}
          title={`${row.hint} Opens an unsaved copy; the original example stays unchanged.`} aria-label={`Open a copy: ${row.title}`}>
          <div className="hthumb">{row.preview && <CellThumb path={row.preview} durationSec={row.seconds} />}</div>
          <div className="hcmeta"><b>{row.title}</b><span className="home-example-meta"><span>{row.group === 'pixelord' ? 'Pixelord inspired' : 'Recipe mix'}</span><span>{Math.round(row.seconds)}s</span></span><span className="home-example-open">Open a copy →</span></div>
        </button>)}
    </div>}
  </section>;
}
