// Browse effects by their picture, with looks and operators sharing the same catalogue.
// Selection auditions a draft in a separate tuning area; only Add changes the project.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EFFECT_FAMILIES, PRESETS, type BlockId, type ParamValue, type LookCategory } from '@moshpit/engine';
import { defOf, engine, nodeDefs } from '../../engine';
import { FAV_TAB, MATCHES, RECIPE_TAB, TABS, browse, entries, ofKind, type BrowseKind, type BrowseTab, type Entry } from '../../lib/browse';
import { addNode, appendEffect, blockById, getDoc, isFrozen, removeLook, renameLook, selectNode, setParams, transact, trialGraph, undoAction, useProject } from '../../state/project';
import { setSettings, setUi, uiStore, useSettings, useUi, type Audition } from '../../state/ui';
import { FrameView } from '../../components/FrameView';
import { blockFrames, blockStarts } from '../../lib/timeline';
import { fpsValue } from '../../lib/time';
import { useSticky } from '../../state/store';
import { useActive } from '../../components/nodes';
import { Empty, confirmAction, toast, toastError } from '../../qol/qol';
import { auditionOf, endAudition, startAudition, toggleShortlist } from '../../state/audition';
import { applyRecipe, type Recipe } from '../../state/recipes';
import { applyAudition } from '../../components/AuditionBar';
import { ParamControl } from '../../params/Param';
import { auditionDraft, changeDraft, draftTargetIssue, draftValue, makeEffectDraft, presetDraft, restoreDraft, valuesDraft, type EffectDraft } from '../../lib/effectDraft';
import { LOOK_COLOUR } from '../../lib/cats';
import { recipeGroupLabel, recipePresentation } from '../../lib/recipePresentation';
import { blocksShortcutTarget } from '../../lib/keyboard';
import { host } from '../../host';
import { exportLookDialog, importLookDialog } from '../../state/lookIO';
import './effect-gallery.css';

// The row's mark is its port domain, coloured as the graph's sockets are (DESIGN-SYSTEM.md §2.5).
const SIDE: Record<string, { tag: string; tip: string; colour: string }> = {
  bitstream: { tag: 'BITSTREAM', tip: 'Acts on the encoded stream, before the Decode: it moves motion, not pixels', colour: 'var(--dom-enc)' },
  picture: { tag: 'PICTURE', tip: 'Acts on decoded pictures, after the Decode', colour: 'var(--dom-pix)' },
  utility: { tag: 'UTILITY', tip: 'Graph plumbing: placed in the graph unwired, for you to connect', colour: 'var(--dom-ctl)' },
};

