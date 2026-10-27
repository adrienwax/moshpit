// L26 QoL: a toast for transient confirmations, an inline banner for actionable errors (with the
// suggested fix), a modal for destructive confirms, empty/loading states inside panes, and one
// tooltip engine for every control. Errors always arrive as MoshpitError — never a raw stack.
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ERRORS, MoshpitError, asMoshpitError, type ErrorCode, type MoshpitErrorJSON } from '@moshpit/engine';
import { createStore, useStore } from '../state/store';
import { HelpTracking } from './InfoPane';
import { copyNotificationDetails, notificationDetails, notificationText, recordNotification } from './notifications';

/**
 * Any thrown value → MoshpitError. Errors from the render worker cross the MessagePort as plain
 * MoshpitErrorJSON; a catalogued code is rebuilt as itself (message + fix intact) instead of
 * collapsing to INTERNAL. Unknown shapes still wrap as INTERNAL.
 */
export function asError(e: unknown): MoshpitError {
  if (e instanceof MoshpitError) return e;
  const j = e as Partial<MoshpitErrorJSON> | null;
  if (j && typeof j === 'object' && typeof j.code === 'string' && j.code in ERRORS) {
    return new MoshpitError(j.code as ErrorCode, (j.context as Record<string, unknown>) ?? {}, j.cause, j.humanMessage);
  }
  return asMoshpitError(e);
}

// ---------- toasts ----------

export interface ToastItem {
  id: number;
  msg: ReactNode;
  kind: 'info' | 'ok' | 'warn' | 'err';
  action?: { label: string; run: () => void; dismissOnRun?: boolean };
  copyFeedback?: string;
  ms: number;
  /** A new toast with the same tag replaces the old one (Ctrl+Z held down shows one line, not a stack). */
  tag?: string;
}

const toasts = createStore<ToastItem[]>([]);
let tid = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const dismiss = (id: number) => {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.set((s) => s.filter((x) => x.id !== id));
};
const arm = (t: ToastItem) => timers.set(t.id, setTimeout(() => dismiss(t.id), t.ms));

export function toast(msg: ReactNode, opts: Partial<Omit<ToastItem, 'id' | 'msg'>> & { title?: string; details?: string } = {}) {
  // Errors stay long enough to read and act on; confirmations get out of the way.
  const ms = opts.kind === 'err' ? 9000 : opts.action ? 6000 : 2600;
  const t: ToastItem = { id: ++tid, msg, kind: 'info', ms, ...opts };
  const text = notificationText(msg) || 'Notification';
  recordNotification({ title: opts.title ?? text, details: opts.details ?? text, kind: t.kind });
  if (t.tag) toasts.get().filter((x) => x.tag === t.tag).forEach((x) => dismiss(x.id));
  toasts.get().slice(0, -2).forEach((x) => dismiss(x.id)); // at most three on screen
  toasts.set((s) => [...s, t]);
  arm(t);
}

/** Copy feedback belongs to this toast, not to a new error in notification history. */
function errorCopyAction(details: string): NonNullable<ToastItem['action']> {
  const action: NonNullable<ToastItem['action']> = {
    label: 'Copy details', dismissOnRun: false,
    run: () => { void copyNotificationDetails(details).then(copied => {
      toasts.set(items => items.map(item => {
        if (item.action?.run !== action.run) return item;
        const updated = { ...item, copyFeedback: copied ? 'Copied' : 'Could not copy. Open Notifications to select the details manually.' };
        clearTimeout(timers.get(item.id));
        arm(updated);
        return updated;
      }));
    }); },
  };
  return action;
}

/** Any thrown value → a structured error toast: what happened + the fix, plus "copy details". */
export function toastError(e: unknown, action?: ToastItem['action']) {
  if ((e as Error)?.name === 'AbortError') return;
  const err: MoshpitError = asError(e);
  console.warn('[moshpit]', err.toJSON());
  const details = notificationDetails(err.toJSON());
  toast(
    <>
      <b>{err.humanMessage}</b> <span className="tfix">{err.suggestedFix}</span>
    </>,
    {
      title: err.humanMessage,
      details,
      kind: err.severity === 'info' ? 'info' : err.severity === 'warning' ? 'warn' : 'err',
      action: action ?? errorCopyAction(details),
    },
  );
}

