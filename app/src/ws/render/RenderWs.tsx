import { ProgramPane } from '../mosh/ComposePanes';
import { Workspace, type PaneDef } from '../../layout/Workspace';
import { ExportForm, LogPane, PresetsPane, QueuePane, QueueTools } from './RenderPanes';

const PANES: Record<string, PaneDef> = {
  preview: { title: 'Edit preview', help: 'The assembled edit at its own playhead. Export jobs have separate progress and cancellation.', body: () => <ProgramPane exportView /> },
  presets: { title: 'Presets', help: 'Click a preset to fill the new-job form.', body: () => <PresetsPane /> },
  addjob: { title: 'New export job', help: 'Codec, size and output for the whole edit. The engine decode-checks before publishing and never overwrites a file.', body: () => <div className="rqp"><ExportForm /></div> },
  queue: { title: 'Render queue', help: 'Jobs run one at a time. Cancel, retry, clear finished.', extra: <QueueTools />, body: () => <QueuePane /> },
  log: { title: 'Output log', help: 'Converter output for the selected job: conform, encode, decode check, write.', body: () => <LogPane /> },
};

export function RenderWs() {
  return <Workspace ws="render" panes={PANES} />;
}
