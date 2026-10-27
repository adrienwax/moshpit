// Phase 2.2: the bar under the Program monitor while an effect is auditioned. Apply commits it (one
// undo step); ▶ 2 s loops the two seconds from the playhead; the shortlist (Shift-click in the
// browser) switches between candidates on the same block; ✕ ends the audition, nothing changed.
import { useEffect, useState } from 'react';
import { activeBlock, applyTrialGraph, blockById, getDoc, isFrozen, selectNode, undoAction, useProject } from '../state/project';
import { auditionGraph, endAudition, prepareAudition, startAudition, toggleShortlist } from '../state/audition';
import { setUi, uiStore, useUi, type Audition } from '../state/ui';
import { fpsValue } from '../lib/time';
import { blocksShortcutTarget } from '../lib/keyboard';
import { toast, toastError } from '../qol/qol';

export function applyAudition(a: Audition): boolean {
  const doc = getDoc();
  const n = doc.timeline.blocks.findIndex((b) => b.id === a.blockId) + 1;
  const block = blockById(doc, a.blockId as never);
  if (!block || activeBlock(doc)?.id !== block.id || isFrozen(doc, { kind: 'block', blockId: block.id })) {
    endAudition();
    toast('Preview ended: select an unfrozen block and audition again before applying.', { kind: 'warn' });
    return false;
  }
  const before = new Set(block.graph.nodes.map(node => node.id));
  try {
    const staged = prepareAudition(a);
    const graph = staged && auditionGraph(staged);
    if (!staged?.candidate || !graph || !applyTrialGraph(staged.candidate.base, graph, `Applied ${a.label} to block`)) {
      endAudition();
      toast('This preview is no longer current. Choose the effect again before applying.', { kind: 'warn' });
      return false;
    }
    const added = blockById(getDoc(), block.id)?.graph.nodes.filter(node => !before.has(node.id));
    const focus = added?.find(node => node.kind === 'group.container') ?? added?.[added.length - 1];
    if (focus) selectNode(block.id, focus.id);
    toast(`${a.kinds.length > 1 ? 'Applied' : 'Added'} ${a.label} to Block ${n}`, { kind: 'ok', action: undoAction() });
    endAudition();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export function AuditionBar({ a }: { a: Audition }) {
  const shortlist = useUi((s) => s.shortlist);
  const fps = useProject((d) => d.settings.fps);
  const n = useProject((d) => d.timeline.blocks.findIndex((b) => b.id === a.blockId) + 1);
  const [loop, setLoop] = useState(false);
  const wipe = useUi((s) => s.wipe);
  const reveal = useUi((s) => s.reveal);
  // Phase 2.6: hold \ to see the original (Space stays play / pause, which the 2 s loop uses).
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === '\\' && !e.repeat && !e.defaultPrevented && !e.isComposing && !blocksShortcutTarget(e.target) && !document.querySelector('[role="alertdialog"]')) setUi({ reveal: true }); };
    const up = (e: KeyboardEvent) => { if (e.key === '\\') setUi({ reveal: false }); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); setUi({ reveal: false }); };
  }, []);
  // ▶ 2 s: play from here and jump back every two seconds, until stopped or the audition ends.
  useEffect(() => {
    if (!loop) return;
    const from = uiStore.get().playhead, to = from + Math.round(2 * fpsValue(fps));
    setUi({ playing: true });
    const off = uiStore.subscribe(() => { const p = uiStore.get().playhead; if (p >= to || p < from) setUi({ playhead: from }); });
    return () => { off(); setUi({ playing: false, playhead: from }); };
  }, [loop, fps]);
  return (
    <div className="auditionbar" role="region" aria-label="Audition">
      <span className="atag">AUDITION</span>
      <span className="alabel"><b>{a.label}</b> on Block {n} · the project is unchanged</span>
      <button className={'ghostbtn' + (loop ? ' act' : '')} aria-pressed={loop} onClick={() => setLoop(!loop)} title="Loop the two seconds from the playhead">{loop ? '◼ stop' : '▶ 2 s'}</button>
      <button className={'ghostbtn' + (reveal ? ' act' : '')} onPointerDown={() => setUi({ reveal: true })} onPointerUp={() => setUi({ reveal: false })} onPointerLeave={() => reveal && setUi({ reveal: false })} title="Hold to see the original (or hold the \ key)">◐ Original</button>
      <button className={'ghostbtn' + (wipe !== undefined ? ' act' : '')} aria-pressed={wipe !== undefined} onClick={() => setUi({ wipe: wipe === undefined ? 0.5 : undefined })} title="Wipe: the original on the left, the audition on the right; drag the line">⇹ Wipe</button>
      <button className="pop" onClick={() => applyAudition(a)} title={`Add to Block ${n}: one undo step`}>Apply</button>
      <button className="ghostbtn" onClick={endAudition} title="End the audition (Esc in the browser): nothing is added">✕</button>
      {shortlist.length > 0 && (
        <div className="shortlist" aria-label="Shortlist">
          {shortlist.map((c) => (
            <span key={c.id} className={'chip' + (c.id === a.id ? ' on' : '')}>
              <button onClick={() => startAudition({ ...c, blockId: a.blockId })} title={`Audition ${c.label} on Block ${n}`}>{c.label}</button>
              <button className="x" onClick={() => toggleShortlist(c)} title="Take off the shortlist">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