// ---------- confirm ----------

export interface Choice<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger' | 'ghost';
}
interface ChooseReq {
  title: string;
  body: ReactNode;
  icon: string;
  choices: Choice<unknown>[];
  /** Index of the safe choice: focused first, and what Esc / a backdrop click picks. */
  safe: number;
  resolve: (v: unknown) => void;
}
const confirmStore = createStore<ChooseReq | null>(null);

/**
 * A modal choice (Save / Don't save / Cancel, Recover / Discard…). Focus starts on the safe
 * choice, Tab cycles inside, Esc and the backdrop pick the safe choice.
 */
export function choose<T>(title: string, body: ReactNode, choices: Choice<T>[], safe = choices.length - 1, icon = '⚠'): Promise<T> {
  return new Promise((resolve) => confirmStore.set({ title, body, icon, choices: choices as Choice<unknown>[], safe, resolve: resolve as (v: unknown) => void }));
}

/** Destructive-action confirmation. Resolves true only on the explicit button. */
export function confirmAction(title: string, body: ReactNode, ok = 'Delete'): Promise<boolean> {
  return choose(title, body, [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: ok, value: true, kind: 'danger' }], 0);
}

function ConfirmModal() {
  const req = useStore(confirmStore, (s) => s);
  const safeRef = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!req) return;
    const back = document.activeElement as HTMLElement | null;
    // Focus the safe choice: Enter on a fresh dialog never deletes or discards.
    safeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close(req.choices[req.safe].value);
      if (e.key !== 'Tab') return;
      const f = [...(sheet.current?.querySelectorAll<HTMLElement>('button') ?? [])];
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      back?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  if (!req) return null;
  const danger = req.choices.some((c) => c.kind === 'danger');
  const close = (v: unknown) => {
    confirmStore.set(null);
    req.resolve(v);
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close(req.choices[req.safe].value)}>
      <div className={'sheet sm' + (danger ? ' caution' : '')} role="alertdialog" aria-modal="true" aria-labelledby="cf-title" aria-describedby="cf-body" ref={sheet}>
        {/* Destructive choices get the striped CAUTION plate (visual language §12.5). */}
        {danger && <div className="cautionband" aria-hidden><span className="cautiontag">CAUTION</span></div>}
        <div className="sb">
          <div className="warnicon">{req.icon}</div>
          <h3 id="cf-title">{req.title}</h3>
          <div id="cf-body" className="cfbody">{req.body}</div>
        </div>
        <div className="sf2">
          <div className="spacer" />
          {req.choices.map((c, i) => (
            <button key={c.label} className={'btn ' + (c.kind ?? 'ghost')} ref={i === req.safe ? safeRef : undefined} onClick={() => close(c.value)}>{c.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const items = useStore(toasts, (s) => s);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={'toast show ' + t.kind}
          role={t.kind === 'err' ? 'alert' : 'status'}
          onMouseEnter={() => clearTimeout(timers.get(t.id))}
          onMouseLeave={() => arm(t)}
        >
          <span className="ticon" aria-hidden>{t.kind === 'ok' ? '✓' : t.kind === 'err' ? '⚠' : t.kind === 'warn' ? '!' : 'i'}</span>
          <span className="tmsg">{t.msg}{t.copyFeedback && <span className="tfix" role="status"> {t.copyFeedback}</span>}</span>
          {t.action && (
            <button
              className="tact"
              onClick={() => {
                if (t.action!.dismissOnRun !== false) dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="tx" title="Dismiss" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------- context menu (right-click) ----------

export interface MenuItem { label: string; run: () => void; disabled?: boolean; danger?: boolean; hint?: string }
const menuStore = createStore<{ x: number; y: number; items: (MenuItem | '-')[] } | null>(null);
/** Open a right-click menu at the pointer. '-' is a divider. */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: (MenuItem | '-')[]) {
  e.preventDefault();
  e.stopPropagation();
  menuStore.set({ x: e.clientX, y: e.clientY, items });
}
function ContextMenu() {
  const m = useStore(menuStore, (s) => s);
  useEffect(() => {
    if (!m) return;
    const close = () => menuStore.set(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', close);
    };
  }, [m]);
  if (!m) return null;
  const x = Math.min(m.x, window.innerWidth - 240), y = Math.min(m.y, window.innerHeight - 28 * m.items.length - 8);
  return (
    <div className="ctxmenu" role="menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {m.items.map((it, i) =>
        it === '-' ? <div key={i} className="ctxsep" /> : (
          <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} title={it.hint} onClick={() => (menuStore.set(null), it.run())}>{it.label}</button>
        ),
      )}
    </div>
  );
}

export function QolLayer() {
  return (
    <>
      <HelpTracking />
      <Toasts />
      <ConfirmModal />
      <ContextMenu />
    </>
  );
}

// ---------- in-pane states ----------

export function Banner({ kind, icon, children, action, onDismiss }: { kind: 'err' | 'warn' | 'ok'; icon?: string; children: ReactNode; action?: { label: string; run: () => void }; onDismiss?: () => void }) {
  return (
    <div className={'banner ' + kind} role={kind === 'err' ? 'alert' : 'status'}>
      <span className="bic">{icon ?? (kind === 'ok' ? '✓' : '⚠')}</span>
      <div className="bmsg">{children}</div>
      {action && <button className="bact" onClick={action.run}>{action.label}</button>}
      {onDismiss && <button className="bx" title="Dismiss" onClick={onDismiss}>✕</button>}
    </div>
  );
}

/** A MoshpitError as an inline banner: message, fix, optional fix action. */
export function ErrorBanner({ error, action, onDismiss }: { error: unknown; action?: { label: string; run: () => void }; onDismiss?: () => void }) {
  const e = asError(error);
  return (
    <Banner kind={e.severity === 'error' || e.severity === 'fatal' ? 'err' : 'warn'} action={action} onDismiss={onDismiss}>
      <b>{e.humanMessage}</b> {e.suggestedFix}
    </Banner>
  );
}

export function Empty({ icon, title, children, cta }: { icon: string; title: string; children?: ReactNode; cta?: { label: string; run: () => void } }) {
  return (
    <div className="emptystate">
      <div className="big" aria-hidden>{icon}</div>
      <div className="es-t">{title}</div>
      {children && <div className="es-d">{children}</div>}
      {cta && <button className="es-cta" onClick={cta.run}>{cta.label}</button>}
    </div>
  );
}

export function Loading({ children, delay = 200 }: { children: ReactNode; delay?: number }) {
  const [show, setShow] = useState(delay === 0);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  if (!show) return <div className="loadingstate" aria-busy="true" />;
  return (
    <div className="loadingstate" role="status">
      <div className="spinner" aria-hidden><i /><i /><i /><i /></div>
      <div>{children}</div>
    </div>
  );
}

// ---------- containment ----------

/** One pane failing renders its own error state; the rest of the workspace keeps working. */
export class PaneBoundary extends Component<{ name: string; children: ReactNode }, { error: MoshpitError | null }> {
  override state: { error: MoshpitError | null } = { error: null };
  static getDerivedStateFromError(e: unknown) {
    return { error: asError(e) };
  }
  override componentDidCatch(e: unknown, info: ErrorInfo) {
    console.warn('[moshpit] pane crashed:', this.props.name, asError(e).toJSON(), info.componentStack);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 12 }}>
        <Banner kind="err" action={{ label: 'Reload pane', run: () => this.setState({ error: null }) }}>
          <b>The {this.props.name} pane stopped working.</b> Your project is unchanged. {error.code === 'INTERNAL' ? 'Reload the pane; if it happens again, copy the details for a bug report.' : error.suggestedFix}
        </Banner>
        <button className="linkbtn" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(error.toJSON(), null, 2))}>Copy error details</button>
      </div>
    );
  }
}

/** Nothing reaches the user as a raw stack: uncaught errors and rejections become toasts. */
export function installGlobalErrorHandlers() {
  window.addEventListener('error', (e) => toastError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => toastError(e.reason));
}