/** Add an entry to a block: one undo step, a toast that says what happened. */
export function addEntry(e: Entry, blockId: BlockId, blockNo: number, params?: Record<string, ParamValue>): boolean {
  try {
    if (e.type === 'recipe') {
      if (!applyRecipe(blockId, e.recipe)) return false;
      toast(e.recipe.kinds.length ? `Applied ${e.label} to Block ${blockNo}: a container, so double-click it in the graph to open it, Ctrl+Shift+G to unpack` : `Applied ${e.label} to Block ${blockNo}`, { kind: 'ok', action: undoAction() });
      return true;
    }
    if (e.side === 'utility') {
      const out = blockById(getDoc(), blockId)?.graph.nodes.find((n) => defOf(n.kind)?.category === 'Output');
      transact(() => {
        const id = addNode(blockId, e.id, { x: (out?.position.x ?? 300) - 60, y: (out?.position.y ?? 0) + 140 });
        if (params) setParams(blockId, id, params, `Set ${e.label}`);
        selectNode(blockId, id);
      });
      toast(`Placed ${e.label} in Block ${blockNo}'s graph: wire it in the graph (Alt+G)`, { kind: 'ok', action: undoAction() });
      return true;
    }
    appendEffect(blockId, e.id, params);
    toast(`Added ${e.label} to Block ${blockNo}`, { kind: 'ok', action: undoAction() });
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

/**
 * Phase 2.3: the effect on the user's own frame. A poster (one frame) while the row is in view; the
 * hovered row moves (two seconds from the frame, the only moving one). A bitstream op says
 * "Preparing preview" until its first frame lands: it re-plans the stream, never a look-alike shader.
 */
function Thumb({ blockId, kinds, params, lookId, lookParams, bitstream, edge }: { blockId: string; kinds: string[]; params?: Recipe['params']; lookId?: string; lookParams?: Recipe['lookParams']; bitstream: boolean; edge: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);
  const blocks = useProject((d) => d.timeline.blocks);
  const block = blocks.find((b) => b.id === blockId);
  const at = useMemo(() => { const i = blocks.findIndex((b) => b.id === blockId); return i < 0 ? null : { start: blockStarts(blocks)[i], len: blockFrames(blocks[i]) }; }, [blocks, blockId]);
  const fps = useProject((d) => fpsValue(d.settings.fps));
  // The poster holds its frame while playing: every row following the playhead re-rendered the
  // moshed chain from its keyframe each tick, starving the Program (measured). It catches up on pause.
  const live = useUi((s) => s.playhead), playing = useUi((s) => s.playing);
  const held = useRef(live);
  if (!playing) held.current = live;
  const playhead = held.current;
  const look = useProject((d) => lookId ? d.components?.looks.find((l) => l.id === lookId) ?? null : undefined);
  const graph = useMemo(() => (block ? trialGraph(block, kinds, params, look, lookParams) : null), [block, kinds, params, look, lookParams]);
  useEffect(() => setReady(false), [graph]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // Hover: eight frames across the next two seconds, looping.
  useEffect(() => {
    if (!moving) return setStep(0);
    const t = setInterval(() => setStep((x) => (x + 1) % 8), 250);
    return () => clearInterval(t);
  }, [moving]);
  if (!at || !graph) return null;
  const base = playhead >= at.start && playhead < at.start + at.len ? playhead : at.start + Math.floor(at.len / 3);
  const frame = Math.min(at.start + at.len - 1, base + Math.round((step * 2 * fps) / 8));
  return (
    <div ref={ref} className={'fxthumb' + (moving ? ' moving' : '')} style={{ borderLeftColor: edge }} onMouseEnter={() => setMoving(true)} onMouseLeave={() => setMoving(false)}>
      {seen && <FrameView priority="background" target={{ kind: 'trial', blockId: blockId as never, graph, frame }} maxW={320} badges={false} onFrame={() => setReady(true)} />}
      {!ready && <span className="prep">{bitstream ? 'Preparing preview…' : '…'}</span>}
    </div>
  );
}

const toggleFav = (id: string) => setSettings((x) => void (x.effectFavs = x.effectFavs.includes(id) ? x.effectFavs.filter((f) => f !== id) : [...x.effectFavs, id]));

/** Phase 2.6: the user's own words for an effect. Lower-case, one or two words, joined to search. */
function TagEditor({ id, tags }: { id: string; tags: string[] }) {
  const [v, setV] = useState('');
  const set = (next: string[]) => setSettings((x) => { x.effectTags = { ...x.effectTags, [id]: next }; if (!next.length) delete x.effectTags[id]; });
  const add = () => {
    const t = v.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 24);
    if (t && !tags.includes(t)) set([...tags, t]);
    setV('');
  };
  return (
    <div className="tagedit" onClick={(ev) => ev.stopPropagation()}>
      {tags.map((t) => <span key={t} className="utag">#{t}<button aria-label={`Remove tag ${t}`} onClick={() => set(tags.filter((x) => x !== t))}>×</button></span>)}
      <input value={v} placeholder="＋ your tag" aria-label="Add a tag" onChange={(ev) => setV(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') add(); }} onBlur={add} />
    </div>
  );
}

/** 3.6: one of your own looks, selected in the browser: rename it in place, or take it out of the library. */
function OwnLookRow({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const exportLook = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { if (await exportLookDialog(id)) toast(`Exported ${name}. Import the file in another project's Effects library.`, { kind: 'ok' }); }
    catch (error) { toastError(error); }
    finally { pending.current = false; setBusy(false); }
  };
  return (
    <div className="ownlook" onClick={(ev) => ev.stopPropagation()}>
      <input aria-label="Look name" defaultValue={name} key={name} maxLength={80}
        onBlur={(ev) => renameLook(id, ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} />
      <button className="ghostbtn" disabled={!host.looks || busy} title={host.looks ? 'Export this saved master. To include edits on a placed copy, use Update master first. Project LFO/Value links must be removed in a copy before export.' : 'Look file export requires the desktop app'} onClick={() => void exportLook()}>{busy ? 'Exporting…' : 'Export look…'}</button>
      <button className="ghostbtn" title="Take this look out of your library (copies already placed stay)" onClick={() => void confirmAction(`Delete the ${name} look?`, 'It leaves your library. Copies already placed in blocks stay, unlinked.', 'Delete look').then((ok) => ok && removeLook(id))}>Delete look</button>
    </div>
  );
}

function LookImport({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const look = await importLookDialog();
      if (look) { onImported(); toast(`Imported ${look.name} into this project's library. Select it to preview or add a copy.`, { kind: 'ok', action: undoAction() }); }
    } catch (error) { toastError(error); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="fxfilter-summary"><span title="Saved looks belong to this project">Project looks</span><button className="linkbtn" disabled={!host.looks || busy} title={host.looks ? 'Import a .moshlook.json file as a new library entry; existing looks and placed copies stay unchanged' : 'Look file import requires the desktop app'} onClick={() => void run()}>{busy ? 'Importing…' : 'Import look…'}</button></div>;
}

function DraftControls({ draft, onChange, onReset }: { draft: EffectDraft; onChange: (draft: EffectDraft) => void; onReset: () => void }) {
  const presets = draft.recipe ? [] : PRESETS[draft.entryId] ?? [];
  const library = useSettings(s => s.effectPresets);
  const mine = draft.recipe ? [] : library[draft.entryId] ?? [];
  const render = (c: EffectDraft['controls'][number]) => <ParamControl key={c.id} spec={c.spec} value={draftValue(draft, c)} fieldKey={`draft:${draft.entryId}:${c.id}`} variant="full" onChange={value => onChange(changeDraft(draft, c.id, value))} />;
  return <div className="fxdraft" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }}>
    <div className="fxdraft-head"><b>Quick tune</b><span>{draft.preset}</span><button className="ghostbtn" onClick={onReset} title="Restore this starting point; your project stays unchanged">Reset draft</button></div>
    {(presets.length > 0 || mine.length > 0) && <label className="fxdraft-presets">Preset <select aria-label={`${draft.label} preset`} value={draft.presetKey ?? ''} onChange={e => {
      const key = e.target.value;
      if (key.startsWith('built:')) onChange(presetDraft(draft, key.slice(6)));
      else { const p = mine.find(p => p.id === key.slice(5)); if (p) onChange(valuesDraft(draft, p.name, p.params, key)); }
    }}><option value="" disabled>Default settings</option><optgroup label="Classic v1">{presets.map(p => <option key={p.name} value={`built:${p.name}`}>{p.name}</option>)}</optgroup>{mine.length > 0 && <optgroup label="My presets">{mine.map(p => <option key={p.id} value={`user:${p.id}`}>{p.name}</option>)}</optgroup>}</select></label>}
    <div className="fxdraft-controls">{draft.controls.slice(0, 4).map(render)}</div>
    {draft.controls.length > 4 && <details className="fxdraft-more"><summary>More controls ({draft.controls.length - 4})</summary><div className="fxdraft-controls">{draft.controls.slice(4).map(render)}</div></details>}
    <span className="fxdraft-status dim" title={draft.previewable ? 'Previewing these settings. Nothing changes until you add.' : 'Placed in the graph for you to connect. No standalone preview.'}>{draft.previewable ? 'Preview only · not added' : 'Connect in graph'}</span>
  </div>;
}

/** Focus follows the drawer; a closed/transformed panel must never retain a typing target. */
export function beginEffectBrowserFocus(panel: HTMLElement, search: HTMLInputElement, doc: Document = document): () => void {
  const opener = doc.activeElement === doc.body ? null : doc.activeElement as HTMLElement | null;
  search.focus({ preventScroll: true });
  search.select();
  return () => queueMicrotask(() => {
    // Wait until an unmount has removed its opener, and do not steal focus from a newly opened drawer.
    if (panel.isConnected && !panel.inert) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && !panel.contains(active)) return;
    const visible = (el: HTMLElement | null): el is HTMLElement => !!el && el.isConnected && !panel.contains(el) &&
      !el.closest('[inert], [aria-hidden="true"]') && !el.matches(':disabled') && !!el.getClientRects().length;
    if (visible(opener)) return opener.focus({ preventScroll: true });
    const add = Array.from(doc.querySelectorAll<HTMLElement>('.composews button')).find(el => el.textContent?.includes('Add effect') && visible(el));
    if (add) return add.focus({ preventScroll: true });
    const main = doc.querySelector<HTMLElement>('main');
    if (visible(main)) {
      const tab = main.getAttribute('tabindex');
      main.setAttribute('tabindex', '-1');
      main.focus({ preventScroll: true });
      if (tab === null) main.removeAttribute('tabindex'); else main.setAttribute('tabindex', tab);
    }
  });
}

export function FxPanel() {
  const open = useUi((s) => s.fxPanel);
  const panel = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (open && panel.current && search.current) return beginEffectBrowserFocus(panel.current, search.current);
  }, [open]);
  const { block, blockIndex } = useActive();
  const [q, setQ] = useSticky('fx.q', '');
  const [tab, setTab] = useSticky<BrowseTab>('fx.tab', 'All');
  const [kind, setKind] = useSticky<BrowseKind>('fx.kind', 'all');
  const [fams, setFams] = useSticky<string[]>('fx.families', []);
  const [utags, setUtags] = useSticky<string[]>('fx.usertags', []);
  // Phase 2.6: favourites and the user's tags live in settings.json (on disk, keyed by id).
  const favs = useSettings((x) => x.effectFavs);
  const tagMap = useSettings((x) => x.effectTags);
  const allTags = useMemo(() => [...new Set(Object.values(tagMap).flat())].sort(), [tagMap]);
  // The selected ROW: an effect filed under two looks has two rows, and only the one clicked opens.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<EffectDraft | null>(null);
  const [draftNotice, setDraftNotice] = useState('');
  const draftScope = useRef<string | undefined>(undefined);
  const stageLook = useRef<{ id: string; rev: number } | undefined>(undefined);
  const publishedAudition = useRef<Audition | null>(null);
  const publishedDraft = useRef<EffectDraft | null>(null);
  const pendingAudition = useRef<Audition | null>(null);
  const audition = useUi(s => s.audition);
  const opened = useUi(s => block ? s.opened[block.id] : undefined);
  const frozen = useProject(d => !!block && isFrozen(d, { kind: 'block', blockId: block.id }));
  const own = useProject((d) => d.components?.looks);
  const all = useMemo(() => entries(nodeDefs(), own ?? []), [own]);
  const groups = useMemo(() => browse(ofKind(all, kind), { q, tab, families: fams, userTags: utags.filter((t) => allTags.includes(t)), meta: { favs, tags: tagMap } }), [all, kind, q, tab, fams, utags, allTags, favs, tagMap]);
  const rows = groups.flatMap((g) => g.items.map((e) => ({ key: `${g.cat}/${g.sub}|${e.id}`, e })));
  const shown = rows.map((x) => x.e);
  const sel = selKey?.split('|')[1] ?? null;
  const clearFilters = () => { setQ(''); setTab('All'); setFams([]); setKind('all'); setUtags([]); };
  /** Select an effect by id: its first row in view, after clearing filters that would hide it. */
  const selectId = (id: string | null) => {
    if (id && !rows.some((x) => x.e.id === id)) clearFilters();
    setSelKey(id && `|${id}`);
  };
  // A bare id (from a link, the arrow keys) resolves to its first row once the list has it.
  const selRow = selKey?.startsWith('|') ? rows.find((x) => x.e.id === sel)?.key ?? null : selKey;
  useEffect(() => {
    if (selRow) document.querySelector(`[data-row="${CSS.escape(selRow)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selRow]);
  const byLabel = useMemo(() => all.filter((e) => e.type === 'node').sort((a, b) => b.label.length - a.label.length), [all]);
  const selected = all.find((e) => e.id === sel) ?? null;
  const createDraft = (e: Entry) => block ? makeEffectDraft(e, block.id, e.type === 'recipe' ? own?.find(l => l.id === e.recipe.lookId) : undefined) : null;
  const cancelDraft = (why = '') => { setDraft(null); setSelKey(null); setDraftNotice(why); endAudition(); };
  const selectionVisible = !!selRow && rows.some(row => row.key === selRow);
  const add = (e: Entry) => {
    if (!block) return;
    const staged = draft?.entryId === e.id ? draft : createDraft(e);
    if (!staged) return;
    const issue = draftTargetIssue(staged, block.id, !!blockById(getDoc(), staged.blockId as BlockId), frozen);
    if (issue) return cancelDraft(issue);
    const current = uiStore.get().audition;
    // A cancelled/stale candidate must be rejected, never silently rebuilt from the new project.
    if (publishedDraft.current === staged && current && current !== publishedAudition.current) return cancelDraft('The comparison preview changed. Choose the effect again before adding.');
    const a = publishedDraft.current === staged ? publishedAudition.current : auditionDraft(staged);
    if (staged.previewable && !a) return cancelDraft('This effect cannot be previewed on the current graph. Choose another starting point.');
    const ok = a ? applyAudition(a) : addEntry(e, block.id, blockIndex + 1, staged.params[0]);
    if (ok) cancelDraft();
  };
  const shortlist = useUi((s) => s.shortlist);
  const thumbs = useSettings((s) => s.liveThumbs);
  // Phase 2.2: the selected effect is auditioned on the block (the Program shows it, not applied);
  // closing the browser or selecting nothing ends it.
  // Closing the browser frees the row previews' engine (integration audit: it lived on).
  useEffect(() => { if (!open) engine.releaseTrials?.('thumb'); }, [open]);
  useEffect(() => {
    if (sel && !selectionVisible) cancelDraft('The selected effect is outside this filtered view. Choose a result to continue.');
  }, [sel, selectionVisible]);
  useEffect(() => {
    if (!open || !selected || !block) { setDraft(null); endAudition(); return; }
    if (frozen) { cancelDraft('This block is frozen. Unfreeze it, then choose the effect again.'); return; }
    const next = createDraft(selected);
    setDraft(next && pendingAudition.current ? restoreDraft(next, pendingAudition.current) : next);
    pendingAudition.current = null;
    setDraftNotice('');
    draftScope.current = opened;
    const l = selected.type === 'recipe' && own?.find(l => l.id === selected.recipe.lookId);
    stageLook.current = l ? { id: l.id, rev: l.rev } : undefined;
  }, [open, selected?.id]); // A block switch cancels below; it never silently retargets a draft.
  useEffect(() => {
    if (!draft) return;
    const issue = draftTargetIssue(draft, block?.id, !!blockById(getDoc(), draft.blockId as BlockId), frozen);
    const saved = stageLook.current;
    const changedLook = saved && own?.find(l => l.id === saved.id)?.rev !== saved.rev;
    if (issue || draftScope.current !== opened || changedLook) {
      cancelDraft(issue ?? (changedLook ? 'This saved look changed. Choose it again to preview the current version.' : 'The graph scope changed. Choose the effect again.'));
      return;
    }
    const a = auditionDraft(draft);
    publishedDraft.current = draft;
    publishedAudition.current = a ? startAudition(a) : null;
    if (!a) endAudition();
  }, [draft, block?.id, frozen, opened, own]);
  // Applying/cancelling from the Program bar also clears the browser's staged controls.
  const previousAudition = useRef(audition);
  useEffect(() => {
    const previous = previousAudition.current;
    // Read current state: publishing a draft above may have updated the store in this effect turn.
    const current = uiStore.get().audition;
    previousAudition.current = current;
    if (draft && previous?.id === draft.entryId && !current) { setDraft(null); setSelKey(null); }
    if (current && current !== publishedAudition.current && draft && current.blockId === block?.id) {
      if (current.id === draft.entryId) setDraft(restoreDraft(draft, current));
      else if (all.some(e => e.id === current.id)) { pendingAudition.current = current; selectId(current.id); }
    }
  }, [audition, draft]);

  useEffect(() => {
    if (!open) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.isComposing || document.querySelector('[role="alertdialog"]')) return;
      if (ev.key === 'Escape') return setUi({ fxPanel: false });
      const target = ev.target instanceof Element ? ev.target : null;
      const isSearch = target?.getAttribute('aria-label') === 'Search effects';
      if ((blocksShortcutTarget(ev.target) || target?.closest('summary')) && !isSearch) return;
      const vertical = ev.key === 'ArrowDown' || ev.key === 'ArrowUp';
      const horizontal = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
      // Left/right remain text-caret keys in Search; focused cards use the visual grid.
      if (vertical || (horizontal && !isSearch)) {
        ev.preventDefault();
        const keys = rows.map((x) => x.key);
        const i = keys.indexOf(selRow ?? '');
        const current = panel.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(selRow ?? '')}"]`);
        const grid = current?.closest('.fxgallery-grid') ?? panel.current?.querySelector('.fxgallery-grid');
        const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
        const direction = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : -1;
        const next = keys[i < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, i + direction * (vertical ? columns : 1)))] ?? null;
        setSelKey(next);
        if (next && target?.closest('[role="option"]')) panel.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"]`)?.focus({ preventScroll: true });
      }
      if (ev.key === 'Enter' && !ev.repeat && selected && block) { ev.preventDefault(); add(selected); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  /** "Try next" names other effects: each one is a link that selects it. */
  const tryLinks = (text: string) => byLabel.filter((e) => text.includes(e.label)).slice(0, 3);
  const nodeCount = all.filter((e) => e.type === 'node' && e.side !== 'utility').length;
  const lookCount = all.filter(e => e.type === 'recipe' && recipePresentation(e.recipe).type === 'look').length;
  const blockRecipeCount = all.filter(e => e.type === 'recipe' && recipePresentation(e.recipe).type === 'block-recipe').length;
  const selectedRecipe = selected?.type === 'recipe' ? recipePresentation(selected.recipe) : null;

  return (
    <aside ref={panel} className={'fxpanel fxbrowser fxgallery' + (open ? ' open' : '')} inert={!open} aria-hidden={!open} aria-label="Effect browser">
      <div className="fh"><b>Effects</b><span className="dim" style={{ fontSize: 10 }}>{block ? `adding to Block ${blockIndex + 1}` : 'no block selected'}</span><button className={'ghostbtn thumbtoggle' + (thumbs ? ' act' : '')} aria-pressed={thumbs} onClick={() => setSettings((x) => void (x.liveThumbs = !x.liveThumbs))} title={thumbs ? 'Live previews on: each effect is drawn on the selected block. Click for text only.' : 'Live previews off. Click to draw each effect on the selected block.'}>◧ previews</button><button className="x" onClick={() => setUi({ fxPanel: false })} title="Close (Esc)">✕</button></div>
      <div className="fxsearch"><input ref={search} placeholder="Search effects, looks or a feeling…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search effects" /></div>
      <LookImport onImported={() => { clearFilters(); setKind('looks'); }} />
      {(q || tab !== 'All' || kind !== 'all' || fams.length > 0 || utags.length > 0) && <div className="fxfilter-summary"><span>Filtered view</span><button className="linkbtn" onClick={clearFilters}>Clear all filters</button></div>}
      {draftNotice && <p className="fxdraft-notice" role="status">{draftNotice}</p>}
      {frozen && <p className="fxdraft-notice" role="status">This block is frozen. Unfreeze it to preview or add effects.</p>}
      <div className="fxkinds" role="group" aria-label="Show">
        {([['all', 'All'], ['looks', 'Looks & recipes'], ['operators', 'Operators']] as const).map(([k, label]) => (
          <button key={k} aria-pressed={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}
            title={k === 'looks' ? 'Looks add an effect graph; block recipes change the timeline. Built-in and project entries.' : k === 'operators' ? 'Single effect nodes and graph utilities' : 'Effects, graph Looks and block recipes'}>{label}</button>
        ))}
      </div>
      <div className="fxtabs" role="tablist" aria-label="Looks">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} style={{ borderBottomColor: LOOK_COLOUR[t as LookCategory] }} onClick={() => setTab(t)}>{t === RECIPE_TAB ? 'Looks & recipes' : t}</button>
        ))}
      </div>
      <details className="fxgallery-filters"><summary>Families{fams.length > 0 ? ` · ${fams.length} selected` : ''}</summary><div className="fxfacets" aria-label="Families">
        {EFFECT_FAMILIES.map((f) => {
          const on = fams.includes(f);
          return (
            <button key={f} aria-pressed={on} className={on ? 'on' : ''} title={`Only ${f} effects (several families: any of them)`} onClick={() => setFams(on ? fams.filter((x) => x !== f) : [...fams, f])}>
              {f}
            </button>
          );
        })}
        {!!fams.length && <button className="clear" onClick={() => setFams([])}>clear</button>}
      </div>
      </details>
      {allTags.length > 0 && (
        <div className="fxfacets usertags" aria-label="Your tags">
          {allTags.map((t) => {
            const on = utags.includes(t);
            return <button key={t} aria-pressed={on} className={on ? 'on' : ''} title={`Only effects you tagged “${t}”`} onClick={() => setUtags(on ? utags.filter((x) => x !== t) : [...utags, t])}>#{t}</button>;
          })}
          {utags.some((t) => allTags.includes(t)) && <button className="clear" onClick={() => setUtags([])}>clear</button>}
        </div>
      )}
      <div className="fxlist" role="listbox" aria-label="Effects">
        {groups.map((g) => (
          <section key={`${g.cat}/${g.sub}`} className="fxgrp">
            <div className="fxgroup"><i aria-hidden="true" style={{ background: LOOK_COLOUR[g.cat as LookCategory] }} />{g.cat === MATCHES ? <>Best matches for “{q.trim()}”</> : g.sub === RECIPE_TAB ? <>{g.cat === RECIPE_TAB ? recipeGroupLabel(g.items.flatMap(e => e.type === 'recipe' ? [e.recipe] : [])) : `${g.cat} · ${recipeGroupLabel(g.items.flatMap(e => e.type === 'recipe' ? [e.recipe] : [])).toLowerCase()}`}</> : <>{tab === 'All' || q ? `${g.cat} · ` : ''}{g.sub}</>}<span>{g.items.length}</span></div>
            <div className="fxgallery-grid">{g.items.map((e) => {
              const key = `${g.cat}/${g.sub}|${e.id}`;
              const on = selRow === key;
              const presentation = e.type === 'recipe' ? recipePresentation(e.recipe) : null;
              return (
                <div key={e.id} data-row={key} role="option" tabIndex={on ? 0 : -1} aria-selected={on} title={e.type === 'recipe' ? e.recipe.does : e.explain.does} className={'op' + (on ? ' sel' : '')} onClick={(ev) => {
                  if (ev.shiftKey) { const a = on && draft ? auditionDraft(draft) : block && auditionOf(e, block.id); if (a) toggleShortlist(a); return; }
                  setSelKey(key);
                  ev.currentTarget.focus({ preventScroll: true });
                }} onDoubleClick={ev => { if (!(ev.target as Element).closest('input, button, select, textarea, [role="slider"]')) add(e); }}>
                  {thumbs && block && (e.type === 'recipe' ? e.recipe.kinds.length > 0 : e.side !== 'utility') ? <Thumb blockId={block.id} kinds={e.type === 'recipe' ? e.recipe.kinds : [e.id]} params={e.type === 'recipe' ? e.recipe.params : undefined} lookId={e.type === 'recipe' ? e.recipe.lookId : undefined} bitstream={e.type === 'recipe' ? e.recipe.kinds.some((k) => k.startsWith('mosh.')) : e.side === 'bitstream'} edge={e.type === 'node' ? SIDE[e.side].colour : 'var(--txt-3)'} /> : <div className="fxgallery-placeholder"><span aria-hidden="true">{e.type === 'recipe' ? '▧' : e.side === 'utility' ? '⌘' : '◧'}</span><small>{e.type === 'node' && e.side === 'utility' ? 'Graph utility' : presentation?.type === 'block-recipe' ? presentation.placeholder : !block ? 'Select a block to preview' : !thumbs ? 'Previews off' : presentation?.placeholder ?? 'No preview'}</small></div>}
                  <div className="oc">
                    <div className="on"><span className="nm">{e.label}</span>{shortlist.some((x) => x.id === e.id) && <span className="listed" title="On the shortlist (Shift-click to take it off)">◆</span>}<button className={'fav' + (favs.includes(e.id) ? ' on' : '')} aria-pressed={favs.includes(e.id)} aria-label={`Favourite ${e.label}`} title={favs.includes(e.id) ? 'A favourite: click to remove' : 'Add to Favourites'} onClick={(ev) => { ev.stopPropagation(); toggleFav(e.id); }}>{favs.includes(e.id) ? '♥' : '♡'}</button><span className="side" title={e.type === 'recipe' ? presentation!.help : SIDE[e.side].tip}>{e.type === 'recipe' ? presentation!.badge : SIDE[e.side].tag}</span></div>
                    {g.cat === MATCHES && <div className="lk">{e.type === 'recipe' ? `${e.recipe.look} · ${presentation!.label.toLowerCase()}` : `${e.looks[0].cat} · ${e.looks[0].sub}`}</div>}

                  </div>
                </div>
              );
            })}</div>
          </section>
        ))}
        {!groups.length && tab === FAV_TAB && !q && !favs.length && <Empty icon="♡" title="No favourites yet" cta={{ label: 'Show everything', run: clearFilters }}>Click ♡ on any effect or look to keep it here. Favourites are saved with your settings.</Empty>}
        {!groups.length && !(tab === FAV_TAB && !q && !favs.length) && <Empty icon="⌕" title={q ? `Nothing matches “${q}”` : 'Nothing in this view'} cta={{ label: 'Show everything', run: clearFilters }}>Search reads names, what each effect does and when to use it.</Empty>}
      </div>
      {selected && selectionVisible && <section key={selected.id} className="fxgallery-detail" aria-label={`Tune ${selected.label}`}>
        <div className="fxgallery-detail-head"><b>{selected.label}</b><span>{selected.type === 'recipe' ? selectedRecipe!.label : SIDE[selected.side].tag.toLowerCase()}</span></div>
        <div className="fxgallery-detail-body" onKeyDown={ev => { if (ev.key !== 'Escape') ev.stopPropagation(); }}>
          <div className="ob">{selected.type === 'recipe' ? selected.recipe.does : selected.explain.does}</div>
          {draft?.entryId === selected.id && selectedRecipe?.type !== 'block-recipe' && <DraftControls draft={draft} onChange={setDraft} onReset={() => setDraft(createDraft(selected))} />}
          {selected.type === 'node' && (
            <details className="fxguidance"><summary>How to use · source tips & limits</summary><dl className="explain">
              <dt>Use when</dt><dd>{selected.explain.useWhen}</dd>
              <dt>Works best with</dt><dd>{selected.explain.worksWith}</dd>
              <dt>Watch out</dt><dd>{selected.explain.watchOut}</dd>
              <dt>Try next</dt><dd>{selected.explain.tryNext}<span className="trylinks">{tryLinks(selected.explain.tryNext).map((t) => <button key={t.id} className="trylink" onClick={(ev) => { ev.stopPropagation(); selectId(t.id); }}>→ {t.label}</button>)}</span></dd>
            </dl></details>
          )}
          {selected.type === 'recipe' && selected.recipe.lookId && <OwnLookRow id={selected.recipe.lookId} name={selected.label} />}
          {selected.type === 'recipe' && <details className="fxguidance"><summary>{selectedRecipe!.about}</summary><div className="explain chain"><p>{selectedRecipe!.help}</p>{selected.recipe.kinds.length ? <>{selected.recipe.lookId && 'Contains: '}{selected.recipe.kinds.map((k) => defOf(k)?.label ?? k).join(selected.recipe.lookId ? ', ' : ' → ')}</> : 'Picture → Motion: the previous picture follows this clip’s motion.'}{selected.recipe.how && <div className="how">{selected.recipe.how}</div>}</div></details>}
          <TagEditor id={selected.id} tags={tagMap[selected.id] ?? []} />
            <div className="opacts">
              <button className="add" disabled={!block || frozen} onClick={(ev) => { ev.stopPropagation(); add(selected); }} title={block ? selectedRecipe?.type === 'block-recipe' ? selectedRecipe.help : `Add these settings to Block ${blockIndex + 1} (Enter from the search field)` : 'Select a block on the arrangement first'}>{selected.type === 'node' && selected.side === 'utility' ? 'Place in graph' : selectedRecipe ? block ? selectedRecipe.action(blockIndex + 1) : 'Apply' : `＋ Add${block ? ` to Block ${blockIndex + 1}` : ''}`}</button>
              <button className="ghostbtn" onClick={ev => { ev.stopPropagation(); cancelDraft(); }}>Cancel</button>
            </div>
        </div>
      </section>}
      <div className="fxfoot">{nodeCount} effects · {lookCount} looks{blockRecipeCount > 0 && <> · {blockRecipeCount} block {blockRecipeCount === 1 ? 'recipe' : 'recipes'}</>} · {new Set(shown.map((e) => e.id)).size} shown · Shift-click to shortlist</div>
    </aside>
  );
}
