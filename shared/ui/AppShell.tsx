import type { CSSProperties, ReactNode } from 'react';
import './shell.css';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

export interface SharedAppShellProps {
  header: ReactNode;
  toolbar?: ReactNode;
  navigation?: ReactNode;
  inspector?: ReactNode;
  children: ReactNode;
  overlays?: ReactNode;
  className?: string;
  contentClassName?: string;
  bodyClassName?: string;
  style?: CSSProperties;
}

/** Layout slots only: applications retain routing, persistence and overlay ownership. */
export function SharedAppShell({ header, toolbar, navigation, inspector, children, overlays, className, contentClassName, bodyClassName, style }: SharedAppShellProps) {
  const content = <main className={classes(contentClassName, 'es-shell__content')}>{children}</main>;
  const hasNavigation = navigation != null && typeof navigation !== 'boolean';
  const hasInspector = inspector != null && typeof inspector !== 'boolean';
  const sidebars = hasNavigation || hasInspector;
  return <div className={classes(className, 'es-shell')} style={style}>
    {header}
    {toolbar}
    {sidebars ? <div className={classes(bodyClassName, 'es-shell__body')}>
      {hasNavigation && <aside className="es-shell__navigation">{navigation}</aside>}
      {content}
      {hasInspector && <aside className="es-shell__inspector">{inspector}</aside>}
    </div> : content}
    {overlays}
  </div>;
}

export interface SharedPaneProps {
  title: string;
  header: ReactNode;
  beforeHeader?: ReactNode;
  children?: ReactNode;
  collapsed?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
}

/** Header is a complete caller-owned node, preserving docking and tab DOM. */
export function SharedPane({ title, header, beforeHeader, children, collapsed, className, bodyClassName, style }: SharedPaneProps) {
  return <section className={classes(className, 'es-pane')} style={style} aria-label={title}>
    {beforeHeader}
    {header}
    {!collapsed && <div className={classes(bodyClassName, 'es-pane__body')}>{children}</div>}
  </section>;
}
