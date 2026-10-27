import { Workspace, type PaneDef } from '../../layout/Workspace';
import { BigPreview, BrowserPane, ChapterCount, ChaptersPane, ConvertPane, MetaPane, MetaState, PlacesPane, UseState } from './BrowsePanes';

// SOURCE. Browse and preview raw files freely — hover-scrub, preview, mark IN/OUT — with no import;
// Use (import & conform) only when a clip goes into the project. Layout: layout/model.ts.
const PANES: Record<string, PaneDef> = {
  places: { title: 'Places', help: 'Favourites (pinned folders) and Recents. Right-click a folder ▸ Add to Favourites, or drag a folder (or a clip) here.', body: () => <PlacesPane /> },
  browser: { title: 'Source browser', help: 'Choose a folder above its clips. Hover to scrub; click to preview; drag to the preview or Use. Browsing never imports a file.', body: () => <BrowserPane /> },
  bigpv: { title: 'Source preview', help: 'The selected clip, straight from the file (raw ≈) until it is in the project. Scrub snaps to keyframes while moving and shows the exact frame at rest; I/O mark the slice; scopes on top.', body: () => <BigPreview /> },
  convert: { title: 'Marked range', help: 'What you have marked on this clip, and where it goes: Send to A / B (or straight in as a block). Only the marked range is conformed, as a background job; browsing never imports anything.', extra: <UseState />, body: () => <ConvertPane /> },
  meta: { title: 'Metadata', help: 'Measured properties of the selected clip — what the slicer and conform depend on.', extra: <MetaState />, body: () => <MetaPane /> },
  chapters: { title: 'Chapters', help: 'After Detect cuts, a long file is chunked into chapters here and mirrored on the slice timeline. Click to jump; merge neighbours.', extra: <ChapterCount />, body: () => <ChaptersPane /> },
};

export function BrowseWs() {
  return <Workspace ws="browse" panes={PANES} />;
}
